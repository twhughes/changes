"""NoteTracker — folds a note event stream into the currently-held set.

Grading is a pure function of (events, times): the tracker never reads a clock;
callers pass `now` in, which is what makes live and replay identical.
"""

from __future__ import annotations

from music.midio.events import MidiEvent


class NoteTracker:
    def __init__(self) -> None:
        self.held: set[int] = set()
        self.last_change: float = 0.0

    def feed(self, ev: MidiEvent) -> None:
        before = frozenset(self.held)
        if ev.type == "note_on":
            self.held.add(ev.note)
        elif ev.type == "note_off":
            self.held.discard(ev.note)
        if frozenset(self.held) != before:
            self.last_change = ev.t

    def stable_held(self, now: float, debounce_s: float) -> frozenset[int] | None:
        """The held set, iff non-empty and unchanged for at least debounce_s."""
        if self.held and (now - self.last_change) >= debounce_s:
            return frozenset(self.held)
        return None

    def clear(self) -> None:
        self.held.clear()
