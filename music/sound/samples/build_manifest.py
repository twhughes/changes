#!/usr/bin/env python3
"""Derive a sample-set ``manifest.json`` from the SFZ the pack ships.

The browser ``samples`` driver (web/static/sound/samples.js) does not read SFZ
— it reads a flat ``manifest.json``: for each velocity-layered, key-rooted zone
one entry ``{file, note, vel_lo, vel_hi, tune_cents, gain_db, loop}``. This
script parses an SFZ (``<group>`` velocity bands + ``<region>`` rooted zones),
expands ``#define`` macros and ``default_path``, and writes that manifest, with
each sample pointed at its converted WAV under ``wav/``.

Usage::

    python build_manifest.py <set-dir> [--sfz NAME.sfz] [--name NAME] \
        [--license TEXT] [--source URL] [--release 0.4] [--wav-subdir wav]

``<set-dir>`` is a directory under ``music/sound/samples/`` that holds the SFZ
and a ``wav/`` subdir of converted samples. Re-run it any time the WAVs or SFZ
change — it is the one authority on how the manifest is built.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def _strip_comments(text: str) -> str:
    # SFZ line comments start with //. There are no /* */ blocks in these files.
    return "\n".join(line.split("//", 1)[0] for line in text.splitlines())


def _expand_defines(text: str) -> str:
    """Apply ``#define $NAME value`` substitutions, longest name first."""
    defines: dict[str, str] = {}
    for m in re.finditer(r"#define\s+(\$\w+)\s+(\S+)", text):
        defines[m.group(1)] = m.group(2)
    # Drop the #define lines themselves, then substitute.
    text = re.sub(r"#define\s+\$\w+\s+\S+", "", text)
    for name in sorted(defines, key=len, reverse=True):
        text = text.replace(name, defines[name])
    return text


def _opcodes(chunk: str) -> dict[str, str]:
    """Parse ``key=value`` opcodes from one header's text (values are single tokens)."""
    out: dict[str, str] = {}
    for m in re.finditer(r"(\w+)=([^\s]+)", chunk):
        out[m.group(1)] = m.group(2)
    return out


def parse_sfz(sfz_path: Path, wav_subdir: str) -> list[dict]:
    """Return one manifest sample entry per ``<region>``.

    Velocity range (``lovel``/``hivel``) is inherited from the enclosing
    ``<group>``; ``pitch_keycenter`` is the MIDI root; ``tune`` (cents) and
    ``volume`` (dB) ride along per region when present.
    """
    text = _expand_defines(_strip_comments(sfz_path.read_text()))
    # Split into headers keeping order: <control> <global> <group> <region> ...
    parts = re.split(r"<(\w+)>", text)
    # parts = [pre, tag1, body1, tag2, body2, ...]
    group_vel = (1, 127)
    samples: list[dict] = []
    for i in range(1, len(parts), 2):
        tag = parts[i]
        body = parts[i + 1] if i + 1 < len(parts) else ""
        op = _opcodes(body)
        if tag == "group":
            group_vel = (int(op.get("lovel", 1)), int(op.get("hivel", 127)))
        elif tag == "region":
            sample = op.get("sample")
            if not sample:
                continue
            root = int(op["pitch_keycenter"])
            lovel = int(op.get("lovel", group_vel[0]))
            hivel = int(op.get("hivel", group_vel[1]))
            stem = Path(sample).stem
            entry = {
                "file": f"{wav_subdir}/{stem}.wav",
                "note": root,
                "vel_lo": lovel,
                "vel_hi": hivel,
                "tune_cents": int(op.get("tune", 0)),
                "gain_db": float(op["volume"]) if "volume" in op else 0.0,
                "loop": None,
            }
            samples.append(entry)
    return samples


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("set_dir", type=Path)
    ap.add_argument("--sfz", default=None, help="SFZ filename inside set_dir (default: the one *.sfz)")
    ap.add_argument("--name", default=None)
    ap.add_argument("--license", default="")
    ap.add_argument("--source", default="")
    ap.add_argument("--release", type=float, default=0.4)
    ap.add_argument("--wav-subdir", default="wav")
    args = ap.parse_args(argv)

    set_dir: Path = args.set_dir
    if args.sfz:
        sfz = set_dir / args.sfz
    else:
        found = sorted(set_dir.glob("*.sfz"))
        if not found:
            raise SystemExit(f"no .sfz in {set_dir}")
        sfz = found[0]

    samples = parse_sfz(sfz, args.wav_subdir)
    # Sanity: every referenced WAV must exist on disk.
    missing = [s["file"] for s in samples if not (set_dir / s["file"]).is_file()]
    if missing:
        raise SystemExit(f"missing WAVs: {sorted(set(missing))}")

    manifest = {
        "name": args.name or set_dir.name,
        "license": args.license,
        "source": args.source,
        "samples": samples,
        "release_s": args.release,
    }
    out = set_dir / "manifest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {out} — {len(samples)} zones from {sfz.name}")


if __name__ == "__main__":
    main()
