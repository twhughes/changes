"""Replay — feed a recorded capture back through a NoteTracker/consumer, instantly.

Time comes from the recorded `t` fields, never from sleeping, so replay is
deterministic and fast (live session ≡ replay by construction).
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from music.midio.events import event_from_record, read_records
from music.midio.notes import NoteTracker


def replay_into(
    path: str | Path,
    on_time: Callable[[float, NoteTracker], None],
    on_mark: Callable[[float, str], None] | None = None,
    tail_s: float = 5.0,
) -> NoteTracker:
    """Drive a fresh NoteTracker through the capture.

    ``on_time(t, tracker)`` fires twice per event — just before applying it
    (time has advanced with the old held set: this is where stability windows
    close) and just after — and once at end-of-stream + tail_s so a final
    held chord still stabilizes. ``on_mark`` receives mark records in order.
    """
    tracker = NoteTracker()
    last_t = 0.0
    for rec in read_records(path):
        kind = rec.get("kind")
        if kind == "ev":
            ev = event_from_record(rec)
            on_time(ev.t, tracker)      # old held set, time advanced
            tracker.feed(ev)
            on_time(ev.t, tracker)      # new held set
            last_t = ev.t
        elif kind == "mark":
            if on_mark:
                on_mark(rec["t"], rec["label"])
            last_t = max(last_t, rec["t"])
    on_time(last_t + tail_s, tracker)
    return tracker
