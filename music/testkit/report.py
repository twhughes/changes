"""Session record — session.json v1 + report.md (CONTRACTS.md §3).

session.json is the promotable artifact: it carries everything a replay needs to
re-grade the capture (chord, level, debounce_ms per item), so fixtures never
depend on the exam file that produced them.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from music.learn.drill import ItemResult
from music.theory import THEORY_VERSION

SESSION_VERSION = 1


def write_session(dir: str | Path, exam, results: list[ItemResult], started_iso: str,
                  duration_s: float | None = None) -> None:
    """Write session.json + report.md into `dir`."""
    path = Path(dir)
    path.mkdir(parents=True, exist_ok=True)
    data = session_dict(exam, results, started_iso, duration_s)
    (path / "session.json").write_text(json.dumps(data, indent=2) + "\n")
    (path / "report.md").write_text(render_markdown(data))


def session_dict(exam, results: list[ItemResult], started_iso: str,
                 duration_s: float | None = None) -> dict:
    items = [_item_dict(r, exam.items[i] if i < len(exam.items) else None)
             for i, r in enumerate(results)]
    if duration_s is None:
        duration_s = _elapsed_since(started_iso)
    return {
        "v": SESSION_VERSION,
        "exam_id": exam.id,
        "exam_sha": getattr(exam, "sha", "") or "",
        "theory_version": THEORY_VERSION,
        "started": started_iso,
        "items": items,
        "summary": _summary(items, duration_s),
    }


def _item_dict(result: ItemResult, item) -> dict:
    check = dict(result.check)
    if item is not None and "debounce_ms" not in check:
        check["debounce_ms"] = round(item.debounce_s * 1000)
    return {
        "prompt": result.prompt,
        "check": check,
        "attempts": result.attempts,
        "passed": result.passed,
        "skipped": result.skipped,
        "latency_s": result.latency_s,
        "note": result.note,
        "span": None,  # note-index span: reserved (CONTRACTS §3)
    }


def _summary(items: list[dict], duration_s: float) -> dict:
    passed = [it for it in items if it["passed"]]
    lat = [it["latency_s"] for it in passed if it["latency_s"] is not None]
    return {
        "passed": len(passed),
        "total": len(items),
        "duration_s": round(duration_s, 1),
        "mean_latency_s": round(sum(lat) / len(lat), 2) if lat else None,
    }


def _elapsed_since(started_iso: str) -> float:
    try:
        return (datetime.now().astimezone() - datetime.fromisoformat(started_iso)).total_seconds()
    except ValueError:
        return 0.0


def render_markdown(data: dict) -> str:
    lines = [f"# {data['exam_id']} — session report", ""]
    lines.append(f"*{data['started']}* · theory {data['theory_version']} · exam `{data['exam_sha']}`")
    lines.append("")
    for i, it in enumerate(data["items"], start=1):
        lines.append(_item_line(i, it))
        if it["note"]:
            lines.append(f"    > {it['note']}")
    s = data["summary"]
    mean = "—" if s["mean_latency_s"] is None else f"{s['mean_latency_s']:.2f}s"
    lines += [
        "",
        "## Summary",
        "",
        f"- **{s['passed']}/{s['total']} passed**",
        f"- duration {s['duration_s']:.1f}s",
        f"- mean latency (passed items) {mean}",
        "",
    ]
    return "\n".join(lines)


def _item_line(n: int, it: dict) -> str:
    if it["skipped"]:
        glyph = "⏭"
    elif it["passed"]:
        glyph = "✓"
    else:
        glyph = "✗"
    bits = [f"{n:2d}. {glyph} {it['prompt']}"]
    if it["latency_s"] is not None:
        bits.append(f"({it['latency_s']:.2f}s)")
    tries = len(it["attempts"])
    if tries > 1:
        bits.append(f"[{tries} attempts]")
    elif tries == 0 and not it["skipped"]:
        bits.append("[no attempt]")
    return " ".join(bits)
