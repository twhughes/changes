"""The static site's data — what the page carries instead of a server (CONTRACTS.md §12).

The static page (``tools/build_site.py`` → ``site/``) runs the cockpit's own front-end with
no Python behind it. Everything that needs the theory kernel is computed HERE, once, at build
time, and written as JSON under ``site/data/``: the views list, the Practice menu's groups,
every built-in deck as drill items, the review cards each seedable deck adds, and each demo
song's song JSON under all three dials with its chord / phrase / play-through items and its
phrase review cards. The browser runtime (``web/static/offline/``) reads these files and
never parses a chord.

An item's chords are written by text into one table per file — ``{text: {pcs, req, bass}}``:
the chord's pitch classes, the ones a voicing must contain (the unaltered 5th of a 4+-tone
chord is omittable, §7), and the expected lowest pitch class (slash bass, else root). That is
everything the JS matcher twin needs; ``tools/static_vectors.py`` proves it grades the same.

Layer: web (a composition root like ``server.py``) — it reads learn/, songs/, srs/, theory/.
"""

from __future__ import annotations

import dataclasses
import json
from datetime import datetime
from pathlib import Path

from music.learn.anki import SUBDECKS
from music.learn.decks import (
    DECK_GROUPS,
    DECK_INFO,
    MENU,
    builtin_decks,
    item_for_front,
    seed_fronts,
)
from music.learn.drill import DrillItem
from music.learn.grading import GRADE_POLICY
from music.songs.chart import (
    Song,
    format_song,
    parse_song,
    phrases,
    run_steps,
    slugify,
    song_dict,
)
from music.songs.decks import (
    anki_subdeck,
    chord_items,
    deck_names_for,
    phrase_items,
    phrase_specs,
    play_item,
    theme,
)
from music.srs.local import SRS_POLICY, LocalScheduler
from music.theory.chords import ChordSymbol
from music.theory.naming import _COMMONNESS, QUALITIES
from music.theory.simplify import DIALS

DATA_VERSION = 1

#: The page's one view (2026-10-04: "just midi hub + flashcards + sound engine").
#: Player (bundles on disk), S-1 (hardware) and Lessons (server-graded) need the local app.
STATIC_VIEWS: list[dict] = [
    {"id": "practice", "title": "Practice"},
]

DEFAULT_ITEM_DEBOUNCE = DrillItem.__dataclass_fields__["debounce_s"].default


# ── chords and items ────────────────────────────────────────────────────────
def chord_payload(chord: ChordSymbol) -> dict:
    """What the JS matcher needs of one chord: its pcs, the required pcs, the bass pc."""
    required = set(chord.pcs())
    if chord.fifth_omittable():
        required.discard((chord.root_pc + 7) % 12)
    return {"pcs": sorted(chord.pcs()), "req": sorted(required), "bass": chord.expected_bass_pc}


class ChordTable:
    """text → chord payload for one data file. A text that means two chords is a build error."""

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    def add(self, chord: ChordSymbol) -> str:
        payload = chord_payload(chord)
        known = self.rows.get(chord.text)
        if known is None:
            self.rows[chord.text] = payload
        elif known != payload:
            raise ValueError(f"chord text {chord.text!r} names two different chords")
        return chord.text


def item_payload(item: DrillItem, table: ChordTable) -> dict:
    """One DrillItem as the static runtime reads it (CONTRACTS.md §12)."""
    out: dict = {"prompt": item.prompt, "chord": table.add(item.chord),
                 "level": "pitch" if item.is_pitch else item.level.value}
    if item.chords:
        out["chords"] = [table.add(c) for c in item.chords]
    if item.pitches:
        out["pitches"] = list(item.pitches)
        out["clef"] = item.clef
        out["octave_exact"] = item.octave_exact
    if item.recall:
        out["recall"] = True
    if item.ref is not None:
        out["ref"] = item.ref
    if item.debounce_s != DEFAULT_ITEM_DEBOUNCE:
        out["debounce_s"] = item.debounce_s
    return out


# ── policies (Python owns the numbers; the page reads them) ─────────────────
def policies() -> dict:
    grade = {
        "speed_tiers": [[limit, tier] for limit, tier in GRADE_POLICY["speed_tiers"]],
        "slip_max_wrong": GRADE_POLICY["slip_max_wrong"],
        "slip_max_notes_off": GRADE_POLICY["slip_max_notes_off"],
        "rough_max_wrong": GRADE_POLICY["rough_max_wrong"],
        "ease": [[acc, speed, ease] for (acc, speed), ease in GRADE_POLICY["ease"].items()],
    }
    srs = {k: v for k, v in SRS_POLICY.items() if k != "ease_delta"}
    srs["ease_delta"] = {str(k): v for k, v in SRS_POLICY["ease_delta"].items()}
    return {"grade": grade, "srs": srs}


def naming_table() -> dict:
    """theory.naming's vocabulary, in its iteration order (ties sort stably on it)."""
    return {"qualities": [[q, sorted(ivs)] for q, ivs in QUALITIES.items()],
            "commonness": dict(_COMMONNESS)}


# ── built-in decks ──────────────────────────────────────────────────────────
def menu_groups(decks: dict[str, list[DrillItem]] | None = None) -> list[dict]:
    """The static half of GET /api/practice's groups (the runtime adds in_review / due)."""
    decks = decks if decks is not None else builtin_decks()
    groups = [{"id": gid, "title": title, "decks": []} for gid, title in DECK_GROUPS]
    by_group = {g["id"]: g for g in groups}
    for name in MENU:                                     # only what the menu offers (§11 v2)
        group, title, blurb = DECK_INFO[name]
        by_group[group]["decks"].append({
            "id": name, "title": title, "blurb": blurb, "cards": len(decks[name]),
            "seedable": name in SUBDECKS})
    return groups


def decks_data() -> dict:
    """Every built-in deck as items, each seedable deck's review cards, the Front decoder."""
    table = ChordTable()
    decks = {name: items for name, items in builtin_decks().items() if name in MENU}
    out_decks = {name: [item_payload(i, table) for i in items] for name, items in decks.items()}
    cards: dict[str, list[dict]] = {}
    fronts: dict[str, dict] = {}
    for name in (n for n in MENU if n in SUBDECKS):
        # seed_builtin's CardSpec(front, front, ""): the key IS the front.
        cards[name] = [{"key": f, "front": f, "back": ""} for f in seed_fronts(name)]
        for f in seed_fronts(name):
            item = item_for_front(f)
            if item is None:
                raise ValueError(f"seed front {f!r} does not decode")
            fronts[f] = item_payload(item, table)
    return {"v": DATA_VERSION, "chords": table.rows, "decks": out_decks,
            "seedable": [n for n in MENU if n in SUBDECKS], "cards": cards, "fronts": fronts}


# ── songs ───────────────────────────────────────────────────────────────────
def _dial_view(song_id: str, song: Song, problems: list, updated: str) -> dict:
    """One dial of one song: its song JSON (minus the live review block) and its items."""
    table = ChordTable()
    d = song_dict(song, problems)
    d.update({
        "id": song_id, "page": None, "reads": 0, "flags": [],
        "decks": deck_names_for(song_id, song),
        "anki": {"subdeck": anki_subdeck(song.title), "theme": "anki:" + theme(song_id)},
        "updated": updated,
    })
    labels = [s.label for s in song.sections]
    chords = chord_items(song_id, song)
    phrase_list = phrases(song)
    phrase_its = phrase_items(song_id, song)
    play: dict[str, dict] = {}
    play_addrs: dict[str, list[str]] = {}
    for label in [None, *labels]:
        item = play_item(song_id, song, label)
        if item is not None:
            play[label or ""] = item_payload(item, table)
            play_addrs[item.prompt] = [s.addr for s in run_steps(song, label)]
    return {
        "song": d,
        "summary": {"phrases": len(d["phrases"]), "chords": len(d["chords"]),
                    "problems": len(problems)},
        "labels": labels,
        "items": {
            "chords": [item_payload(i, table) for i in chords],
            "phrases": [{"section": p.section, "line": p.line, "volta": p.volta,
                         "item": item_payload(i, table)} for p, i in zip(phrase_list, phrase_its)],
            "play": play,
        },
        # SongsService._misses: which written bar (or chord name) a wrong attempt lands on.
        "miss": {
            "chords": {i.prompt: i.chord.text for i in chords},
            "phrases": {i.prompt: [s.addr for s in p.steps] for p, i in zip(phrase_list, phrase_its)},
            "play": play_addrs,
        },
        "cards": [{"key": s.key, "front": s.front, "back": s.back} for s in phrase_specs(song)],
        "chords": table.rows,
    }


def song_data(song_id: str, text: str, updated: str) -> dict:
    """A song under every dial — exactly what the server serves after PATCH {grade}."""
    base, base_problems = parse_song(text)
    dials = {}
    for dial in DIALS:
        if dial == base.grade:
            song, problems = base, base_problems
        else:                                   # SongsService.patch → _rewrite → re-read
            song, problems = parse_song(format_song(dataclasses.replace(base, grade=dial)))
        dials[dial] = _dial_view(song_id, song, problems, updated)
    return {"v": DATA_VERSION, "id": song_id, "title": base.title, "composer": base.composer,
            "key": base.key, "time": base.time, "checked": base.checked, "grade": base.grade,
            "updated": updated, "text": text, "dials": dials}


def song_ids(paths: list[Path]) -> list[tuple[str, Path, str]]:
    """(id, path, text) per song file: the id is the title's slug, a clash adds -2 (the store's rule)."""
    out: list[tuple[str, Path, str]] = []
    taken: set[str] = set()
    for path in sorted(paths):
        text = path.read_text(encoding="utf-8")
        song, _ = parse_song(text)
        base = slugify(song.title)
        song_id, n = base, 2
        while song_id in taken:
            song_id, n = f"{base}-{n}", n + 1
        taken.add(song_id)
        out.append((song_id, path, text))
    return out


def _mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")


def songs_data(song_files: list[Path]) -> tuple[list[dict], dict[str, dict]]:
    """(index rows, {id: song data}) for the given song text files."""
    index, by_id = [], {}
    for song_id, path, text in song_ids(song_files):
        data = song_data(song_id, text, _mtime_iso(path))
        by_id[song_id] = data
        index.append({"id": song_id, "title": data["title"], "file": f"songs/{song_id}.json"})
    index.sort(key=lambda row: row["title"].lower())
    return index, by_id


# ── the app file ────────────────────────────────────────────────────────────
def app_data(sound: dict) -> dict:
    return {
        "v": DATA_VERSION,
        "views": STATIC_VIEWS,
        "groups": menu_groups(),
        "policies": policies(),
        "naming": naming_table(),
        "review": {"id": LocalScheduler.id, "label": LocalScheduler.label, "note": LocalScheduler.note},
        "sound": sound,
    }


def write_data(out: Path, song_files: list[Path], sound: dict) -> list[str]:
    """Write ``out/{app,decks,songs}.json`` and ``out/songs/<id>.json``; returns the paths written."""
    out.mkdir(parents=True, exist_ok=True)
    written = []

    def dump(rel: str, payload) -> None:
        path = out / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        written.append(rel)

    dump("app.json", app_data(sound))
    dump("decks.json", decks_data())
    index, by_id = songs_data(song_files)
    dump("songs.json", index)
    for song_id, data in by_id.items():
        dump(f"songs/{song_id}.json", data)
    return written


__all__ = [
    "STATIC_VIEWS", "ChordTable", "app_data", "chord_payload", "decks_data", "item_payload",
    "menu_groups", "naming_table", "policies", "song_data", "song_ids", "songs_data", "write_data",
]
