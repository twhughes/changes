"""The Songs view (CONTRACTS.md §9) has no browser in CI, so node drives it headless.

``music/web/static/songs.check.mjs`` mounts ``views/songs.js`` over ``dom-stub.mjs``,
a fake server and a fake ctx, then walks the whole flow: import (Add, drop, paste,
progress rows) → the onboarding stepper (check the page → add to review → practice)
→ the chart and the dial → Chords / Phrases / Play through over the trainer's
messages (show-keys hints, Blind, recall hiding, cues, misses, receipts, foreign
events ignored) → the check screen's one-cell PUTs and Sections & form editor →
delete → the embedded Practice pane → a mid-drill resume. This wrapper keeps that
check inside ``pytest``.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "music" / "web" / "static"
VIEW = STATIC / "views" / "songs.js"
NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_songs_view_walks_import_drill_and_check() -> None:
    check = STATIC / "songs.check.mjs"
    assert check.is_file(), f"missing {check}"
    result = subprocess.run(
        [str(NODE), check.name],
        cwd=STATIC, capture_output=True, text=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok" in result.stdout


def test_songs_view_keeps_its_module_contract() -> None:
    """CONTRACTS.md §5: every view exports id, title and mount()."""
    source = VIEW.read_text()
    assert 'export const id = "songs"' in source
    assert 'export const title = "Songs"' in source
    assert "export function mount(el, ctx, opts = {})" in source
    assert 'style.id = "songs-css"' in source


def test_songs_view_renders_and_never_grades() -> None:
    """The matcher lives in theory/ only (CONTRACTS.md layer rules): the view may
    import the shared piano, palette and chordRootPc — nothing that reads chords."""
    source = VIEW.read_text()
    imports = sorted(line for line in source.splitlines() if line.startswith("import "))
    assert imports == [
        'import { chordRootPc } from "../staff.js";',
        'import { makePiano } from "../keyboard.js";',
        'import { rgbOf, css } from "../colors.js";',
    ]
    # No dialogs, ever — every message is inline.
    for banned in ("alert(", "confirm(", "window.prompt("):
        assert banned not in source
    # The drill rides the trainer's own messages (§9 "WS additions").
    for message in ('{ type: "start", deck }', '{ type: "skip" }', '{ type: "stop" }'):
        assert message in source


def test_play_through_replaces_the_run_and_its_fade() -> None:
    """Round 2 (2026-10-03): Play through, Show keys and Blind; no fade slider."""
    source = VIEW.read_text()
    assert '["play", "Play through"]' in source
    assert "Run-through" not in source
    assert 'type: "range"' not in source, "the 4-level fade slider is gone"
    assert "piano.setHint(" in source
    keyboard = (STATIC / "keyboard.js").read_text()
    assert "setHint(notes)" in keyboard and "setHeld(notes)" in keyboard and "flash(perNote)" in keyboard


def test_lead_visual_fixes_stay_in_the_view() -> None:
    """Fixes from the lead's headless-Chrome looks (2026-10-03) — a rewrite dropped them once.

    The darkest roots get a halo (never a lighter color: brightness = sharp), the scan fits its
    panel so the ending is visible, long bar cells get room, flag chips wrap.
    """
    source = (STATIC / "views" / "songs.js").read_text()
    assert "function tintChord(" in source and "textShadow" in source
    assert "object-fit: contain" in source and 'classList.toggle("zoom")' in source
    assert "flexGrow = String(Math.max(6" in source
    assert "overflow-wrap: anywhere" in source


def test_every_element_earns_its_place() -> None:
    """2026-10-04 (Tyler: "dont add stuff if it's not relevant to user"): the Practice
    sidebar is the list of songs, so "+ Add song" is an import page with no list and no
    search; the song screen has no 'as written' switch, no streak, no counters — the
    only numbers are cards due and bars to fix."""
    source = VIEW.read_text()
    assert "sg-search" not in source and "sg-row" not in source, "no song list or search in the view"
    assert 'text: "as written"' not in source and "writtenBox" not in source, "no 'as written' switch"
    assert "streak" not in source
    assert "sg-how" not in source and "sg-cmeta" not in source
    assert "All songs" not in source
    # The Practice tab is the only host: no standalone frame, back link or remembered song.
    assert "sg-host" not in source and "← Songs" not in source and "music.songs.last" not in source


def test_chord_names_have_one_spelling_rule() -> None:
    """Real flats and sharps (Dbm7b5 → D♭m7♭5): one rule, in songs.js, shared by the trainer."""
    source = VIEW.read_text()
    trainer = (STATIC / "views" / "trainer.js").read_text()
    assert "export const pretty = " in source and "export const prettyWords = " in source
    assert 'import { pretty, prettyWords } from "./songs.js"' in trainer
