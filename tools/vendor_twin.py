"""Re-copy the S-1 twin's browser engine from its canonical home into the cockpit.

    python tools/vendor_twin.py            # copy (after the twin changed in hq/synth)
    python tools/vendor_twin.py --check    # exit 1 if the copy has drifted

The canon is ``hq/synth/synth/web/static/twin/`` (the S-1 twin project, public as s1-twin).
The copy lives in ``music/web/static/sound/twin/`` and plays the cockpit's ``twin`` sound
driver (``music/web/static/sound/twin.js``). Only what the engine needs is copied. Each JS
file gets one provenance line on top and nothing else changes; ``curves.json`` is copied as
is (JSON has no comments). ``tests/test_sound_twin.py`` asserts the two still agree.

One file comes from beside the engine: the S-1's control list, ``core/schema.json`` (every
control's name, section, range, value labels and description), copied as ``schema.json`` —
the cockpit's twin settings panel draws its controls from it.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT.parent / "synth" / "synth" / "web" / "static"
CANON = STATIC / "twin"
DEST = ROOT / "music" / "web" / "static" / "sound" / "twin"
CANON_LABEL = "hq/synth/synth/web/static/twin"
FILES = ("audio.js", "dsp.js", "fft.js", "fx.js", "rng.js", "worklet.js", "curves.json",
         "schema.json")
# Copied name → its canonical file, for the one that does not live in twin/.
SOURCES = {"schema.json": STATIC / "core" / "schema.json"}


def source(name: str) -> Path:
    """Where one copied file's canon lives."""
    return SOURCES.get(name, CANON / name)


def header(name: str) -> bytes:
    """The provenance line a vendored JS file starts with (empty for JSON)."""
    if not name.endswith(".js"):
        return b""
    return (f"// Vendored from {CANON_LABEL}/{name}, the canonical home: edit there, "
            f"then re-copy with tools/vendor_twin.py.\n").encode()


def vendored(name: str, canon: bytes) -> bytes:
    """What the cockpit's copy of one canonical file must be, byte for byte."""
    return header(name) + canon


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="report drift instead of copying")
    args = ap.parse_args(argv)
    if not CANON.is_dir():
        print(f"no canon at {CANON}: check out hq/synth beside hq/music", file=sys.stderr)
        return 2
    drift = []
    DEST.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        want = vendored(name, source(name).read_bytes())
        dst = DEST / name
        if dst.exists() and dst.read_bytes() == want:
            continue
        drift.append(name)
        if not args.check:
            dst.write_bytes(want)
    if args.check:
        print("drifted: " + ", ".join(drift) if drift else "the copy matches the canon")
        return 1 if drift else 0
    print(f"copied {len(drift)} of {len(FILES)} files into {DEST.relative_to(ROOT)}"
          + (f": {', '.join(drift)}" if drift else " (all were current)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
