"""The Practice tab (CONTRACTS.md §11) has no browser in CI, so node drives it headless.

``music/web/static/practice.check.mjs`` mounts ``views/practice.js`` over
``dom-stub.mjs`` with a fixture menu: it checks the sidebar tree (Review, the deck
groups, Songs → the library page, only the songs being learned, + Add song — the
only numbers are cards due), that a deck mounts the trainer pane with that deck
preselected and a song mounts the song pane, that a running drill selects its owner
(on mount and when one starts elsewhere), that leaving a live drill stops it, the
event-driven refresh, a page dropped on a deck pane, the static page, and the
header's 🧠 review-backend menu. ``trainer.check.mjs`` runs here too.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "music" / "web" / "static"
NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_practice_view_mounts_the_right_pane() -> None:
    check = STATIC / "practice.check.mjs"
    assert check.is_file(), f"missing {check}"
    result = subprocess.run(
        [str(NODE), check.name],
        cwd=STATIC, capture_output=True, text=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok" in result.stdout


def test_practice_view_keeps_its_module_contract() -> None:
    """CONTRACTS.md §5: every view exports id, title and mount(); §11: it composes the
    trainer and songs views rather than re-implementing them."""
    source = (STATIC / "views" / "practice.js").read_text()
    assert 'export const id = "practice"' in source
    assert 'export const title = "Practice"' in source
    assert "export function mount(el, ctx)" in source
    assert 'import * as trainer from "./trainer.js"' in source
    assert 'import * as songs from "./songs.js"' in source
    assert '"/api/practice"' in source
    assert '"music.practice.last"' in source
    for banned in ("alert(", "confirm(", "window.prompt("):
        assert banned not in source


def test_embedded_views_take_options() -> None:
    """trainer.js and songs.js mount standalone or as a Practice pane (opts)."""
    for name in ("trainer.js", "songs.js"):
        source = (STATIC / "views" / name).read_text()
        assert "export function mount(el, ctx, opts = {})" in source, name


def test_header_has_the_review_backend_menu() -> None:
    """CONTRACTS.md §10: the 🧠 selector sits beside 🔈 and rides /api/srs."""
    html = (STATIC / "index.html").read_text()
    main = (STATIC / "main.js").read_text()
    srs = (STATIC / "srs.js").read_text()
    assert 'id="srs-sel"' in html
    assert 'import { mountSrs } from "./srs.js"' in main
    assert 'mountSrs(ctx, document.getElementById("srs-sel"))' in main
    assert '"/api/srs"' in srs and '"/api/srs/backend"' in srs
    for banned in ("alert(", "confirm("):
        assert banned not in srs


def test_header_is_one_view_with_no_logic_button() -> None:
    """2026-10-04: Practice is the only view, so there is no tab bar; Logic is gone; the
    header keeps the brand, 🔈 (S-1 twin by default), 🧠, ⌨ and the keyboard chip."""
    html = (STATIC / "index.html").read_text()
    main = (STATIC / "main.js").read_text()
    css = (STATIC / "style.css").read_text()
    assert "logic-btn" not in html and "logic" not in main.lower()
    assert "tabs.hidden = views.length < 2" in main
    assert ".tabs[hidden] { display: none; }" in css, "author CSS must not undo the hidden tab bar"
    for needed in ('id="sound-sel"', 'id="srs-sel"', 'id="typing-btn"', 'id="port-chip"', 'class="brand"'):
        assert needed in html
    assert "alert(" not in main and "confirm(" not in main, "no dialogs: a refused switch says why in its tooltip"


def _run_check(name: str) -> None:
    check = STATIC / name
    assert check.is_file(), f"missing {check}"
    result = subprocess.run(
        [str(NODE), check.name],
        cwd=STATIC, capture_output=True, text=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok" in result.stdout


# Moved here from tests/test_player_ui.py (the Player view is retired; the trainer pane stays).
@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_trainer_view_draws_a_staff_prompt() -> None:
    _run_check("trainer.check.mjs")


def test_trainer_view_renders_pitch_prompts_as_a_staff() -> None:
    source = (STATIC / "views" / "trainer.js").read_text()
    assert 'import { staffSVG } from "../staff.js"' in source
    assert "showPrompt(m.staff" in source


def test_songs_fold_and_the_trainer_shows_keys() -> None:
    """Round 4: Songs is a group that folds (remembered) and lists every song A–Z — no
    cap, no 'learning' filter; the trainer pane has the song pane's Show keys switch."""
    practice = (STATIC / "views" / "practice.js").read_text()
    trainer = (STATIC / "views" / "trainer.js").read_text()
    assert '"music.practice.songsOpen"' in practice
    assert "LEARNING_MAX" not in practice and "learning()" not in practice
    assert '"music.trainer.showKeys"' in trainer
    assert "light the chord's keys on the piano — a hint; any voicing passes" in trainer
