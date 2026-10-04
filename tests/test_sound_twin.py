"""The S-1 twin as a cockpit sound: the ``twin`` browser driver.

The engine is the S-1 twin's browser code from hq/synth, vendored into
``music/web/static/sound/twin/`` under the hq sharing rule: one canonical home
(``hq/synth/synth/web/static/twin/``), a copy here with a provenance line on each JS
file, and a test that the two still agree byte for byte. ``sound/twin.js`` is the driver
(8 voices, a soft keys patch); ``sound-twin.check.mjs`` runs it in node over a fake
Web Audio that drives the real vendored processor.
"""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from music.sound.registry import BY_ID
from music.sound.service import SoundService
from music.web.server import create_app
from tests.fakes import FakeMidiWorld

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "music" / "web" / "static"
VENDORED = STATIC / "sound" / "twin"
CANON = ROOT.parent / "synth" / "synth" / "web" / "static" / "twin"   # ../synth, when checked out
FILES = ("audio.js", "dsp.js", "fft.js", "fx.js", "rng.js", "worklet.js", "curves.json",
         "schema.json")
NODE = shutil.which("node")


def _vendor_tool():
    """tools/vendor_twin.py, loaded by path (tools/ is not a package)."""
    spec = importlib.util.spec_from_file_location("vendor_twin", ROOT / "tools" / "vendor_twin.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── the driver table ──────────────────────────────────────────────────────────

def test_registry_lists_the_twin_as_a_browser_driver():
    spec = BY_ID["twin"]
    assert spec.label == "S-1 twin"
    assert spec.side == "browser" and spec.create is None
    assert spec.probe() == (True, "")


def test_the_twin_is_offered_beside_the_e_piano_default():
    assert SoundService().driver_id == "samples"       # Tyler: "probably e-piano as default"
    app = create_app(midi_module=FakeMidiWorld())
    c = TestClient(app, base_url="http://localhost:8768")
    st = c.get("/api/sound").json()
    assert st["driver"] == "samples"
    row = next(d for d in st["drivers"] if d["id"] == "twin")
    assert row == {"id": "twin", "label": "S-1 twin", "side": "browser",
                   "available": True, "note": ""}
    seen = []
    app.state.hub.subscribe(seen.append)
    r = c.post("/api/sound/driver", json={"driver": "twin"})
    assert r.status_code == 200 and r.json() == {"driver": "twin"}
    assert {"type": "sound", "driver": "twin"} in seen


def test_the_loader_mounts_the_twin_in_the_browser():
    source = (STATIC / "sound" / "index.js").read_text(encoding="utf-8")
    drivers = re.search(r"BROWSER_DRIVERS = new Set\(\[([^\]]*)\]\)", source)
    assert drivers and '"twin"' in drivers.group(1)
    assert (STATIC / "sound" / "twin.js").is_file()


def test_the_driver_keeps_the_contract_and_loads_only_its_copy():
    source = (STATIC / "sound" / "twin.js").read_text(encoding="utf-8")
    assert "export async function create(ac, out)" in source
    imports = [line for line in source.splitlines() if line.startswith("import ")]
    assert imports == ['import { createTwin } from "./twin/audio.js";']
    assert "/api/" not in source          # works with no server behind it (a static page)


# ── the vendored copy ─────────────────────────────────────────────────────────

def test_vendored_copy_is_complete_and_says_where_the_canon_lives():
    tool = _vendor_tool()
    assert tuple(tool.FILES) == FILES
    for name in FILES:
        path = VENDORED / name
        assert path.is_file(), f"missing {path}"
        if name.endswith(".js"):
            first = path.read_text(encoding="utf-8").splitlines()[0]
            assert first.startswith(f"// Vendored from hq/synth/synth/web/static/twin/{name},"), first
            assert first.encode() + b"\n" == tool.header(name)
    curves = json.loads((VENDORED / "curves.json").read_text(encoding="utf-8"))
    assert {"k_params", "s_params", "curves", "cc_ranges", "sr"} <= set(curves)
    schema = json.loads((VENDORED / "schema.json").read_text(encoding="utf-8"))
    params = [p for s in schema["sections"] for p in s["params"]]
    assert {"OSC", "FILTER"} <= {s["name"] for s in schema["sections"]}
    assert all({"cc", "name", "min", "max", "default"} <= set(p) for p in params)
    ranged = {int(cc) for cc in curves["cc_ranges"]}
    assert {p["cc"] for p in params if p["cc"] in ranged}, "the panel's controls are the twin's CCs"


def test_vendored_js_reaches_nothing_outside_its_folder():
    """The copy is self-contained: every import and every bundled URL is ./ inside sound/twin/."""
    for name in FILES:
        if not name.endswith(".js"):
            continue
        source = (VENDORED / name).read_text(encoding="utf-8")
        targets = re.findall(r"^import .* from '([^']+)';", source, flags=re.M)
        targets += re.findall(r"new URL\('([^']+)', import\.meta\.url\)", source)
        for target in targets:
            assert target.startswith("./"), f"{name} reaches outside: {target}"
            assert (VENDORED / target[2:]).is_file(), f"{name} needs {target}, which is not vendored"


def test_vendored_twin_has_not_drifted_from_the_synth_canon():
    """The copy is the canon plus one provenance line per JS file; if the canon moves, this fails.

    Skipped when the synth project is not checked out beside us (``../synth``): music
    stands alone, the canon is a convenience, not a dependency.
    """
    if not CANON.is_dir():
        pytest.skip(f"synth project not present at {CANON}")
    tool = _vendor_tool()
    stale = []
    for name in FILES:
        canon = tool.source(name).read_bytes()
        copy = (VENDORED / name).read_bytes()
        body = copy.split(b"\n", 1)[1] if name.endswith(".js") else copy
        if body != canon or copy != tool.vendored(name, canon):
            stale.append(name)
    assert not stale, (
        f"the twin drifted from its canon ({', '.join(stale)}) — re-copy with "
        "`python tools/vendor_twin.py` (canon: hq/synth/synth/web/static/twin/)"
    )


# ── the driver, run in node ───────────────────────────────────────────────────

@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_twin_driver_plays_8_voices_end_to_end() -> None:
    check = STATIC / "sound-twin.check.mjs"
    assert check.is_file(), f"missing {check}"
    result = subprocess.run(
        [str(NODE), check.name],
        cwd=STATIC, capture_output=True, text=True, timeout=120, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok" in result.stdout
