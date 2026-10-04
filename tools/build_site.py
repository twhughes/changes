"""Build the static practice page: the cockpit's own front-end with no server behind it.

    python tools/build_site.py [--out site] [--songs demo-songs]

Copies ``music/web/static/`` (the one front-end; there is no second UI to keep in sync) into
OUT, minus what only makes sense in development (node checks, the DOM stub, the staff CLI) or
next to the server, and marks ``index.html`` with
``<meta name="music-static" content="1">``: main.js then boots ``offline/runtime.js``, which
answers the views' /api/ calls and stands in for the socket (CONTRACTS.md §12).

Everything that needs the Python kernel is computed here, once, into ``OUT/data/``
(web/static_data.py): the views, the Practice menu, every built-in deck as items, the review
cards, and each demo song under all three dials. The sampled e-piano's WAVs (CC-BY, with their
license) go to ``OUT/samples/<set>/``; the e-piano is the default sound when its set is installed.

Only the songs in ``--songs`` ship (default ``demo-songs/``: a public-domain tune and a blues
form). The ``songs/`` library — Tyler's charts and scanned Real Book pages — is refused.

GitHub Pages serves OUT as-is under tylerwhughes.com/<repo>/: every path the page loads is
relative, and ``.nojekyll`` stops Pages from hiding underscore paths.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from music.web import static_data  # noqa: E402

STATIC = ROOT / "music" / "web" / "static"
DEMO_SONGS = ROOT / "demo-songs"
PRIVATE_SONGS = ROOT / "songs"
META = '<meta name="music-static" content="1">'

SKIP_DIRS = {"__pycache__"}
SKIP_FILES = {"dom-stub.mjs", "staff-cli.mjs"}            # development tools
SKIP_SUFFIXES = (".check.mjs", ".test.mjs", ".DS_Store", ".pyc")
REQUIRED = (
    "index.html", "main.js", "ws.js", "style.css", "keyboard.js", "staff.js", "colors.js",
    "typing.js", "srs.js", "sound/index.js", "views/practice.js", "views/trainer.js",
    "views/songs.js", "offline/runtime.js", "offline/api.js",
    "offline/theory.js", "offline/drill.js", "offline/grading.js", "offline/srs.js",
    "offline/trainer.js", "offline/songs.js", "offline/midi.js",
    "data/app.json", "data/decks.json", "data/songs.json",
)


def _twin_ready() -> bool:
    """The S-1 twin sound is installed and the loader knows it (sound/index.js)."""
    loader = STATIC / "sound" / "index.js"
    return (STATIC / "sound" / "twin.js").is_file() and loader.is_file() \
        and '"twin"' in loader.read_text(encoding="utf-8")


def _sample_set() -> Path | None:
    from music.sound.samples_api import _set_dir
    return _set_dir()


def sound_plan() -> dict:
    """The page's 🔈 menu: the browser drivers, in the registry's order; the e-piano is the default."""
    from music.sound.registry import DRIVERS
    samples = _sample_set()
    twin = _twin_ready()
    drivers = []
    for spec in DRIVERS:
        if spec.side != "browser" or (spec.id == "twin" and not twin):
            continue
        row = {"id": spec.id, "label": spec.label, "side": "browser", "available": True, "note": ""}
        if spec.id == "samples" and samples is None:
            row.update(available=False, note="no sample set in this build")
        drivers.append(row)
    default = "samples" if samples is not None else "twin" if twin else "off"
    return {"default": default, "drivers": drivers,
            "samples": f"samples/{samples.name}/" if samples is not None else None}


def _copy_samples(out: Path, set_dir: Path) -> list[str]:
    """The set's manifest, its license, and every WAV the manifest names — nothing else."""
    manifest = json.loads((set_dir / "manifest.json").read_text(encoding="utf-8"))
    names = ["manifest.json", "LICENSE.txt", *sorted({s["file"] for s in manifest.get("samples", [])})]
    copied = []
    for name in names:
        src = set_dir / name
        if not src.is_file():
            if name == "LICENSE.txt":
                continue
            raise SystemExit(f"the sample set names {name}, which is missing")
        rel = f"samples/{set_dir.name}/{name}"
        (out / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, out / rel)
        copied.append(rel)
    return copied


def _mark(index: Path) -> None:
    html = index.read_text(encoding="utf-8")
    if META not in html:
        m = re.search(r"<head>[ \t]*\n([ \t]*)", html)
        if not m:
            raise SystemExit("index.html has no <head> line to mark")
        html = html[:m.end(0)] + META + "\n" + m.group(1) + html[m.end(0):]
    if re.search(r"""(?:src|href)=["']/""", html):
        raise SystemExit("index.html loads an absolute path; Pages serves the page under /<repo>/")
    index.write_text(html, encoding="utf-8")


def build(out: Path, songs: Path = DEMO_SONGS) -> list[str]:
    """Write the static page into ``out`` (replacing it) and return the paths written."""
    songs = Path(songs).resolve()
    if songs == PRIVATE_SONGS.resolve() or PRIVATE_SONGS.resolve() in songs.parents:
        raise SystemExit("songs/ is the private library (scanned pages): build from demo-songs/")
    song_files = sorted(songs.glob("*.txt"))
    if not song_files:
        raise SystemExit(f"no song files (*.txt) in {songs}")
    if out.exists():
        shutil.rmtree(out)
    copied: list[str] = []
    for src in sorted(STATIC.rglob("*")):
        rel = src.relative_to(STATIC).as_posix()
        if src.is_dir() or SKIP_DIRS & set(rel.split("/")):
            continue
        if rel in SKIP_FILES or rel.endswith(SKIP_SUFFIXES):
            continue
        dst = out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied.append(rel)
    _mark(out / "index.html")

    sound = sound_plan()
    set_dir = _sample_set()
    if set_dir is not None:
        copied += _copy_samples(out, set_dir)
    copied += [f"data/{rel}" for rel in static_data.write_data(out / "data", song_files, sound)]
    (out / ".nojekyll").write_text("", encoding="utf-8")
    copied.append(".nojekyll")

    missing = [r for r in REQUIRED if not (out / r).exists()]
    if missing:
        raise SystemExit(f"the page would be broken, missing: {', '.join(missing)}")
    return copied


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=ROOT / "site", help="output directory (default: site/)")
    ap.add_argument("--songs", type=Path, default=DEMO_SONGS,
                    help="song text files to ship (default: demo-songs/)")
    args = ap.parse_args(argv)
    copied = build(args.out, args.songs)
    size = sum(p.stat().st_size for p in args.out.rglob("*") if p.is_file())
    print(f"built {len(copied)} files ({size / 1e6:.1f} MB) into {args.out}")


if __name__ == "__main__":
    main()
