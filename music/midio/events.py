"""MIDI event stream — JSONL v1 (CONTRACTS.md §1).

Timestamps: seconds relative to capture start, stamped time.monotonic() at
receipt — device/rtmidi timing is never trusted. note_on vel=0 → note_off.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

JSONL_VERSION = 1


@dataclass(frozen=True)
class MidiEvent:
    t: float
    type: str        # "note_on" | "note_off" (others dropped at ingest for now)
    note: int
    vel: int
    ch: int = 0

    @staticmethod
    def normalize(type: str, note: int, vel: int, ch: int, t: float) -> "MidiEvent":
        if type == "note_on" and vel == 0:
            type = "note_off"
        return MidiEvent(t=round(t, 4), type=type, note=note, vel=vel, ch=ch)

    def to_record(self) -> dict:
        return {"kind": "ev", "t": self.t, "type": self.type,
                "note": self.note, "vel": self.vel, "ch": self.ch}


def header_record(port: str, started_iso: str) -> dict:
    return {"kind": "header", "v": JSONL_VERSION, "port": port, "started": started_iso}


def mark_record(t: float, label: str) -> dict:
    return {"kind": "mark", "t": round(t, 4), "label": label}


def write_line(fh, record: dict) -> None:
    fh.write(json.dumps(record, separators=(",", ":")) + "\n")
    fh.flush()  # append-only + flush per line: a crash loses nothing


def read_records(path: str | Path) -> list[dict]:
    records = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def event_from_record(rec: dict) -> MidiEvent:
    return MidiEvent(t=rec["t"], type=rec["type"], note=rec["note"],
                     vel=rec["vel"], ch=rec.get("ch", 0))
