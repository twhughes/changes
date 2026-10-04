"""Review — the one switch between the built-in scheduler and Anki (CONTRACTS.md §10).

Like the sound drivers: one active backend, chosen in the header's 🧠 menu and
remembered in ``sessions/srs/config.json``. The cockpit works fully on the
built-in one; Anki is a plug-in. Switching never moves cards — each backend
keeps its own.

Themes → Anki subdecks come from ``SUBDECKS`` plus every registered source
(the songs library), so the Anki backend can place and find song cards.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Callable

from music.learn.anki import SUBDECKS, AnkiClient
from music.srs.anki import AnkiScheduler
from music.srs.local import LocalScheduler

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BACKEND = "local"


def default_dir() -> Path:
    return Path(os.environ.get("MUSIC_SRS_DIR", REPO_ROOT / "sessions" / "srs"))


class Review:
    def __init__(self, directory: Path | str | None = None, anki_client: AnkiClient | None = None,
                 clock: Callable[[], datetime] | None = None, backend: str | None = None) -> None:
        self.dir = Path(directory) if directory is not None else default_dir()
        self._sources: list = []
        self.local = LocalScheduler(self.dir / "cards.json", clock=clock)
        self.anki = AnkiScheduler(anki_client, self.theme_decks)
        self.backends = {"local": self.local, "anki": self.anki}
        self.backend_id = backend if backend in self.backends else self._saved() or DEFAULT_BACKEND

    # ── the choice ────────────────────────────────────────────────────────
    def _config(self) -> Path:
        return self.dir / "config.json"

    def _saved(self) -> str | None:
        try:
            choice = json.loads(self._config().read_text(encoding="utf-8")).get("backend")
        except (OSError, ValueError):
            return None
        return choice if choice in self.backends else None

    def set_backend(self, backend_id: str) -> None:
        if backend_id not in self.backends:
            raise KeyError(backend_id)
        self.backend_id = backend_id
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self._config().with_name(".config.json.tmp")
        tmp.write_text(json.dumps({"backend": backend_id}), encoding="utf-8")
        os.replace(tmp, self._config())

    def active(self):
        return self.backends[self.backend_id]

    def status(self) -> dict:
        active = self.active()
        return {"backend": active.id, "label": active.label, "available": active.available(),
                "backends": [{"id": b.id, "label": b.label, "available": b.available(),
                              "note": b.note} for b in self.backends.values()]}

    # ── themes ────────────────────────────────────────────────────────────
    def add_source(self, source) -> None:
        """A deck source whose ``anki_themes()`` names more themes (songs)."""
        self._sources.append(source)

    def theme_decks(self) -> dict[str, str]:
        themes = dict(SUBDECKS)
        for source in self._sources:
            try:
                themes.update(source.anki_themes())
            except Exception:              # a broken source must not hide the built-ins
                pass
        return themes
