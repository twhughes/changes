"""The static page (CONTRACTS.md §12): one front-end, a JS twin held to the Python, no server.

``tools/build_site.py`` builds the page; ``tools/static_vectors.py`` writes golden vectors from
the Python authority (matcher, match_pitches, naming, grade policy, SM-2, DrillEngine, whole
trainer + songs sessions); ``offline/parity.check.mjs`` replays them through the JS twin and
``offline/runtime.check.mjs`` drives the runtime and the real views over the built data.
Every run regenerates the vectors, so a Python change the twin does not follow fails here.
"""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "music" / "web" / "static"
OFFLINE = STATIC / "offline"
NODE = shutil.which("node")


def _tool(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def site(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("page") / "site"
    _tool("build_site").build(out)
    return out


# ── parity: the twin answers what the Python answers ────────────────────────
@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_js_twin_matches_the_python_vectors(tmp_path) -> None:
    vectors = _tool("static_vectors")
    data = vectors.generate()
    counts = vectors.counts(data)
    # Enough cases that a drift cannot hide: every family is exercised in bulk.
    assert counts["match"] > 5000 and counts["pitches"] > 1000 and counts["naming"] > 500
    assert counts["grading"] >= 1000 and counts["srs"] > 500 and counts["drill"] > 1000
    assert counts["service"] > 2000 and counts["fronts"] > 40
    names = {s["name"] for s in data["service"]}
    assert {"triads", "review", "songs", "blues", "errors", "arming", "new-progressions"} <= names
    path = tmp_path / "vectors.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    result = subprocess.run([NODE, "offline/parity.check.mjs", str(path)], cwd=STATIC,
                            capture_output=True, text=True, timeout=120, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "parity.check.mjs: ok" in result.stdout


def test_vectors_are_reproducible() -> None:
    vectors = _tool("static_vectors")
    a, b = vectors.generate(seed=7), vectors.generate(seed=7)
    for key in ("match", "pitches", "naming", "grading", "srs", "drill"):
        assert a[key] == b[key], key


# ── the build ───────────────────────────────────────────────────────────────
def test_build_marks_static_and_ships_the_runtime_and_its_data(site: Path) -> None:
    html = (site / "index.html").read_text(encoding="utf-8")
    assert html.count('<meta name="music-static" content="1">') == 1
    assert html.index("music-static") < html.index("</head>")
    assert (site / ".nojekyll").exists()
    for rel in ("main.js", "offline/runtime.js", "offline/theory.js", "offline/drill.js", "offline/srs.js",
                "offline/trainer.js", "offline/songs.js", "offline/api.js", "offline/midi.js",
                "data/app.json", "data/decks.json", "data/songs.json"):
        assert (site / rel).is_file(), rel
    app = json.loads((site / "data" / "app.json").read_text(encoding="utf-8"))
    assert [v["id"] for v in app["views"]] == ["practice"]          # one view (§11 v2)
    decks = json.loads((site / "data" / "decks.json").read_text(encoding="utf-8"))
    assert list(decks["decks"]) == ["triads", "sevenths", "advanced", "two-five-one",
                                    "minor-two-five-one", "turnaround", "tritone-sub",
                                    "backdoor"]                           # the menu, nothing else
    assert set(decks["cards"]) == set(decks["seedable"])
    for front in (c["front"] for cards in decks["cards"].values() for c in cards):
        assert front in decks["fronts"], front
    index = json.loads((site / "data" / "songs.json").read_text(encoding="utf-8"))
    assert [row["id"] for row in index] == ["i-got-rhythm", "jazz-blues-in-f"]
    song = json.loads((site / "data" / "songs" / "i-got-rhythm.json").read_text(encoding="utf-8"))
    assert set(song["dials"]) == {"core", "written", "triads"}
    core = song["dials"]["core"]
    assert core["song"]["sections"] and core["cards"] and core["items"]["phrases"]
    assert all(p["item"]["recall"] for p in core["items"]["phrases"])


def test_build_leaves_out_dev_files_and_server_only_views(site: Path) -> None:
    shipped = [p.relative_to(site).as_posix() for p in site.rglob("*") if p.is_file()]
    assert not [p for p in shipped if p.endswith((".check.mjs", ".test.mjs"))]
    assert not [p for p in shipped if "__pycache__" in p or p.endswith(".pyc")]
    for rel in ("dom-stub.mjs", "staff-cli.mjs", "views/player.js", "views/panel.js",
                "views/lessons.js", "views/lessons-ref.js"):
        assert rel not in shipped, rel
    assert not [p for p in shipped if p.startswith("songs/") or p.endswith((".png", ".pdf", ".heic"))], \
        "no scanned pages on the page"


def test_every_path_the_page_loads_is_relative(site: Path) -> None:
    """Pages serves the site under /<repo>/: nothing may reach for the domain root but /api/."""
    html = (site / "index.html").read_text(encoding="utf-8")
    assert not re.search(r"""(?:src|href)=["']/""", html)
    literal = re.compile(r"""(["'`])(/[A-Za-z][\w\-./${}]*)\1""")      # a whole "/path" string
    for js in site.rglob("*.js"):
        for _, path in literal.findall(js.read_text(encoding="utf-8")):
            assert path.startswith(("/api/", "/ws/")), f"{js.relative_to(site)} loads {path}"


def test_the_sampled_piano_ships_with_its_license(site: Path) -> None:
    app = json.loads((site / "data" / "app.json").read_text(encoding="utf-8"))
    base = site / app["sound"]["samples"]
    manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
    assert (base / "LICENSE.txt").is_file()
    for sample in manifest["samples"]:
        assert (base / sample["file"]).is_file(), sample["file"]
    ids = [d["id"] for d in app["sound"]["drivers"]]
    assert "fluid" not in ids and "logic" not in ids, "server and external drivers stay local"
    assert app["sound"]["default"] in ids


def test_build_refuses_the_private_songs_library(tmp_path) -> None:
    with pytest.raises(SystemExit, match="private library"):
        _tool("build_site").build(tmp_path / "site", songs=ROOT / "songs")


def test_build_is_repeatable(tmp_path) -> None:
    build = _tool("build_site").build
    out = tmp_path / "site"
    assert sorted(build(out)) == sorted(build(out))
    assert (out / "index.html").read_text(encoding="utf-8").count("music-static") == 1


# ── the runtime over the built data, and the views on it ────────────────────
@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_runtime_and_views_work_on_the_built_page(site: Path) -> None:
    result = subprocess.run([NODE, "offline/runtime.check.mjs", str(site)], cwd=STATIC,
                            capture_output=True, text=True, timeout=120, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "runtime.check.mjs: ok" in result.stdout


# ── the server path is untouched ────────────────────────────────────────────
def test_the_cockpit_page_has_no_static_flag_and_boots_the_socket() -> None:
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    main = (STATIC / "main.js").read_text(encoding="utf-8")
    assert "music-static" not in html, "only the build marks a page static"
    assert 'document.querySelector(\'meta[name="music-static"]\')' in main
    assert "ws = connect();" in main
    assert 'import("./offline/runtime.js")' in main, "the runtime loads only on the static page"
    for name in ("trainer.js", "practice.js"):
        assert "offline/" not in (STATIC / "views" / name).read_text(encoding="utf-8"), name


def test_the_offline_twin_never_parses_a_chord_symbol() -> None:
    """The page carries precomputed chords (web/static_data.py): no parser, no quality table."""
    for js in OFFLINE.glob("*.js"):
        code = "\n".join(line.split("//")[0] for line in js.read_text(encoding="utf-8").splitlines())
        assert "parse_chord" not in code and "QUALITIES" not in code, js.name
        assert 'fetch("/api' not in code and "fetch('/api" not in code, js.name
