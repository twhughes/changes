"""The songs directory — one folder per song, ``song.txt`` the one source of truth.

CONTRACTS.md §9 layout::

    songs/<id>/song.txt      song text v1
    songs/<id>/page.<ext>    the original page, as imported
    songs/<id>/read/*.png    the raster(s) Claude read
    songs/<id>/import.json   both reads + flags from the last import
    songs/.trash/<id>-<ts>/  where DELETE moves a song

Writes are atomic (temp file + rename) so a crash never leaves half a chart.
``MUSIC_SONGS_DIR`` moves the whole library (tests point it at a tmp dir).
"""

from __future__ import annotations

import json
import os
import shutil
import time
from datetime import datetime
from pathlib import Path

from music.songs.chart import Song, format_cell, parse_song, slugify, written_bars

REPO_ROOT = Path(__file__).resolve().parents[2]
SONG_FILE = "song.txt"
IMPORT_FILE = "import.json"
READ_DIR = "read"
TRASH = ".trash"

PAGE_MIMES: dict[str, str] = {
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
    ".heic": "image/heic", ".heif": "image/heif", ".tif": "image/tiff", ".tiff": "image/tiff",
}


def default_root() -> Path:
    return Path(os.environ.get("MUSIC_SONGS_DIR", REPO_ROOT / "songs"))


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


class SongStore:
    """File I/O for the library. Every method takes a song id (the folder name)."""

    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root) if root is not None else default_root()

    # ── listing ───────────────────────────────────────────────────────────
    def ids(self) -> list[str]:
        if not self.root.is_dir():
            return []
        return sorted(d.name for d in self.root.iterdir()
                      if d.is_dir() and not d.name.startswith(".") and (d / SONG_FILE).is_file())

    def dir(self, song_id: str) -> Path:
        if not song_id or "/" in song_id or song_id.startswith("."):
            raise KeyError(song_id)
        return self.root / song_id

    def exists(self, song_id: str) -> bool:
        try:
            return (self.dir(song_id) / SONG_FILE).is_file()
        except KeyError:
            return False

    # ── the chart ─────────────────────────────────────────────────────────
    def text(self, song_id: str) -> str:
        path = self.dir(song_id) / SONG_FILE
        if not path.is_file():
            raise KeyError(song_id)
        return path.read_text(encoding="utf-8")

    def load(self, song_id: str):
        """(Song, problems). Raises KeyError (no such song) or ChartError (broken file)."""
        return parse_song(self.text(song_id))

    def write_text(self, song_id: str, text: str) -> None:
        _atomic_write(self.dir(song_id) / SONG_FILE, text.encode("utf-8"))

    def updated(self, song_id: str) -> str:
        path = self.dir(song_id) / SONG_FILE
        return datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")

    def new_id(self, title: str) -> str:
        """A free folder name for ``title`` (``very-early``, then ``very-early-2`` …)."""
        base = slugify(title)
        candidate, n = base, 2
        while (self.root / candidate).exists():
            candidate, n = f"{base}-{n}", n + 1
        return candidate

    # ── the page and the import record ────────────────────────────────────
    def page(self, song_id: str) -> Path | None:
        """The original page file, if the song has one."""
        d = self.dir(song_id)
        for path in sorted(d.glob("page.*")):
            if path.suffix.lower() in PAGE_MIMES:
                return path
        return None

    def save_page(self, song_id: str, data: bytes, suffix: str) -> Path:
        d = self.dir(song_id)
        for old in d.glob("page.*"):
            old.unlink()
        path = d / f"page{suffix.lower()}"
        _atomic_write(path, data)
        return path

    def reads(self, song_id: str) -> list[Path]:
        d = self.dir(song_id) / READ_DIR
        return sorted(d.glob("*.png")) if d.is_dir() else []

    def import_record(self, song_id: str) -> dict:
        path = self.dir(song_id) / IMPORT_FILE
        if not path.is_file():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def write_import_record(self, song_id: str, record: dict) -> None:
        _atomic_write(self.dir(song_id) / IMPORT_FILE,
                      json.dumps(record, indent=1, ensure_ascii=False).encode("utf-8"))

    def live_flags(self, song_id: str, song: Song) -> list[dict]:
        """Import flags still standing: a flag lives while its bar reads as it did then."""
        flags = self.import_record(song_id).get("flags") or []
        cells = {addr: format_cell(bar, song.beats_per_bar) for addr, bar in written_bars(song)}
        cells["form"] = " ".join(song.form)        # a form flag lives while the form reads so
        return [{"addr": f["addr"], "message": f.get("message", ""), "other": f.get("other")}
                for f in flags if f.get("addr") in cells and cells[f["addr"]] == f.get("text")]

    def accept_flags(self, song_id: str) -> None:
        """Tyler checked the page and said it looks right: open flags are settled.

        They move to ``accepted_flags`` in the import record — history, not noise.
        """
        record = self.import_record(song_id)
        if record.get("flags"):
            record["accepted_flags"] = record.get("accepted_flags", []) + record["flags"]
            record["flags"] = []
            self.write_import_record(song_id, record)

    # ── deleting ─────────────────────────────────────────────────────────
    def trash(self, song_id: str) -> Path:
        src = self.dir(song_id)
        if not src.is_dir():
            raise KeyError(song_id)
        dest = self.root / TRASH / f"{song_id}-{time.strftime('%Y%m%d-%H%M%S')}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        return dest
