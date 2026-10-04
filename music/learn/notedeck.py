"""Note-flash deck generator (PLAN M10b) — a sight-reading Anki deck as FILES.

    python -m music.learn.notedeck --deck reading-treble --out sessions/decks/reading-treble/

writes, for every item of a reading deck:

    fronts/<deck>-<n>.svg      the staff image (rendered by web/static/staff-cli.mjs
                               under node — ONE renderer, shared with the cockpit)
    cards.tsv                  Anki import: Front <TAB> Back <TAB> Tags
    manifest.json              what was written, and the codec Front per card
    README.md                  the three manual import steps

Deliberately NO AnkiConnect: Tyler's ``Music::PianoChords`` is 18k cards, and a
generator that writes straight into it is the 2026-08-08 dojo bug waiting to
happen. He imports the TSV himself (File → Import) and copies the SVGs into
Anki's ``collection.media`` — three steps, all his.

Each Front is ``<img src="…">`` plus the codec text in a hidden span, so
``learn/anki._plain`` (which strips tags) still hands the trainer ``"E4 treble"``
and ``item_for_front`` decodes it: the imported cards drill in the cockpit
exactly like seeded chord cards.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from music.learn.reading import reading_decks, reading_fronts
from music.theory.pitch import note_name

_STATIC = Path(__file__).resolve().parents[1] / "web" / "static"
DEFAULT_CLI = _STATIC / "staff-cli.mjs"
FRONT_W, FRONT_H = 360, 180


class RenderError(RuntimeError):
    """node or the staff CLI is missing or refused a job."""


def staff_cli() -> Path:
    """The renderer CLI (env ``MUSIC_STAFF_CLI`` overrides — tests point it at a stub)."""
    return Path(os.environ.get("MUSIC_STAFF_CLI") or DEFAULT_CLI)


def render_svg(job: dict, cli: Path | None = None, node: str | None = None) -> str:
    """One staff job → SVG text via ``node staff-cli.mjs``. Raises RenderError."""
    cli = cli or staff_cli()
    node = node or shutil.which("node")
    if node is None:
        raise RenderError("node is not on PATH — the staff renderer runs under node")
    if not cli.is_file():
        raise RenderError(f"staff CLI missing: {cli}")
    proc = subprocess.run([node, str(cli)], input=json.dumps(job), text=True,
                          capture_output=True)
    if proc.returncode != 0 or not proc.stdout.lstrip().startswith("<svg"):
        raise RenderError(f"staff CLI failed ({proc.returncode}): {proc.stderr.strip()[:300]}")
    return proc.stdout


def card_rows(deck: str) -> list[dict]:
    """The deck as flat card rows: {n, front_codec, back, staff (job or None), tags}."""
    items = reading_decks()[deck]
    fronts = reading_fronts(deck)
    rows = []
    for n, (item, front) in enumerate(zip(items, fronts), start=1):
        if item.is_pitch:
            job = {"kind": "grand" if item.clef == "grand" else "staff",
                   "clef": item.clef, "pitches": list(item.pitches), "key": "C",
                   "width": FRONT_W, "height": FRONT_H}
            back = " + ".join(note_name(p) for p in item.pitches)
        else:                       # reading-chords: the symbol is the card, no staff
            job = None
            back = item.chord.text
        rows.append({"n": n, "front_codec": front, "back": back, "staff": job,
                     "tags": f"music::reading {deck}"})
    return rows


def _tsv_escape(text: str) -> str:
    return text.replace("\t", " ").replace("\n", " ")


def generate(deck: str, out: Path, cli: Path | None = None, node: str | None = None) -> dict:
    """Write the deck under ``out``; returns the manifest dict. Raises RenderError."""
    if deck not in reading_decks():
        raise KeyError(deck)
    out = Path(out)
    fronts_dir = out / "fronts"
    fronts_dir.mkdir(parents=True, exist_ok=True)
    rows = card_rows(deck)
    cards = []
    lines = []
    for row in rows:
        if row["staff"] is not None:
            name = f"{deck}-{row['n']:03d}.svg"
            (fronts_dir / name).write_text(render_svg(row["staff"], cli, node), encoding="utf-8")
            front_html = (f'<img src="{name}">'
                          f'<span class="codec" style="display:none">{row["front_codec"]}</span>')
        else:
            name = None
            front_html = row["front_codec"]
        lines.append("\t".join(_tsv_escape(s) for s in (front_html, row["back"], row["tags"])))
        cards.append({"n": row["n"], "front": row["front_codec"], "back": row["back"],
                      "svg": name})
    (out / "cards.tsv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    manifest = {"v": 1, "deck": deck, "cards": len(cards), "front_size": [FRONT_W, FRONT_H],
                "renderer": str(cli or staff_cli()), "items": cards}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    (out / "README.md").write_text(_readme(deck, len(cards)), encoding="utf-8")
    return manifest


def _readme(deck: str, n: int) -> str:
    return f"""# {deck} — {n} note-flash cards (generated, not yet in Anki)

Nothing here touched Anki. To import (about 2 minutes):

1. Copy every file in `fronts/` into Anki's media folder
   (`~/Library/Application Support/Anki2/<profile>/collection.media/`).
2. Anki → File → Import → `cards.tsv`. Note type **Basic**, deck
   `Music::PianoChords::{deck}`, fields Front / Back / Tags, "Allow HTML in fields" ON.
3. Open the cockpit (`music`) → Trainer → the `anki-due` session now serves these
   cards; play the note on the staff and the matcher grades it (exact octave).

Re-running the generator rewrites these files; Anki de-duplicates on Front.
"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="notedeck", description=__doc__.split("\n\n")[0])
    parser.add_argument("--deck", required=True, choices=sorted(reading_decks()))
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true",
                        help="print the card rows, render and write nothing")
    args = parser.parse_args(argv)
    if args.dry_run:
        for row in card_rows(args.deck):
            print(f"{row['n']:3d}  {row['front_codec']:<18} → {row['back']}")
        return 0
    try:
        manifest = generate(args.deck, args.out)
    except RenderError as e:
        print(f"notedeck: {e}", file=sys.stderr)
        return 2
    print(f"wrote {manifest['cards']} cards → {args.out}  (see README.md to import)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
