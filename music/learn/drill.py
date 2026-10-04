"""DrillEngine — the one prompt → listen → grade → advance loop.

Used by testkit (terminal exam) and trainer (browser drill). It is a
time-driven state machine: callers push (time, NoteTracker) samples in via
``feed``; the engine never reads a clock, so it runs identically from a live
poll loop or a replayed recording.

Between items the engine waits for hands-off (held set empty) before arming,
so a passing chord left held doesn't grade the next prompt.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from music.midio.notes import NoteTracker
from music.theory.chords import ChordSymbol
from music.theory.match import Level, Verdict, match, match_pitches


@dataclass(frozen=True)
class DrillItem:
    prompt: str
    chord: ChordSymbol
    level: Level = Level.LOOSE
    debounce_s: float = 0.3
    #: A progression: the chords to play in order. Empty = just ``chord``.
    #: The item is atomic — it requeues, grades, and Anki-answers as one card.
    chords: tuple[ChordSymbol, ...] = ()
    #: Sight reading: exact MIDI pitches to play (non-empty ⇒ pitch grading,
    #: ``chord`` is a placeholder). ``octave_exact`` False relaxes to pitch classes.
    pitches: tuple[int, ...] = ()
    octave_exact: bool = True
    #: Which clef the staff shows the pitches on ("treble" | "bass" | "grand").
    clef: str = "treble"
    #: A memory card: the UI must not show the chords (the trainer sends
    #: ``chord: null``), the prompt names a place in a song instead.
    recall: bool = False
    #: Opaque handle the UI resolves, e.g. ``song:very-early:phrase:A2``.
    ref: str | None = None

    @property
    def seq(self) -> tuple[ChordSymbol, ...]:
        return self.chords if self.chords else (self.chord,)

    @property
    def is_pitch(self) -> bool:
        return bool(self.pitches)

    def staff(self) -> dict | None:
        """The staff payload the cockpit renders for a pitch item, else None."""
        if not self.pitches:
            return None
        return {"clef": self.clef, "pitches": list(self.pitches), "key": "C"}


@dataclass
class ItemResult:
    prompt: str
    check: dict
    attempts: list[dict] = field(default_factory=list)
    passed: bool = False
    skipped: bool = False
    latency_s: float | None = None
    note: str | None = None

    def to_dict(self) -> dict:
        return {
            "prompt": self.prompt, "check": self.check,
            "attempts": self.attempts, "passed": self.passed,
            "skipped": self.skipped, "latency_s": self.latency_s, "note": self.note,
        }


class DrillEngine:
    """on_event(name, payload) fires: prompt, attempt, passed, skipped, done."""

    def __init__(self, items: list[DrillItem],
                 on_event: Callable[[str, dict], None]) -> None:
        self.items = items
        self.on_event = on_event
        self.idx = -1
        self.results: list[ItemResult] = []
        self.done = False
        self._armed = False
        self._item_start = 0.0
        self._sub = 0                     # progression step within the item
        self._last_graded: tuple[frozenset[int], float] | None = None

    @property
    def current(self) -> DrillItem | None:
        return self.items[self.idx] if 0 <= self.idx < len(self.items) else None

    def start(self, t: float) -> None:
        self._advance(t)

    def _advance(self, t: float) -> None:
        self.idx += 1
        if self.idx >= len(self.items):
            self.done = True
            self.on_event("done", {"results": [r.to_dict() for r in self.results]})
            return
        item = self.items[self.idx]
        if item.is_pitch:
            check = {"pitches": list(item.pitches), "level": Level.PITCH.value,
                     "octave_exact": item.octave_exact}
        else:
            check = {"chord": " → ".join(c.text for c in item.seq),
                     "level": item.level.value}
        self.results.append(ItemResult(prompt=item.prompt, check=check))
        self._item_start = t
        self._armed = False
        self._sub = 0
        self._last_graded = None
        self.on_event("prompt", {"idx": self.idx, "prompt": item.prompt,
                                 "total": len(self.items)})

    def skip(self, t: float) -> None:
        if self.done or self.current is None:
            return
        self.results[self.idx].skipped = True
        self.on_event("skipped", {"idx": self.idx})
        self._advance(t)

    def feed(self, t: float, tracker: NoteTracker) -> None:
        if self.done or self.current is None:
            return
        # Don't grade a chord left held over from before this prompt: block until
        # hands come off OR the held set changes after the item started.
        if not self._armed:
            if tracker.held and tracker.last_change < self._item_start:
                return
            self._armed = True

        item = self.items[self.idx]
        stable = tracker.stable_held(t, item.debounce_s)
        if stable is None:
            return
        key = (stable, tracker.last_change)
        if key == self._last_graded:
            return
        self._last_graded = key

        seq = item.seq
        if item.is_pitch:
            verdict: Verdict = match_pitches(stable, item.pitches,
                                             octave_exact=item.octave_exact)
        else:
            verdict = match(stable, seq[self._sub], item.level)
        latency = tracker.last_change - self._item_start
        attempt = {"ok": verdict.ok, "missing": verdict.missing, "extra": verdict.extra,
                   "bass_ok": verdict.bass_ok, "played": sorted(stable),
                   "latency_s": round(latency, 3), "summary": verdict.summary}
        result = self.results[self.idx]
        result.attempts.append(attempt)
        self.on_event("attempt", {"idx": self.idx, "verdict": verdict.to_dict(),
                                  "latency_s": attempt["latency_s"]})
        if verdict.ok:
            if not item.is_pitch and self._sub + 1 < len(seq):     # progression: next chord
                self._sub += 1
                self.on_event("step", {"idx": self.idx, "step": self._sub,
                                       "of": len(seq),
                                       "chord": seq[self._sub].text})
                return
            result.passed = True
            result.latency_s = attempt["latency_s"]
            # first_try = a clean run: every graded attempt (each progression
            # step is one) was correct. Equals len==1 for single-chord items.
            first = all(a["ok"] for a in result.attempts)
            self.on_event("passed", {"idx": self.idx, "latency_s": result.latency_s,
                                     "first_try": first})
            self._advance(t)
