"""Golden vectors for the static page's JS twin, generated from the Python authority.

    python tools/static_vectors.py [--out vectors.json] [--seed N]
    node music/web/static/offline/parity.check.mjs vectors.json

The static page (CONTRACTS.md §12) grades in the browser with a JavaScript twin of the chord
matcher, the drill engine, the grade policy, the SM-2 scheduler and the trainer service. Python
stays the authority: this script runs the real Python over many inputs and writes down what it
answered; ``offline/parity.check.mjs`` runs the twin on the very same inputs and must agree
with every case. ``tests/test_static_site.py`` regenerates the vectors on every run.

Families
  match     note sets × chords × levels → Verdict.to_dict()        (theory.match.match)
  pitches   note sets × targets × octave_exact                      (theory.match.match_pitches)
  naming    note sets → ranked names                                (theory.naming.name_notes)
  grading   attempts × latency × steps → grade                      (learn.grading.grade)
  fronts    phrase-card Fronts → (title, section, line, volta)      (songs.chart.parse_front)
  srs       SM-2 walks on a fake clock: add / answer / due / counts (srs.local.LocalScheduler)
  drill     timed note scripts → engine events: debounce, arming, progressions, misses, skips
  service   whole sessions through TrainerService + SongsService: shuffle off, requeue, streak,
            review sessions and top-ups, recall cards, the dial, receipts, held/note firehose

Every item a vector names is written in the page's own data format (web/static_data.py), so
the twin reads exactly what the page reads.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import random
import shutil
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from music.learn.decks import MENU, DeckRun, builtin_decks  # noqa: E402
from music.learn.drill import DrillEngine, DrillItem  # noqa: E402
from music.learn.grading import grade  # noqa: E402
from music.midio.events import MidiEvent  # noqa: E402
from music.midio.notes import NoteTracker  # noqa: E402
from music.songs.chart import parse_front  # noqa: E402
from music.songs.decks import chord_items, phrase_items, play_item  # noqa: E402
from music.songs.service import SongsService  # noqa: E402
from music.songs.store import SongStore  # noqa: E402
from music.srs import Review  # noqa: E402
from music.srs.base import CardSpec  # noqa: E402
from music.srs.local import LocalScheduler  # noqa: E402
from music.theory.chords import ChordSymbol, parse_chord  # noqa: E402
from music.theory.match import Level, match, match_pitches  # noqa: E402
from music.theory.naming import name_notes  # noqa: E402
from music.trainer import service as trainer_service  # noqa: E402
from music.trainer.service import TrainerService  # noqa: E402
from music.web import static_data as sd  # noqa: E402

DEMO_SONGS = ROOT / "demo-songs"
VECTORS_VERSION = 1
LEVELS = ("loose", "strict", "inversion", "voiced")
SRS_START = datetime(2026, 10, 4, 8, 0, 0)

# Real Book spellings and every quality family, on top of the decks' and songs' own chords.
EXTRA_CHORDS = (
    "C", "Cm", "Cdim", "Caug", "C5", "C6", "Cm6", "C7", "Cmaj7", "Cm7", "Cm7b5", "Cdim7",
    "CmMaj7", "Csus2", "Csus4", "C7sus4", "C9", "Cmaj9", "Cm9", "Cadd9", "C11", "C13", "C7b9",
    "C7#9", "C7b5", "C7#5", "C69", "C6/9", "Cm69", "Cm11", "Cm13", "Cmaj13", "C9sus4", "C13sus4",
    "C7alt", "F7alt", "Bb7(#11)", "A7b5(b9)", "E-9", "G7#5", "D-maj7", "C/E", "C7/Bb", "D-7/C",
    "F#m7b5", "Ebmaj7#11", "Db13b9", "C/Bb", "G/B", "Bo7", "F#ø7", "AbΔ7", "E-7b5", "B7b9",
    "G13", "Dm7/G", "F#7(b9,#9)", "Bb-6", "Eb6/9", "A7sus", "Gmaj7#11", "D7#9", "B♭maj7",
)


def r4(t: float) -> float:
    return round(t, 4)


def jsonable(value):
    """What the wire would carry: a JSON round trip (tuples → lists, keys → str)."""
    return json.loads(json.dumps(value, ensure_ascii=False))


# ── the data the page carries (and the twin reads here) ─────────────────────
def sound_stub() -> dict:
    return {"default": "samples", "samples": None,
            "drivers": [{"id": "samples", "label": "Sampled e-piano (browser)", "side": "browser",
                         "available": True, "note": ""}]}


def page_data() -> dict:
    files = sorted(DEMO_SONGS.glob("*.txt"))
    _, songs = sd.songs_data(files)
    return {"app": sd.app_data(sound_stub()), "decks": sd.decks_data(), "songs": songs}


# ── theory: match / match_pitches / naming ──────────────────────────────────
def chord_corpus(data: dict) -> dict[str, ChordSymbol]:
    """Every chord the page can ask for, plus Real Book spellings: text → ChordSymbol."""
    out: dict[str, ChordSymbol] = {}

    def add(chord: ChordSymbol) -> None:
        out.setdefault(chord.text, chord)

    for items in builtin_decks().values():
        for item in items:
            if not item.is_pitch:
                for c in item.seq:
                    add(c)
    for song_id, path in _song_paths():
        from music.songs.chart import parse_song
        base, _ = parse_song(path.read_text(encoding="utf-8"))
        for dial in ("core", "written", "triads"):
            song = dataclasses.replace(base, grade=dial)
            for item in chord_items(song_id, song) + phrase_items(song_id, song):
                for c in item.seq:
                    add(c)
    for text in EXTRA_CHORDS:
        try:
            add(parse_chord(text))
        except ValueError:
            pass
    return out


def _song_paths() -> list[tuple[str, Path]]:
    return [(song_id, path) for song_id, path, _ in sd.song_ids(sorted(DEMO_SONGS.glob("*.txt")))]


def note_sets(chord: ChordSymbol, rng: random.Random) -> list[list[int]]:
    root = chord.root_pc
    tones = sorted({(root + i) % 12 for i in chord.intervals})
    bass = chord.expected_bass_pc
    upper = {60 + pc for pc in tones}
    sets = [
        sorted({48 + root} | upper),                                   # close, root below
        sorted({36 + bass} | upper),                                   # the slash bass lowest
        sorted({48 + root} | {60 + pc for pc in tones if pc != (root + 7) % 12}),   # shell
        sorted({36 + root, 48 + root} | {rng.choice((60, 72)) + pc for pc in tones}),  # spread
        [],
    ]
    drop = rng.choice(tones)
    sets.append(sorted({60 + pc for pc in tones if pc != drop}) or [60 + root])
    outside = [pc for pc in range(12) if pc not in tones]
    if outside:
        sets.append(sorted(upper | {72 + rng.choice(outside)}))
    others = [pc for pc in tones if pc != bass]
    if others:
        sets.append(sorted({36 + rng.choice(others)} | upper))
    for _ in range(2):
        sets.append(sorted(rng.sample(range(36, 97), rng.randint(1, 6))))
    return sets


def match_vectors(corpus: dict[str, ChordSymbol], table: sd.ChordTable, rng: random.Random) -> list:
    out = []
    for text in sorted(corpus):
        chord = corpus[text]
        table.add(chord)
        for notes in note_sets(chord, rng):
            for level in LEVELS:
                v = match(notes, chord, Level(level))
                out.append({"chord": text, "notes": notes, "level": level, "verdict": jsonable(v.to_dict())})
    return out


def pitch_vectors(rng: random.Random) -> list:
    out = []
    targets = [list(i.pitches) for name, items in builtin_decks().items() if name.startswith("reading-")
               for i in items if i.is_pitch]
    targets += [sorted(rng.sample(range(36, 97), rng.randint(1, 3))) for _ in range(40)]
    for want in targets:
        sets = [list(want), [n + 12 for n in want], [n - 1 for n in want] + want[1:],
                sorted(set(want) | {rng.randint(36, 96)}), want[:-1], [],
                sorted(rng.sample(range(36, 97), rng.randint(1, 4)))]
        for notes in sets:
            for exact in (True, False):
                v = match_pitches(notes, want, octave_exact=exact)
                out.append({"targets": want, "notes": notes, "octave_exact": exact,
                            "verdict": jsonable(v.to_dict())})
    return out


def naming_vectors(corpus: dict[str, ChordSymbol], rng: random.Random) -> list:
    sets = [sorted(rng.sample(range(36, 97), rng.randint(0, 7))) for _ in range(500)]
    for text in sorted(corpus)[:200]:
        sets.extend(note_sets(corpus[text], rng)[:2])
    sets += [[60], [60, 72], [60, 64], [48, 60, 64, 67]]
    out = []
    for notes in sets:
        ranked = [{"name": r.name, "root_pc": r.root_pc, "quality": r.quality, "score": r.score,
                   "exact": r.exact} for r in name_notes(notes, top=3)]
        out.append({"notes": notes, "top": 3, "ranked": ranked})
    return out


# ── grading ─────────────────────────────────────────────────────────────────
def grading_vectors(rng: random.Random) -> list:
    out = []
    limits = (2.0, 6.0, 15.0)
    for i in range(1200):
        attempts = []
        for _ in range(rng.randint(0, 6)):
            a = {"ok": rng.random() < 0.45}
            a["missing"] = None if rng.random() < 0.05 else sorted(rng.sample(range(12), rng.randint(0, 3)))
            a["extra"] = sorted(rng.sample(range(12), rng.randint(0, 3)))
            attempts.append(a)
        steps = rng.choice((1, 1, 1, 2, 3, 4, 8, 16, 50))
        pick = i % 4
        if pick == 0:
            latency = rng.uniform(0, 3 * steps)
        elif pick == 1:
            latency = rng.uniform(0, 20 * steps)
        elif pick == 2:
            latency = rng.choice(limits) * steps + rng.choice((-1e-9, 0.0, 1e-9, -0.0005, 0.0005))
        else:
            latency = round(rng.uniform(0, 30), rng.choice((1, 3, 4)))
        out.append({"attempts": attempts, "latency_s": latency, "steps": steps,
                    "grade": jsonable(grade(attempts, latency, steps=steps))})
    return out


# ── phrase Fronts ───────────────────────────────────────────────────────────
def front_vectors(data: dict) -> list:
    fronts: set[str] = set()
    for song in data["songs"].values():
        for view in song["dials"].values():
            for card in view["cards"]:
                f = card["front"]
                fronts |= {f, f + "  ", "  " + f, f.replace(" (start)", ""), f.split(" (")[0] + " (after G7)"}
    fronts |= {"Very Early · A line 2", "Very Early · A line 4 · 2nd ending (after G7)",
               "X · Bridge line 12 · 3rd ending", "Title · A line 1 · 21st ending (start)",
               "ii–V–I in Ab", "C7 shell", "E4 treble", "garbage", "", "A · B line x",
               "Title · A2 line 3 (cue (nested))", "Title · this-label-is-too-long line 1",
               "Title·A line 1", "Song · A' line 2 (after C)", "Song · A_2 line 7 · 1st ending"}
    out = []
    for f in sorted(fronts):
        parsed = parse_front(f)
        out.append({"front": f, "parsed": list(parsed) if parsed else None})
    return out


# ── SM-2 walks ──────────────────────────────────────────────────────────────
def srs_vectors(data: dict, rng: random.Random, tmp: Path, walks: int = 24) -> list:
    pools = {theme: [CardSpec(c["key"], c["front"], c["back"]) for c in cards]
             for theme, cards in data["decks"]["cards"].items()}
    for song_id, song in data["songs"].items():
        pools[f"song:{song_id}"] = [CardSpec(c["key"], c["front"], c["back"])
                                    for c in song["dials"]["core"]["cards"]]
    out = []
    for w in range(walks):
        clock = [SRS_START + timedelta(minutes=rng.randint(0, 600))]
        sched = LocalScheduler(tmp / f"walk-{w}.json", clock=lambda: clock[0])
        ops = [{"op": "clock", "at": clock[0].isoformat()}]
        for _ in range(rng.randint(25, 70)):
            r = rng.random()
            if r < 0.12:
                theme = rng.choice(sorted(pools))
                specs = rng.sample(pools[theme], min(len(pools[theme]), rng.randint(1, 8)))
                if rng.random() < 0.3:
                    specs = [CardSpec(s.key, s.front, s.back + " (edited)") for s in specs]
                res = sched.add(theme, specs)
                ops.append({"op": "add", "theme": theme,
                            "specs": [{"key": s.key, "front": s.front, "back": s.back} for s in specs],
                            "out": res})
            elif r < 0.55:
                due = sched.due(None)
                ids = [c.card_id for c in due] or [c["id"] for c in sched._load()]
                if not ids:
                    continue
                cid = rng.choice(ids) if rng.random() < 0.9 else "nope00000000"
                ease = rng.choice((1, 2, 3, 3, 4, 4)) if rng.random() < 0.95 else rng.choice((0, 5))
                res = sched.answer(cid, ease)
                ops.append({"op": "answer", "id": cid, "ease": ease, "out": res,
                            "card": sched.card(cid)})
            elif r < 0.8:
                pick = rng.random()
                if pick < 0.3:
                    step = timedelta(seconds=rng.randint(1, 120), microseconds=rng.randint(0, 999999))
                elif pick < 0.6:
                    step = timedelta(minutes=rng.randint(1, 30))
                elif pick < 0.9:
                    step = timedelta(days=rng.choice((1, 1, 2, 3, 5, 9, 30)), hours=rng.randint(0, 12))
                else:                                   # land exactly on a due time
                    dues = sorted({c["due"] for c in sched._load()})
                    step = (datetime.fromisoformat(rng.choice(dues)) - clock[0]) if dues else timedelta(0)
                    step = max(step, timedelta(0))
                clock[0] = clock[0] + step
                ops.append({"op": "clock", "at": clock[0].isoformat()})
            elif r < 0.93:
                theme = None if rng.random() < 0.5 else rng.choice(sorted(pools))
                due = sched.due(theme)
                ops.append({"op": "due", "theme": theme,
                            "out": [{"card_id": c.card_id, "front": c.front, "theme": c.theme} for c in due]})
            else:
                ops.append({"op": "counts", "out": sched.counts()})
        ops.append({"op": "cards", "out": jsonable(sched._load())})
        out.append({"ops": ops})
    return out


# ── drill: engine traces ────────────────────────────────────────────────────
def voicing_for(chord: ChordSymbol, level: str, rng: random.Random, right: bool) -> list[int]:
    root = chord.root_pc
    tones = sorted({(root + i) % 12 for i in chord.intervals})
    bass = chord.expected_bass_pc
    keep = [pc for pc in tones if not (chord.fifth_omittable() and pc == (root + 7) % 12
                                        and rng.random() < 0.5)]
    octave = rng.choice((48, 60))
    notes = {octave + 12 + pc for pc in keep}
    if level in ("inversion", "voiced"):
        notes.add(36 + bass)
    else:
        notes.add(octave + root if rng.random() < 0.7 else octave + 12 + root)
    if right:
        if level == "loose" and rng.random() < 0.25:
            notes.add(84 + rng.choice([pc for pc in range(12) if pc not in tones] or [root]))
        return sorted(notes)
    wrong = rng.random()
    if wrong < 0.35 and len(keep) > 1:                   # a required tone missing
        notes.discard(octave + 12 + rng.choice([pc for pc in keep if pc != root] or keep))
    elif wrong < 0.65:                                   # an extra pitch class
        outside = [pc for pc in range(12) if pc not in tones]
        if outside:
            notes.add(72 + rng.choice(outside))
    elif wrong < 0.8 and level in ("inversion", "voiced"):
        notes.discard(36 + bass)
        notes.add(36 + rng.choice([pc for pc in tones if pc != bass] or tones))
    else:
        notes = set(rng.sample(range(40, 90), rng.randint(1, 4)))
    return sorted(notes)


def pitch_notes(item: DrillItem, rng: random.Random, right: bool) -> list[int]:
    want = list(item.pitches)
    if right:
        return want if item.octave_exact or rng.random() < 0.5 else [n + 12 for n in want]
    return rng.choice(([n + 12 for n in want], [want[0] + 1], want + [want[-1] + 3], want[:1] + [30]))


def notes_for(item: DrillItem, sub: int, rng: random.Random, right: bool) -> list[int]:
    if item.is_pitch:
        return sorted(set(pitch_notes(item, rng, right)))
    return voicing_for(item.seq[sub], item.level.value, rng, right)


def item_pool(data: dict) -> list[DrillItem]:
    pool = [i for items in builtin_decks().values() for i in items]
    for song_id, path in _song_paths():
        from music.songs.chart import parse_song
        song, _ = parse_song(path.read_text(encoding="utf-8"))
        pool += chord_items(song_id, song) + phrase_items(song_id, song)
        for label in (None, *[s.label for s in song.sections]):
            item = play_item(song_id, song, label)
            if item is not None and len(item.seq) <= 20:
                pool.append(item)
    return pool


def drill_vectors(pool: list[DrillItem], table: sd.ChordTable, rng: random.Random, traces: int = 160) -> list:
    out = []
    for _ in range(traces):
        items = [rng.choice(pool) for _ in range(rng.randint(1, 4))]
        items = [dataclasses.replace(i, debounce_s=rng.choice((0.0, 0.05, 0.15, 0.5)))
                 if rng.random() < 0.2 else i for i in items]
        events: list = []
        engine = DrillEngine(items, lambda n, p: events.append([n, jsonable(p)]))
        tracker = NoteTracker()
        ops: list = []

        def do(op: list) -> None:
            ops.append(op)
            kind = op[0]
            if kind == "start":
                engine.start(op[1])
            elif kind == "note":
                tracker.feed(MidiEvent.normalize("note_on" if op[2] else "note_off", op[3], 100, 0, op[1]))
            elif kind == "feed":
                engine.feed(op[1], tracker)
            elif kind == "skip":
                engine.skip(op[1])

        t = r4(rng.uniform(0, 2))
        do(["start", t])
        held: set[int] = set()
        guard = 0
        while not engine.done and guard < 60:
            guard += 1
            item = engine.current
            db = item.debounce_s
            roll = rng.random()
            if roll < 0.05:
                t = r4(t + rng.uniform(0.05, 1.0))
                do(["skip", t])
                continue
            # Let go first — or keep holding (the next prompt must not grade it: arming).
            if held and rng.random() < 0.8:
                for n in sorted(held):
                    t = r4(t + rng.choice((0.0, 0.003, 0.02)))
                    do(["note", t, False, n])
                    if rng.random() < 0.3:
                        do(["feed", t])
                held.clear()
            t = r4(t + rng.uniform(0.0, 2.5))
            do(["feed", t])
            right = roll > 0.35
            short = 0.05 <= roll < 0.13
            notes = notes_for(item, engine._sub, rng, right)
            for n in notes:
                if n in held:
                    continue
                t = r4(t + rng.choice((0.0, 0.0, 0.004, 0.02, 0.06)))
                do(["note", t, True, n])
                held.add(n)
                if rng.random() < 0.4:
                    do(["feed", t])
            press_end = t
            hold = max(0.0, db - 0.05) if short else rng.choice((db, db + 0.0001, db + 0.08, db + 0.6))
            for frac in (0.5, 1.0):
                do(["feed", r4(press_end + hold * frac)])
            t = r4(press_end + hold + rng.choice((0.0, 0.01, 0.1)))
            do(["feed", t])
        for n in sorted(held):
            t = r4(t + 0.01)
            do(["note", t, False, n])
        do(["feed", r4(t + 0.5)])
        out.append({"items": [sd.item_payload(i, table) for i in items], "ops": ops, "events": events})
    return out


# ── service: whole sessions ─────────────────────────────────────────────────
class _NoMidi:
    """A mido stand-in with no ports: the page's trainer never owns a MIDI port either."""

    def get_input_names(self):
        return []

    def get_output_names(self):
        return []

    def open_input(self, name):
        raise OSError(name)

    def open_output(self, name):
        raise OSError(name)


class _InOrder(DeckRun):
    """DeckRun without the shuffle, so both sides see one order (the page's shuffle is injected)."""

    def __init__(self, items, shuffle=True, rng=None):
        super().__init__(items, shuffle=False)


class Session:
    """TrainerService + SongsService wired as web/server.py wires them, on fake clocks.

    Every op is applied to the Python services as it is written down, so a scripted pair of
    hands can look at the live card and decide what to play; the twin replays the ops blindly.
    """

    def __init__(self, tmp: Path, rng: random.Random) -> None:
        self.rng = rng
        self.t = 0.0
        self.clock = [SRS_START]
        self.events: list = []
        self.ops: list = []
        subs: list = []

        def publish(event: dict) -> None:            # web/server.py Hub.publish
            for cb in list(subs):
                try:
                    cb(event)
                except Exception:
                    pass

        self.review = Review(directory=tmp / "srs", clock=lambda: self.clock[0], backend="local")
        self.svc = TrainerService(midi_module=_NoMidi(), publish=publish, review=self.review)
        self.svc.now = lambda: self.t
        store = SongStore(tmp / "songs")
        for song_id, path in _song_paths():
            (tmp / "songs" / song_id).mkdir(parents=True, exist_ok=True)
            shutil.copy(path, tmp / "songs" / song_id / "song.txt")
        self.songs = SongsService(store=store, publish=publish, review=self.review,
                                  runs_path=tmp / "runs.jsonl")
        self.svc.add_deck_source(self.songs.decks)
        self.songs.on_review_changed = self.svc.refresh_due
        subs.append(self.songs.on_event)
        subs.append(lambda e: self.events.append(jsonable(e)))

    # ── ops (each applied now, recorded for the twin) ──────────────────────
    def _record(self, op: dict, out=None) -> None:
        op["out"] = jsonable(out)
        op["n"] = len(self.events)
        self.ops.append(op)

    def _tick(self, events: list) -> None:          # TrainerService.tick minus the hardware
        svc = self.svc
        for on, note, vel in events:
            ev = MidiEvent.normalize("note_on" if on else "note_off", note, vel, 0, self.t)
            svc.tracker.feed(ev)
            svc.publish({"type": "note", "on": ev.type == "note_on", "note": ev.note, "vel": ev.vel})
        svc._pump_held(self.t)
        if svc.engine is not None and not svc.engine.done:
            svc.engine.feed(self.t, svc.tracker)

    def advance(self, dt: float) -> None:
        self.t = r4(self.t + dt)

    def notes(self, events: list) -> None:
        self._tick(events)
        self._record({"op": "notes", "t": self.t, "events": events})

    def tick(self) -> None:
        self._tick([])
        self._record({"op": "tick", "t": self.t})

    def start(self, deck: str) -> None:
        ok = self.svc.start_drill(deck)
        self._record({"op": "start", "t": self.t, "deck": deck}, ok)

    def skip(self) -> None:
        self.svc.skip()
        self._record({"op": "skip", "t": self.t})

    def stop(self) -> None:
        self.svc.stop_drill()
        self._record({"op": "stop", "t": self.t})

    def seed(self, deck: str) -> None:
        try:
            out = {"status": 200, "body": {"builtin": deck, **self.svc.seed_builtin(deck)}}
        except KeyError:
            out = {"status": 404, "body": {"detail": f"unknown deck {deck!r}"}}
        except ValueError as e:
            out = {"status": 400, "body": {"detail": str(e)}}
        self._record({"op": "seed", "deck": deck}, out)

    def seed_song(self, song_id: str) -> None:
        self._record({"op": "seed_song", "song": song_id}, self.songs.seed(song_id))

    def dial(self, song_id: str, dial: str) -> None:
        doc = self.songs.patch(song_id, {"grade": dial})
        self._record({"op": "dial", "song": song_id, "dial": dial},
                     {"grade": doc["grade"], "phrases": len(doc["phrases"]), "chords": len(doc["chords"])})

    def srs_clock(self, delta: timedelta) -> None:
        self.clock[0] = self.clock[0] + delta
        self.svc.refresh_due()               # the server's due cache lives 5 s; a day has passed
        self._record({"op": "clock", "at": self.clock[0].isoformat()})

    def status(self) -> None:
        self._record({"op": "status"}, self.svc.status())

    def song(self, song_id: str) -> None:
        doc = self.songs.song(song_id)
        self._record({"op": "song", "song": song_id}, {"review": doc["review"], "grade": doc["grade"]})

    def runs(self, song_id: str) -> None:
        runs = [{k: v for k, v in r.items() if k != "finished"} for r in self.songs.runs(song_id)]
        self._record({"op": "runs", "song": song_id}, runs)

    # ── a scripted pair of hands ───────────────────────────────────────────
    def play(self, right: bool = True, think: float | None = None, hold: float = 0.45,
             release: bool = True, notes: list[int] | None = None) -> bool:
        engine = self.svc.engine
        if engine is None or engine.done or engine.current is None:
            return False
        item = engine.current
        if notes is None:
            notes = notes_for(item, engine._sub, self.rng, right)
        self.advance(self.rng.uniform(0.15, 3.0) if think is None else think)
        self.tick()
        for n in notes:
            self.advance(self.rng.choice((0.0, 0.004, 0.012)))
            self.notes([[True, n, self.rng.randint(40, 127)]])
        self.advance(hold / 2)
        self.tick()
        self.advance(hold / 2)
        self.tick()
        if release:
            self.advance(0.02)
            self.notes([[False, n, 0] for n in notes])
            self.advance(0.04)
            self.tick()
        return True

    def miss(self, think: float | None = None) -> bool:
        """One attempt that cannot pass: a single key a semitone above the root (or the note)."""
        engine = self.svc.engine
        if engine is None or engine.done or engine.current is None:
            return False
        item = engine.current
        wrong = [item.pitches[0] + 1] if item.is_pitch else [60 + (item.seq[engine._sub].root_pc + 1) % 12]
        return self.play(notes=wrong, think=think)

    def play_card(self, misses: int = 0, think: float | None = None) -> None:
        """One whole card (every chord of a progression), with `misses` wrong tries sprinkled in."""
        engine = self.svc.engine
        if engine is None or engine.done:
            return
        idx = engine.idx
        guard = 0
        while self.svc.engine is engine and not engine.done and engine.idx == idx and guard < 80:
            guard += 1
            wrong = misses > 0 and self.rng.random() < 0.5
            if wrong:
                misses -= 1
            self.play(right=not wrong, think=think)


def _session(rng: random.Random, script) -> dict:
    with tempfile.TemporaryDirectory() as tmp, mock.patch.object(trainer_service, "DeckRun", _InOrder):
        s = Session(Path(tmp), rng)
        script(s)
        return {"ops": s.ops, "events": s.events}


def service_vectors(rng: random.Random) -> list:
    scripts = []

    def triads(s: Session) -> None:
        s.status()
        s.start("triads")
        s.play_card()
        s.play_card(misses=1)                       # a miss: requeued 3 later, streak broken
        s.advance(0.5)
        s.skip()
        s.play_card(think=7.0)                      # slow: Hard
        s.play_card(misses=2)
        s.status()
        s.advance(1.0)
        s.stop()
        s.status()
    scripts.append(("triads", triads))

    def progressions(s: Session) -> None:
        s.start("two-five-one")
        s.play_card(misses=2)
        s.play_card()
        s.play(right=True)
        s.status()                                  # mid-card: status.step > 0
        s.stop()
        s.start("backdoor")
        s.play_card(misses=1, think=0.2)
        s.stop()
    scripts.append(("progressions", progressions))

    def new_progressions(s: Session) -> None:     # minor ii–V–i, the turnaround, the tritone sub
        s.start("minor-two-five-one")
        s.play_card(misses=1)
        s.play_card()
        s.status()
        s.stop()
        s.start("turnaround")
        s.play_card(misses=1)
        s.stop()
        s.start("tritone-sub")
        s.play(right=True)                          # mid-card: status.notes = the next chord's keys
        s.status()
        s.play_card()
        s.stop()
    scripts.append(("new-progressions", new_progressions))

    def advanced(s: Session) -> None:             # the jazz chords: altered 5ths, the sus 4th
        s.start("advanced")
        for i in range(5):
            s.play_card(misses=i % 2)
        s.status()
        s.stop()
    scripts.append(("advanced", advanced))

    def arming(s: Session) -> None:
        s.start("sevenths")
        s.play_card(misses=1)
        s.play(right=True, release=False)           # pass and keep holding into the next card
        s.advance(0.6)
        s.tick()                                    # not armed: the held chord does not grade
        s.notes([[True, 30, 90]])                   # the held set changes after the prompt: armed
        s.advance(0.4)
        s.tick()
        s.notes([[False, n, 0] for n in sorted(s.svc.tracker.held)])
        s.tick()
        s.play_card()
        s.stop()
    scripts.append(("arming", arming))

    def review(s: Session) -> None:
        s.seed("triads")
        s.seed("two-five-one")
        s.seed("triads")                            # again: unchanged
        s.status()
        s.start("review")
        for i in range(6):
            s.play_card(misses=1 if i % 3 == 1 else 0, think=(0.3, 4.0, 12.0)[i % 3])
        s.stop()
        s.status()
        s.srs_clock(timedelta(minutes=2))           # Again cards are due in 1 min
        s.start("review:triads")                    # learning cards first, topped up from the deck
        for _ in range(3):
            s.play_card()
        s.stop()
        s.srs_clock(timedelta(days=1, minutes=5))
        s.status()
        s.start("anki-due")                         # the legacy name, same session
        s.play_card()
        s.play_card(misses=1)
        s.stop()
        s.srs_clock(timedelta(days=12))
        s.start("review")
        s.play_card()
        s.stop()
    scripts.append(("review", review))

    def songs(s: Session) -> None:
        s.song("i-got-rhythm")
        s.start("song:i-got-rhythm:chords")
        s.play_card()
        s.play_card(misses=2)
        s.stop()                                    # a receipt, before the done
        s.start("song:i-got-rhythm:phrases")        # recall: chord null in prompt, step, status
        s.play(right=True)
        s.status()
        s.play_card(misses=2)
        s.play_card()
        s.stop()
        s.start("song:i-got-rhythm:play:B")         # play through one section, never requeued
        s.play_card(misses=2, think=0.3)
        s.runs("i-got-rhythm")
        s.seed_song("i-got-rhythm")
        s.song("i-got-rhythm")
        s.start("review:song:i-got-rhythm")
        s.play_card(misses=1)
        s.play_card()
        s.stop()
        s.runs("i-got-rhythm")
        s.dial("i-got-rhythm", "triads")
        s.start("song:i-got-rhythm:chords")
        s.play_card()
        s.stop()
        s.seed_song("i-got-rhythm")                 # the dial already rewrote the backs: unchanged
        s.dial("i-got-rhythm", "written")
        s.start("song:i-got-rhythm:run:A")          # the legacy name of a play-through
        s.play_card(misses=1, think=0.2)
        s.stop()
        s.runs("i-got-rhythm")
    scripts.append(("songs", songs))

    def blues(s: Session) -> None:
        s.start("song:jazz-blues-in-f:play")
        s.play_card(misses=3, think=0.25)
        s.runs("jazz-blues-in-f")
        s.seed_song("jazz-blues-in-f")
        s.srs_clock(timedelta(minutes=1))
        s.start("review")
        s.play_card()
        s.play_card(misses=1)
        s.stop()
        s.runs("jazz-blues-in-f")
    scripts.append(("blues", blues))

    def requeue_cap(s: Session) -> None:
        s.start("sevenths")                         # 30 cards; each miss requeues until MAX_CARDS
        for _ in range(34):
            s.miss(think=0.1)
            s.play_card(think=0.1)
        s.status()
        s.stop()
    scripts.append(("requeue-cap", requeue_cap))

    def errors(s: Session) -> None:
        s.start("nope")
        s.start("review")                           # nothing due
        s.start("review:triads")
        s.start("song:nope:chords")
        s.start("song:i-got-rhythm:play:Z")
        s.start("song:i-got-rhythm:bogus")
        s.seed("nope")                              # 404 (every menu deck is seedable)
        s.skip()
        s.stop()
        s.status()
    scripts.append(("errors", errors))

    decks = list(MENU) + [                          # what the page ships (§11 v2)
        "song:i-got-rhythm:chords", "song:i-got-rhythm:phrases", "song:jazz-blues-in-f:chords",
        "song:jazz-blues-in-f:phrases", "song:jazz-blues-in-f:play:A"]
    for k in range(10):
        deck = decks[(k * 7) % len(decks)]

        def randomized(s: Session, deck=deck) -> None:
            s.start(deck)
            for _ in range(s.rng.randint(3, 7)):
                roll = s.rng.random()
                if roll < 0.1:
                    s.advance(0.3)
                    s.skip()
                else:
                    s.play_card(misses=s.rng.choice((0, 0, 1, 2)))
            s.status()
            s.stop()
        scripts.append((f"random-{k}-{deck}", randomized))

    return [{"name": name, **_session(random.Random(rng.random()), script)} for name, script in scripts]


# ── all of it ───────────────────────────────────────────────────────────────
def generate(seed: int = 20261004) -> dict:
    rng = random.Random(seed)
    data = page_data()
    table = sd.ChordTable()
    corpus = chord_corpus(data)
    with tempfile.TemporaryDirectory() as tmp:
        srs = srs_vectors(data, rng, Path(tmp))
    vectors = {
        "v": VECTORS_VERSION,
        "seed": seed,
        "data": data,
        "match": match_vectors(corpus, table, rng),
        "pitches": pitch_vectors(rng),
        "naming": naming_vectors(corpus, rng),
        "grading": grading_vectors(rng),
        "fronts": front_vectors(data),
        "srs": srs,
        "drill": drill_vectors(item_pool(data), table, rng),
        "service": service_vectors(rng),
    }
    vectors["chords"] = table.rows
    return vectors


def counts(vectors: dict) -> dict[str, int]:
    """How many cases each family holds (sessions and walks count their ops)."""
    out = {k: len(vectors[k]) for k in ("match", "pitches", "naming", "grading", "fronts")}
    out["srs"] = sum(len(w["ops"]) for w in vectors["srs"])
    out["drill"] = sum(len(t["events"]) for t in vectors["drill"])
    out["service"] = sum(len(s["events"]) + len(s["ops"]) for s in vectors["service"])
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=Path("static-vectors.json"))
    ap.add_argument("--seed", type=int, default=20261004)
    args = ap.parse_args(argv)
    vectors = generate(args.seed)
    args.out.write_text(json.dumps(vectors, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    c = counts(vectors)
    print(f"wrote {args.out}: " + ", ".join(f"{k} {v}" for k, v in c.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
