"""SongsService — the library behind ``/api/songs`` (CONTRACTS.md §9).

Owns no port and no clock of its own. It reads and writes ``songs/`` through
the store, runs imports on worker threads (Claude takes a while to read a
page, and two reads run per import), adds phrase cards to review on request
(the built-in scheduler or Anki — the review seam, §10), and listens to the
trainer firehose for the ``done`` of a song drill to write a receipt.
Everything it announces goes out of one ``publish(event)``.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Callable

from music.songs import importer
from music.songs.chart import (
    ChartError,
    Song,
    format_song,
    parse_song,
    phrases,
    replace_cell,
    run_steps,
    song_dict,
)
from music.songs.decks import (
    PREFIX,
    SongDecks,
    anki_subdeck,
    chord_items,
    deck_names_for,
    phrase_items,
    phrase_key,
    phrase_specs,
    play_item,
    theme,
)
from music.songs.store import PAGE_MIMES, REPO_ROOT, SongStore
from music.srs import Review, ReviewUnavailable
from music.theory.simplify import DIALS

MAX_JOBS = 2                  # imports at once (each runs two Claude reads)
RUNS_SHOWN = 50


def default_runs_path() -> Path:
    return Path(os.environ.get("MUSIC_SONGS_RUNS", REPO_ROOT / "sessions" / "songs" / "runs.jsonl"))


class SongsService:
    def __init__(self, store: SongStore | None = None,
                 publish: Callable[[dict], None] | None = None,
                 review: Review | None = None, llm: importer.LLM | None = None,
                 runs_path: Path | str | None = None,
                 fetch: Callable[[str], importer.Upload] | None = None) -> None:
        self.store = store or SongStore()
        self.publish = publish or (lambda event: None)
        self.decks = SongDecks(self.store)
        self.runs_path = Path(runs_path) if runs_path is not None else default_runs_path()
        # The server hands in the trainer's Review so both see one scheduler.
        self.review = review or Review()
        self.review.add_source(self.decks)
        #: Called after cards are added (the server points it at the trainer's due cache).
        self.on_review_changed: Callable[[], None] = lambda: None
        self._llm = llm
        self._fetch = fetch
        self._jobs: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._slots = threading.Semaphore(MAX_JOBS)

    # ── reading ───────────────────────────────────────────────────────────
    def summaries(self) -> list[dict]:
        out = []
        for song_id in self.store.ids():
            try:
                song, problems = self.store.load(song_id)
            except ChartError as e:
                out.append({"id": song_id, "title": song_id, "composer": "", "key": "",
                            "time": "", "checked": "", "phrases": 0, "chords": 0,
                            "problems": len(e.errors), "flags": 0, "broken": True,
                            "updated": self.store.updated(song_id)})
                continue
            d = song_dict(song, problems)
            out.append({"id": song_id, "title": song.title, "composer": song.composer,
                        "key": song.key, "time": song.time, "checked": song.checked,
                        "phrases": len(d["phrases"]), "chords": len(d["chords"]),
                        "problems": len(problems),
                        "flags": len(self.store.live_flags(song_id, song)),
                        "updated": self.store.updated(song_id)})
        return sorted(out, key=lambda s: s["title"].lower())

    def song(self, song_id: str) -> dict:
        """Song JSON v1. KeyError: no such song; ChartError: the file is broken."""
        song, problems = self.store.load(song_id)
        return self._json(song_id, song, problems)

    def _json(self, song_id: str, song: Song, problems: list) -> dict:
        d = song_dict(song, problems)
        page = self.store.page(song_id)
        record = self.store.import_record(song_id)
        d.update({
            "id": song_id,
            "page": None if page is None else {
                "url": f"/api/songs/{song_id}/page",
                "mime": PAGE_MIMES.get(page.suffix.lower(), "application/octet-stream"),
                "name": record.get("name") or page.name},
            "reads": len(self.store.reads(song_id)),
            "flags": self.store.live_flags(song_id, song),
            "decks": deck_names_for(song_id, song),
            "anki": {"subdeck": anki_subdeck(song.title), "theme": "anki:" + theme(song_id)},
            "review": self._review_block(song_id),
            "updated": self.store.updated(song_id),
        })
        return d

    def text(self, song_id: str) -> str:
        return self.store.text(song_id)

    # ── writing ───────────────────────────────────────────────────────────
    def _changed(self, song_id: str) -> None:
        self.publish({"type": "songs", "event": "changed", "song": song_id})

    def _sync_review(self, song_id: str, song: Song) -> None:
        """A song in review keeps its cards true to the chart: an edit rewrites them.

        Best-effort: the chart is already saved, so a closed Anki or a full disk skips
        the sync — the next edit (or Add to review) catches up.
        """
        backend = self.review.active()
        try:
            if not backend.available() or not backend.counts().get(theme(song_id), {}).get("cards"):
                return
            result = backend.add(theme(song_id), phrase_specs(song), key_of=phrase_key)
        except OSError:
            return
        if result.get("added") or result.get("updated"):
            self.on_review_changed()

    def save_text(self, song_id: str, text: str) -> dict:
        """Replace the whole chart. ChartError (with .errors) leaves the file untouched."""
        if not self.store.exists(song_id):
            raise KeyError(song_id)
        song, problems = parse_song(text)
        self.store.write_text(song_id, text if text.endswith("\n") else text + "\n")
        self._sync_review(song_id, song)
        self._changed(song_id)
        return self._json(song_id, song, problems)

    def _rewrite(self, song_id: str, song: Song) -> dict:
        text = format_song(song)
        song, problems = parse_song(text)        # re-read: % and held bars re-resolve
        self.store.write_text(song_id, text)
        self._sync_review(song_id, song)
        self._changed(song_id)
        return self._json(song_id, song, problems)

    def save_bar(self, song_id: str, addr: str, cell: str) -> dict:
        """Replace one written bar. ValueError/ChartError: the cell is not a bar."""
        if "|" in cell or "\n" in cell:
            raise ValueError("one bar at a time — no | in a bar")
        song, _ = self.store.load(song_id)
        return self._rewrite(song_id, replace_cell(song, addr, cell))

    def patch(self, song_id: str, changes: dict) -> dict:
        song, _ = self.store.load(song_id)
        if "grade" in changes and changes["grade"] is not None:
            if changes["grade"] not in DIALS:
                raise ValueError(f"grade must be one of {', '.join(DIALS)}")
            song.grade = changes["grade"]
        if "checked" in changes and changes["checked"] is not None:
            song.checked = date.today().isoformat() if changes["checked"] else ""
            if changes["checked"]:
                self.store.accept_flags(song_id)   # "looks right" settles what was flagged
        for key in ("title", "key", "composer", "style"):
            if changes.get(key) is not None:
                value = " ".join(str(changes[key]).split())
                if key == "title" and not value:
                    raise ValueError("a song needs a title")
                setattr(song, key, value)
        if changes.get("form") is not None:
            form = tuple(t for t in str(changes["form"]).replace(",", " ").split() if t)
            missing = [label for label in form if song.section(label) is None]
            if missing:
                raise ValueError(f"form names [{missing[0]}], which is not in the chart")
            song.form = form
        return self._rewrite(song_id, song)

    def delete(self, song_id: str) -> None:
        self.store.trash(song_id)
        self._changed(song_id)

    # ── importing ─────────────────────────────────────────────────────────
    def _public(self, job: dict) -> dict:
        elapsed = (job["ended"] or time.monotonic()) - job["t0"]
        return {"job": job["job"], "stage": job["stage"], "message": job["message"],
                "song": job["song"], "error": job["error"], "origin": job["origin"],
                "elapsed_s": round(elapsed, 1), "done": job["ended"] is not None}

    def _stage(self, job: dict, stage: str, message: str = "") -> None:
        with self._lock:
            job["stage"], job["message"] = stage, message
            event = {"type": "songs", "event": "import", **self._public(job)}
        self.publish(event)

    def _new_job(self, origin: str, song_id: str | None = None) -> dict:
        job = {"job": uuid.uuid4().hex[:8], "stage": "queued", "message": "waiting",
               "song": song_id, "error": None, "origin": origin,
               "t0": time.monotonic(), "ended": None}
        with self._lock:
            self._jobs[job["job"]] = job
        self._stage(job, "queued", "waiting for a free reader")
        return job

    def _run(self, job: dict, produce: Callable[[], importer.Upload],
             song_id: str | None = None) -> None:
        with self._slots:
            try:
                upload = produce()

                def on_stage(stage: str, message: str) -> None:
                    if stage == "saved":           # announced below, with the song id
                        job["message"] = message
                    else:
                        self._stage(job, stage, message)

                new_id = importer.run_import(self.store, upload, llm=self._llm,
                                             song_id=song_id, on_stage=on_stage)
                with self._lock:
                    job["song"] = new_id
                    job["ended"] = time.monotonic()
                self._stage(job, "saved", job["message"])
                self._changed(new_id)
            except Exception as e:     # every failure ends the job visibly
                message = str(e) if isinstance(e, importer.ImportFailed) else f"{type(e).__name__}: {e}"
                with self._lock:
                    job["error"] = message
                    job["ended"] = time.monotonic()
                self._stage(job, "error", message)

    def _spawn(self, job: dict, produce, song_id: str | None = None) -> dict:
        thread = threading.Thread(target=self._run, args=(job, produce, song_id),
                                  name=f"song-import-{job['job']}", daemon=True)
        thread.start()
        return self._public(job)

    def import_bytes(self, data: bytes, name: str) -> dict:
        job = self._new_job(name or "upload")
        return self._spawn(job, lambda: importer.Upload(data, name or "upload", name or "upload"))

    def import_url(self, url: str) -> dict:
        job = self._new_job(url)
        fetch = self._fetch or (lambda u: importer.fetch_url(
            u, on_stage=lambda stage, message: self._stage(job, stage, message)))

        def produce() -> importer.Upload:
            self._stage(job, "fetch", f"downloading {url[:80]}")
            return fetch(url)

        return self._spawn(job, produce)

    def reread(self, song_id: str) -> dict:
        page = self.store.page(song_id)
        if page is None:
            raise ValueError("this song has no page to read")
        origin = self.store.import_record(song_id).get("origin") or page.name
        job = self._new_job(origin, song_id)
        data = page.read_bytes()
        return self._spawn(job, lambda: importer.Upload(data, page.name, origin), song_id)

    def jobs(self) -> list[dict]:
        with self._lock:
            return [self._public(j) for j in sorted(self._jobs.values(), key=lambda j: -j["t0"])]

    def job(self, job_id: str) -> dict:
        with self._lock:
            return self._public(self._jobs[job_id])

    # ── Anki ──────────────────────────────────────────────────────────────
    # ── review (CONTRACTS.md §10) ─────────────────────────────────────────
    def _review_block(self, song_id: str) -> dict:
        backend = self.review.active()
        available = backend.available()
        counts = backend.counts().get(theme(song_id), {}) if available else {}
        return {"theme": theme(song_id), "backend": backend.id, "label": backend.label,
                "available": available, "cards": counts.get("cards", 0),
                "due": counts.get("due", 0)}

    def seed(self, song_id: str) -> dict:
        """Add the song's phrase cards to review — whichever backend is chosen."""
        song, _ = self.store.load(song_id)
        backend = self.review.active()
        if not backend.available():
            raise ReviewUnavailable(f"{backend.label} is closed — open it, or pick Built-in "
                                    "in the 🧠 menu")
        result = backend.add(theme(song_id), phrase_specs(song), key_of=phrase_key)
        self.on_review_changed()
        self._changed(song_id)
        deck = anki_subdeck(song.title) if backend.id == "anki" else theme(song_id)
        return {"backend": backend.id, "deck": deck, **result}

    # ── receipts (a firehose listener) ────────────────────────────────────
    def on_event(self, event: dict) -> None:
        """Hub subscriber: a song drill's ``done`` becomes a receipt."""
        if event.get("type") != "done":
            return
        deck = str(event.get("deck") or "")
        name = deck
        for session in ("review:", "anki:"):              # review:song:<id> = phrase cards
            if deck.startswith(session + PREFIX):
                name = deck[len(session):]
        if not name.startswith(PREFIX):
            return
        parts = name[len(PREFIX):].split(":")
        song_id = parts[0]
        mode = parts[1] if len(parts) > 1 else "phrases"
        try:
            song, _ = self.store.load(song_id)
        except (KeyError, ChartError, OSError):
            return
        mode = "play" if mode == "run" else mode
        receipt = {"v": 1, "song": song_id, "deck": deck, "mode": mode,
                   "finished": datetime.now().isoformat(timespec="seconds"),
                   "stopped": bool(event.get("stopped")),
                   **(event.get("summary") or {}),
                   "misses": self._misses(song_id, song, mode, event.get("results") or [])}
        try:
            self.runs_path.parent.mkdir(parents=True, exist_ok=True)
            with self.runs_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(receipt, ensure_ascii=False) + "\n")
        except OSError:
            pass                       # a receipt is a nicety; the drill already happened
        self.publish({"type": "songs", "event": "receipt", "song": song_id, "receipt": receipt})

    def _misses(self, song_id: str, song: Song, mode: str, results: list[dict]) -> dict:
        misses: dict[str, int] = {}
        if mode == "chords":
            by_prompt = {i.prompt: i.chord.text for i in chord_items(song_id, song)}
            for r in results:
                wrong = sum(1 for a in r.get("attempts") or [] if not a.get("ok"))
                key = by_prompt.get(r.get("prompt"))
                if wrong and key:
                    misses[key] = misses.get(key, 0) + wrong
            return misses
        steps_by_prompt: dict[str, list] = {}
        for item, phrase in zip(phrase_items(song_id, song), phrases(song)):
            steps_by_prompt[item.prompt] = list(phrase.steps)
        if mode in ("play", "run"):
            for label in [None, *[s.label for s in song.sections]]:
                item = play_item(song_id, song, label)
                if item is not None:
                    steps_by_prompt[item.prompt] = run_steps(song, label)
        for r in results:
            steps = steps_by_prompt.get(r.get("prompt"))
            if not steps:
                continue
            at = 0
            for attempt in r.get("attempts") or []:
                if attempt.get("ok"):
                    at += 1
                elif at < len(steps):
                    addr = steps[at].addr
                    misses[addr] = misses.get(addr, 0) + 1
        return misses

    def runs(self, song_id: str) -> list[dict]:
        if not self.runs_path.is_file():
            return []
        out = []
        for line in self.runs_path.read_text(encoding="utf-8").splitlines():
            try:
                receipt = json.loads(line)
            except ValueError:
                continue
            if receipt.get("song") == song_id:
                out.append(receipt)
        return list(reversed(out))[:RUNS_SHOWN]
