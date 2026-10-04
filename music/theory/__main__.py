"""CLI for the theory kernel (M0 acceptance).

  python -m music.theory grade "F#m7b5" 66,69,72,76 [--level strict]
  python -m music.theory name 60,64,67,70
"""

from __future__ import annotations

import argparse
import sys

from music.theory.chords import parse_chord
from music.theory.match import Level, match
from music.theory.naming import name_notes


def _notes(arg: str) -> list[int]:
    return [int(x) for x in arg.replace(" ", "").split(",") if x]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="music.theory")
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("grade", help="grade played notes against a chord symbol")
    g.add_argument("chord")
    g.add_argument("notes", help="comma-separated MIDI note numbers")
    g.add_argument("--level", default="loose", choices=[l.value for l in Level])

    n = sub.add_parser("name", help="name the chord formed by played notes")
    n.add_argument("notes", help="comma-separated MIDI note numbers")

    args = ap.parse_args(argv)
    if args.cmd == "grade":
        v = match(_notes(args.notes), parse_chord(args.chord), Level(args.level))
        print(v.summary)
        if not v.ok:
            print(f"  missing={v.missing} extra={v.extra} bass_ok={v.bass_ok}")
        return 0 if v.ok else 1
    if args.cmd == "name":
        ranked = name_notes(_notes(args.notes))
        if not ranked:
            print("(not enough distinct notes)")
            return 1
        for i, r in enumerate(ranked):
            marker = "→" if i == 0 else " "
            print(f"{marker} {r.name}" + ("" if r.exact else " (+extras)"))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
