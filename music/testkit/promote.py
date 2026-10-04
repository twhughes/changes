"""promote — turn a session into a replay fixture (CONTRACTS.md §3).

`promote sessions/<dir>` copies the capture + its verdicts under
tests/fixtures/replays/<name>/, where test_replay_sessions.py re-grades it on
every run. An existing fixture is never silently overwritten: a deliberate
matcher change is re-blessed with `--rebless`, which prints what moved.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from music.testkit.replaygrade import load_session, replay_session

REPLAYS_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "replays"
REQUIRED = ("midi.jsonl", "session.json")


def promote(session_dir: str | Path, name: str | None = None, rebless: bool = False,
            replays_dir: str | Path = REPLAYS_DIR) -> tuple[Path, list[str]]:
    """Copy a session into the fixture tree. Returns (fixture_dir, change lines)."""
    src = Path(session_dir)
    for fname in REQUIRED:
        if not (src / fname).exists():
            raise FileNotFoundError(f"{src}: not a session directory (no {fname})")
    session = load_session(src)
    dest = Path(replays_dir) / (name or session.get("exam_id") or src.name)

    baseline = load_session(dest) if (dest / "session.json").exists() else None
    if baseline is not None and not rebless:
        raise FileExistsError(
            f"fixture {dest} already exists — pass --name for a new one, "
            f"or --rebless to re-grade and overwrite it")

    dest.mkdir(parents=True, exist_ok=True)
    for fname in REQUIRED:
        shutil.copy2(src / fname, dest / fname)

    changes: list[str] = []
    if rebless:
        before = baseline or session
        changes = rebless_fixture(dest, before)
    return dest, changes


def rebless_fixture(fixture_dir: str | Path, before: dict | None = None) -> list[str]:
    """Re-grade the fixture's capture and write the fresh verdicts into session.json."""
    fixture_dir = Path(fixture_dir)
    session = load_session(fixture_dir)
    before = before or session
    results = replay_session(fixture_dir)

    changes = []
    for i, item in enumerate(session["items"]):
        if i >= len(results):
            break
        old = (before["items"][i] if i < len(before.get("items", [])) else item)
        new = results[i]
        item["attempts"] = new.attempts
        item["passed"] = new.passed
        item["skipped"] = new.skipped
        item["latency_s"] = new.latency_s
        if _outcome(old) != _outcome(item):
            changes.append(
                f"item {i + 1} ({item['prompt']}): "
                f"{_fmt(_outcome(old))} → {_fmt(_outcome(item))}")
    summary = session.get("summary", {})
    summary["passed"] = sum(1 for it in session["items"] if it["passed"])
    summary["total"] = len(session["items"])
    (fixture_dir / "session.json").write_text(json.dumps(session, indent=2) + "\n")
    return changes


def _outcome(item: dict) -> tuple[bool, bool, int]:
    return (bool(item.get("passed")), bool(item.get("skipped")), len(item.get("attempts") or []))


def _fmt(outcome: tuple[bool, bool, int]) -> str:
    passed, skipped, attempts = outcome
    state = "skipped" if skipped else ("passed" if passed else "failed")
    return f"{state} ({attempts} attempts)"


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m music.testkit promote",
                                 description="Promote a session into a replay fixture.")
    ap.add_argument("session_dir", help="sessions/<dir> to promote")
    ap.add_argument("--name", help="fixture name (default: the exam id)")
    ap.add_argument("--rebless", action="store_true",
                    help="re-grade the capture and overwrite an existing fixture's verdicts")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        dest, changes = promote(args.session_dir, name=args.name, rebless=args.rebless)
    except (FileExistsError, FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}")
        return 2
    print(f"fixture: {dest}")
    if args.rebless:
        if changes:
            print("re-blessed — changed outcomes:")
            for line in changes:
                print(f"  {line}")
        else:
            print("re-blessed — no item outcomes changed")
    return 0
