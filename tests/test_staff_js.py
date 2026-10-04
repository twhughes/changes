"""The staff renderer is JavaScript, so pytest just drives its node suite.

`music/web/static/staff.js` draws the sight-reading fronts (M10) and the player's
chart view; `staff-cli.mjs` is the seam the deck generator shells out to. Both are
pinned here so a Python-only test run still catches a break. Skipped when node is
not installed — node is a dev convenience, never a runtime dependency.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "music" / "web" / "static"
SUITE = STATIC / "staff.test.mjs"
CLI = STATIC / "staff-cli.mjs"

NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="node is not installed")


def run_cli(job: dict) -> subprocess.CompletedProcess[str]:
    return subprocess.run([NODE, str(CLI)], input=json.dumps(job), capture_output=True,
                          text=True, timeout=60, cwd=ROOT)


def test_renderer_files_exist():
    for path in (STATIC / "staff.js", CLI, SUITE):
        assert path.is_file(), f"missing {path}"


@needs_node
def test_node_suite_passes():
    proc = subprocess.run([NODE, "--test", str(SUITE)], capture_output=True, text=True,
                          timeout=180, cwd=ROOT)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "# fail 0" in proc.stdout or "fail 0" in proc.stdout


@needs_node
def test_cli_renders_a_staff_job():
    proc = run_cli({"kind": "staff", "clef": "treble", "pitches": [64], "key": "C"})
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.startswith("<svg")
    assert proc.stdout.rstrip().endswith("</svg>")
    assert 'class="note"' in proc.stdout


@needs_node
def test_cli_renders_grand_and_leadsheet_jobs():
    grand = run_cli({"kind": "grand", "pitches": [48, 64], "key": "F"})
    assert grand.returncode == 0 and grand.stdout.startswith("<svg")
    assert 'class="brace"' in grand.stdout
    chart = run_cli({"kind": "leadsheet", "bars": [{"chord": "Dm7", "beats": 4}], "width": 400})
    assert chart.returncode == 0 and chart.stdout.startswith("<svg")
    assert "Dm7" in chart.stdout


@needs_node
def test_cli_reports_a_bad_job_on_stderr():
    proc = run_cli({"kind": "nope", "pitches": [60]})
    assert proc.returncode == 2
    assert proc.stdout == ""
    assert json.loads(proc.stderr)["error"]
