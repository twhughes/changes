"""The regression runner: every promoted session is re-graded on every test run.

Add a fixture with `python -m music.testkit promote sessions/<dir>`; a matcher
change that moves a verdict fails here until it is re-blessed on purpose.
"""

import json
from pathlib import Path

import pytest

from music.testkit.replaygrade import replay_session

REPLAYS = Path(__file__).resolve().parent / "fixtures" / "replays"
FIXTURES = sorted(p for p in REPLAYS.glob("*/") if (p / "session.json").exists())


def test_there_is_at_least_one_fixture():
    assert FIXTURES, f"no replay fixtures under {REPLAYS}"


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda p: p.name)
def test_replay_matches_recorded_verdicts(fixture: Path):
    expected = json.loads((fixture / "session.json").read_text())["items"]
    results = replay_session(fixture)

    assert len(results) == len(expected), (
        f"{fixture.name}: replay produced {len(results)} items, "
        f"session.json records {len(expected)}")

    for i, (exp, got) in enumerate(zip(expected, results), start=1):
        want = (bool(exp["passed"]), len(exp["attempts"]), bool(exp.get("skipped")))
        have = (got.passed, len(got.attempts), got.skipped)
        assert want == have, (
            f"{fixture.name} item {i} ({exp['prompt']} · {exp['check']['chord']} "
            f"@{exp['check'].get('level', 'loose')}): "
            f"recorded passed={want[0]} attempts={want[1]} skipped={want[2]}, "
            f"replay gave passed={have[0]} attempts={have[1]} skipped={have[2]}")
