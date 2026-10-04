"""testkit: exam loading/validation, the session record, promote/rebless."""

import json
from pathlib import Path

import pytest

from music.learn.drill import DrillEngine
from music.midio.events import MidiEvent
from music.midio.notes import NoteTracker
from music.testkit.examdef import Exam, exam_sha, load_exam
from music.testkit.promote import promote
from music.testkit.replaygrade import replay_session
from music.testkit.report import write_session
from music.theory import THEORY_VERSION
from music.theory.match import Level

REPO = Path(__file__).resolve().parents[1]
EXAM = REPO / "exams" / "chords-basic.yaml"
FIXTURE = REPO / "tests" / "fixtures" / "replays" / "synthetic-basics"


def write_yaml(tmp_path, text) -> Path:
    path = tmp_path / "exam.yaml"
    path.write_text(text)
    return path


# ── exam definition (CONTRACTS §2) ─────────────────────────────────────────
def test_exam_loads_with_defaults_applied():
    exam = load_exam(EXAM)
    assert exam.id == "chords-basic"
    assert len(exam.items) == 10
    assert exam.defaults == {"level": "loose", "debounce_ms": 300}
    assert all(item.debounce_s == 0.3 for item in exam.items)
    assert exam.items[0].chord.text == "G7" and exam.items[0].level is Level.LOOSE
    levels = [i.level for i in exam.items]
    assert levels[4] is Level.STRICT          # Dm7 — strict
    assert levels[5] is Level.INVERSION       # C/E
    assert levels[9] is Level.INVERSION       # G/B
    assert "G7" in exam.items[0].prompt


def test_per_item_debounce_overrides_defaults(tmp_path):
    path = write_yaml(tmp_path, """
id: t
title: t
defaults: {level: strict, debounce_ms: 300}
items:
  - {prompt: "a", check: {chord: "C"}}
  - {prompt: "b", check: {chord: "G7", level: loose, debounce_ms: 120}}
""")
    exam = load_exam(path)
    assert exam.items[0].level is Level.STRICT and exam.items[0].debounce_s == 0.3
    assert exam.items[1].level is Level.LOOSE and exam.items[1].debounce_s == 0.12


def test_bad_chord_raises_value_error(tmp_path):
    path = write_yaml(tmp_path, """
id: t
title: t
items:
  - {prompt: "a", check: {chord: "H9"}}
""")
    with pytest.raises(ValueError) as exc:
        load_exam(path)
    assert "item 1" in str(exc.value) and "H9" in str(exc.value)


def test_bad_level_raises_value_error(tmp_path):
    path = write_yaml(tmp_path, """
id: t
title: t
items:
  - {prompt: "a", check: {chord: "C", level: sloppy}}
""")
    with pytest.raises(ValueError) as exc:
        load_exam(path)
    assert "sloppy" in str(exc.value) and "inversion" in str(exc.value)


def test_missing_items_and_id_raise(tmp_path):
    with pytest.raises(ValueError):
        load_exam(write_yaml(tmp_path, "id: t\ntitle: t\nitems: []\n"))
    with pytest.raises(ValueError):
        load_exam(write_yaml(tmp_path, "title: t\nitems: [{check: {chord: C}}]\n"))


def test_exam_sha_is_16_hex_of_file_bytes():
    sha = exam_sha(EXAM)
    assert len(sha) == 16 and all(c in "0123456789abcdef" for c in sha)
    assert load_exam(EXAM).sha == sha


# ── session record (CONTRACTS §3) ──────────────────────────────────────────
def play(tracker, engine, t, on=(), off=()):
    for n in on:
        tracker.feed(MidiEvent(t, "note_on", n, 90))
    for n in off:
        tracker.feed(MidiEvent(t, "note_off", n, 0))
    engine.feed(t, tracker)


def synthetic_run():
    """3 items: pass, fail-then-pass, skipped — driven like tests/test_drill.py."""
    exam = load_exam(EXAM)
    exam = Exam(id=exam.id, title=exam.title, defaults=exam.defaults,
                items=exam.items[:3], source=EXAM)
    engine = DrillEngine(exam.items, on_event=lambda name, p: None)
    tr = NoteTracker()
    engine.start(0.0)
    play(tr, engine, 1.0, on=[55, 59, 62, 65])        # G7
    engine.feed(1.5, tr)
    play(tr, engine, 2.0, off=[55, 59, 62, 65])
    play(tr, engine, 3.0, on=[60, 64])                # C, incomplete → fail
    engine.feed(3.5, tr)
    play(tr, engine, 4.0, on=[67])                    # complete it → pass
    engine.feed(4.5, tr)
    play(tr, engine, 5.0, off=[60, 64, 67])
    engine.skip(6.0)                                  # Am7 skipped
    engine.results[0].note = "easy, thumb on G"
    return exam, engine.results


def test_session_json_matches_contract(tmp_path):
    exam, results = synthetic_run()
    write_session(tmp_path, exam, results, "2026-07-28T09:00:00-04:00", duration_s=6.0)
    data = json.loads((tmp_path / "session.json").read_text())

    assert data["v"] == 1
    assert data["exam_id"] == "chords-basic"
    assert data["exam_sha"] == exam_sha(EXAM)
    assert data["theory_version"] == THEORY_VERSION
    assert data["started"] == "2026-07-28T09:00:00-04:00"
    assert len(data["items"]) == 3

    first = data["items"][0]
    assert set(first) == {"prompt", "check", "attempts", "passed", "skipped",
                          "latency_s", "note", "span"}
    assert first["check"] == {"chord": "G7", "level": "loose", "debounce_ms": 300}
    assert first["passed"] is True and first["latency_s"] == 1.0
    assert first["note"] == "easy, thumb on G"
    assert first["span"] is None
    assert first["attempts"][0]["ok"] is True and first["attempts"][0]["played"] == [55, 59, 62, 65]

    second = data["items"][1]
    assert len(second["attempts"]) == 2 and second["attempts"][0]["ok"] is False
    assert second["passed"] is True
    assert data["items"][2]["skipped"] is True and data["items"][2]["passed"] is False

    # item 2 started when item 1 passed (t=1.5) and completed at t=4.0
    assert data["items"][1]["latency_s"] == 2.5
    assert data["summary"] == {"passed": 2, "total": 3, "duration_s": 6.0,
                               "mean_latency_s": round((1.0 + 2.5) / 2, 2)}


def test_report_md_lists_every_item(tmp_path):
    exam, results = synthetic_run()
    write_session(tmp_path, exam, results, "2026-07-28T09:00:00-04:00", duration_s=6.0)
    md = (tmp_path / "report.md").read_text()

    assert "chords-basic" in md
    assert "2026-07-28T09:00:00-04:00" in md
    lines = [ln for ln in md.splitlines() if "✓" in ln]
    assert len(lines) == 2
    assert "✓ Play a G7 — any voicing (1.00s)" in md
    assert "[2 attempts]" in md
    assert "⏭" in md
    assert "**2/3 passed**" in md
    assert "easy, thumb on G" in md


# ── replay grading of skips ────────────────────────────────────────────────
def test_replay_handles_skipped_items(tmp_path):
    """Skips are reconstructed from the prompt marks + the session's flags."""
    lines = [
        {"kind": "header", "v": 1, "port": "Fake", "started": "2026-07-28T09:00:00-04:00"},
        {"kind": "mark", "t": 0.0, "label": "item:0:prompt"},
        {"kind": "mark", "t": 2.0, "label": "item:0:skipped"},
        {"kind": "mark", "t": 2.0, "label": "item:1:prompt"},
        {"kind": "ev", "t": 3.0, "type": "note_on", "note": 60, "vel": 90, "ch": 0},
        {"kind": "ev", "t": 3.02, "type": "note_on", "note": 64, "vel": 90, "ch": 0},
        {"kind": "ev", "t": 3.04, "type": "note_on", "note": 67, "vel": 90, "ch": 0},
        {"kind": "ev", "t": 4.5, "type": "note_off", "note": 60, "vel": 0, "ch": 0},
        {"kind": "ev", "t": 4.52, "type": "note_off", "note": 64, "vel": 0, "ch": 0},
        {"kind": "ev", "t": 4.54, "type": "note_off", "note": 67, "vel": 0, "ch": 0},
    ]
    (tmp_path / "midi.jsonl").write_text("".join(json.dumps(r) + "\n" for r in lines))
    session = {
        "v": 1, "exam_id": "skips", "exam_sha": "0" * 16,
        "theory_version": THEORY_VERSION, "started": "2026-07-28T09:00:00-04:00",
        "items": [
            {"prompt": "G7", "check": {"chord": "G7", "level": "loose", "debounce_ms": 300},
             "attempts": [], "passed": False, "skipped": True, "latency_s": None, "note": None},
            {"prompt": "C", "check": {"chord": "C", "level": "loose", "debounce_ms": 300},
             "attempts": [], "passed": True, "skipped": False, "latency_s": 1.0, "note": None},
            {"prompt": "F", "check": {"chord": "F", "level": "loose", "debounce_ms": 300},
             "attempts": [], "passed": False, "skipped": True, "latency_s": None, "note": None},
        ],
        "summary": {"passed": 1, "total": 3, "duration_s": 10.0, "mean_latency_s": 1.0},
    }
    (tmp_path / "session.json").write_text(json.dumps(session))

    results = replay_session(tmp_path)
    assert [r.skipped for r in results] == [True, False, True]
    assert [r.passed for r in results] == [False, True, False]
    assert len(results[1].attempts) == 1


# ── promote (CONTRACTS §3) ─────────────────────────────────────────────────
def test_promote_copies_then_refuses_to_clobber(tmp_path):
    replays = tmp_path / "replays"
    dest, changes = promote(FIXTURE, replays_dir=replays)
    assert dest == replays / "synthetic-basics"
    assert (dest / "midi.jsonl").exists() and (dest / "session.json").exists()
    assert changes == []

    with pytest.raises(FileExistsError):
        promote(FIXTURE, replays_dir=replays)

    other, _ = promote(FIXTURE, name="second-take", replays_dir=replays)
    assert other.name == "second-take"


def test_rebless_regrades_and_reports_changed_outcomes(tmp_path):
    replays = tmp_path / "replays"
    dest, _ = promote(FIXTURE, replays_dir=replays)

    # A stale expectation: pretend item 1 used to fail.
    stale = json.loads((dest / "session.json").read_text())
    stale["items"][0]["passed"] = False
    stale["items"][0]["attempts"] = []
    (dest / "session.json").write_text(json.dumps(stale))

    dest, changes = promote(FIXTURE, rebless=True, replays_dir=replays)
    assert len(changes) == 1 and changes[0].startswith("item 1")
    assert "failed (0 attempts) → passed (1 attempts)" in changes[0]
    blessed = json.loads((dest / "session.json").read_text())
    assert blessed["items"][0]["passed"] is True
    assert blessed["summary"]["passed"] == 2

    _, changes = promote(FIXTURE, rebless=True, replays_dir=replays)
    assert changes == []
