"""The S-1 twin's settings panel (``sound/settings.js``) has no browser in CI, so node drives it.

``music/web/static/sound-settings.check.mjs`` mounts the header from the real ``index.html`` over
``dom-stub.mjs``, with the real sound loader and twin driver over a fake Web Audio that runs the real
vendored processor. It checks that the ⚙ shows only while the S-1 twin is the chosen sound; that the
panel's sections and controls come from ``schema.json`` in front-panel order, with CONTROLLER left out;
that a change posts the CC to the twin, plays at once and is saved; that a later twin starts with the
saved changes; Reset; that ✕, Esc and the ⚙ close it; and that it works without storage.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "music" / "web" / "static"
NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_twin_settings_panel_end_to_end() -> None:
    check = STATIC / "sound-settings.check.mjs"
    assert check.is_file(), f"missing {check}"
    result = subprocess.run(
        [str(NODE), check.name],
        cwd=STATIC, capture_output=True, text=True, timeout=120, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok" in result.stdout


def test_header_has_the_settings_button_beside_the_sound_menu() -> None:
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    sound = html.index('id="sound-sel"')
    gear = re.search(r'<button id="twin-btn" hidden[^>]*>⚙</button>', html)
    assert gear and sound < gear.start() < html.index('id="srs-sel"')
    main = (STATIC / "main.js").read_text(encoding="utf-8")
    assert 'import { mountTwinSettings } from "./sound/settings.js";' in main
    assert 'mountTwinSettings(sound, document.getElementById("twin-btn"));' in main


def test_settings_module_needs_no_server_and_no_dialogs() -> None:
    source = (STATIC / "sound" / "settings.js").read_text(encoding="utf-8")
    assert "/api/" not in source               # the static page has the same panel
    for banned in ("alert(", "confirm(", "prompt("):
        assert banned not in source
