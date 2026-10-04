"""Recorder — writes the JSONL v1 capture file (CONTRACTS.md §1)."""

from __future__ import annotations

import threading
import time
from datetime import datetime
from pathlib import Path

from music.midio.events import MidiEvent, header_record, mark_record, write_line


class Recorder:
    """Append-only capture. t=0 is construction time (or an injected t0)."""

    def __init__(self, path: str | Path, port: str, t0: float | None = None) -> None:
        self.path = Path(path)
        self.t0 = time.monotonic() if t0 is None else t0
        self._lock = threading.Lock()
        self._fh = open(self.path, "a")
        write_line(self._fh, header_record(port, datetime.now().astimezone().isoformat()))

    def rel(self, monotonic_t: float) -> float:
        return monotonic_t - self.t0

    def event(self, type: str, note: int, vel: int, ch: int, monotonic_t: float) -> MidiEvent:
        ev = MidiEvent.normalize(type, note, vel, ch, self.rel(monotonic_t))
        with self._lock:
            write_line(self._fh, ev.to_record())
        return ev

    def mark(self, label: str, monotonic_t: float | None = None) -> None:
        t = self.rel(time.monotonic() if monotonic_t is None else monotonic_t)
        with self._lock:
            write_line(self._fh, mark_record(t, label))

    def close(self) -> None:
        with self._lock:
            self._fh.close()
