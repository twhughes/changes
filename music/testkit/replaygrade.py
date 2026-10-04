"""Replay grading — re-run a recorded session through the drill engine.

The one grader shared by `promote --rebless` and tests/test_replay_sessions.py.
Items are rebuilt from session.json (chord · level · debounce_ms), so a fixture
is self-contained: capture + expected verdicts, no exam file needed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from music.learn.drill import DrillEngine, DrillItem, ItemResult
from music.midio.notes import NoteTracker
from music.midio.replay import replay_into
from music.testkit.examdef import DEFAULT_DEBOUNCE_MS, DEFAULT_LEVEL
from music.theory.chords import parse_chord
from music.theory.match import Level

_PROMPT_MARK = re.compile(r"^item:(\d+):prompt$")


def load_session(fixture_dir: str | Path) -> dict:
    return json.loads((Path(fixture_dir) / "session.json").read_text())


def items_from_session(session: dict) -> list[DrillItem]:
    """Rebuild the DrillItems a session was graded against."""
    items = []
    for i, it in enumerate(session.get("items", [])):
        check = it.get("check") or {}
        if "chord" not in check:
            raise ValueError(f"session item {i + 1}: check has no 'chord'")
        items.append(DrillItem(
            prompt=it.get("prompt", check["chord"]),
            chord=parse_chord(check["chord"]),
            level=Level(check.get("level", DEFAULT_LEVEL)),
            debounce_s=float(check.get("debounce_ms", DEFAULT_DEBOUNCE_MS)) / 1000.0,
        ))
    return items


def replay_session(fixture_dir: str | Path) -> list[ItemResult]:
    """Grade `<dir>/midi.jsonl` against the items recorded in `<dir>/session.json`."""
    fixture_dir = Path(fixture_dir)
    session = load_session(fixture_dir)
    items = items_from_session(session)
    skipped = [bool(it.get("skipped")) for it in session.get("items", [])]

    engine = DrillEngine(items, on_event=lambda name, payload: None)
    engine.start(0.0)
    clock = {"t": 0.0}

    def on_time(t: float, tracker: NoteTracker) -> None:
        clock["t"] = t
        engine.feed(t, tracker)

    def on_mark(t: float, label: str) -> None:
        clock["t"] = max(clock["t"], t)
        m = _PROMPT_MARK.match(label)
        if not m:
            return
        # The runner marked the next prompt: whatever came before it was skipped
        # live if the session says so and the engine hasn't moved past it yet.
        prev = int(m.group(1)) - 1
        if 0 <= prev < len(skipped) and skipped[prev] and engine.idx == prev:
            engine.skip(t)

    replay_into(fixture_dir / "midi.jsonl", on_time, on_mark)

    # Trailing skips have no following prompt mark to trigger them.
    while not engine.done and 0 <= engine.idx < len(items) and skipped[engine.idx]:
        engine.skip(clock["t"])
    return engine.results
