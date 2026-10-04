"""The Play landing pane (``views/play.js``) has no browser in CI, so node drives it.

``music/web/static/play.check.mjs`` mounts it over ``dom-stub.mjs`` with a fake ctx: a held
chord is named big, in its root's color, with an exact second reading beside it and never an
inexact one; one or two notes with no name show the notes; the how-to line goes after the
visit's first note; the piano lights what is held and a click sends ``note_in``; unmount drops
every subscription. ``practice.check.mjs`` (tests/test_practice_ui.py) checks that the
Practice tab lists Play first and lands on it when nothing is remembered.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "music" / "web" / "static"
NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_play_pane_end_to_end() -> None:
    check = STATIC / "play.check.mjs"
    assert check.is_file(), f"missing {check}"
    result = subprocess.run(
        [str(NODE), check.name],
        cwd=STATIC, capture_output=True, text=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok" in result.stdout


def test_play_pane_only_listens_and_plays() -> None:
    """No server calls (the static page has the same pane), nothing stored, no dialogs."""
    source = (STATIC / "views" / "play.js").read_text(encoding="utf-8")
    assert 'ctx.on("held", show)' in source
    assert 'ctx.send({ type: "note_in", on, note, vel })' in source
    assert "fetch(" not in source and "/api/" not in source
    assert "localStorage" not in source
    for banned in ("alert(", "confirm(", "prompt("):
        assert banned not in source


def test_practice_lists_play_first() -> None:
    source = (STATIC / "views" / "practice.js").read_text(encoding="utf-8")
    assert 'import * as play from "./play.js";' in source
    assert 'const parts = [item("play", "Play", 0,' in source
