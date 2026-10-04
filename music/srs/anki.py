"""The Anki backend — the review seam over AnkiConnect (CONTRACTS.md §10).

Themes map to subdecks of ``Music::PianoChords`` (built-ins via ``SUBDECKS``,
songs via their deck source). Anki keeps its own scheduling; this adapter only
lists due cards, adds/updates notes, and presses the ease button. Every call
goes through ``learn/anki.AnkiClient``, which never raises — Anki closed simply
reads as unavailable.
"""

from __future__ import annotations

import threading
import time
from typing import Callable

from music.learn.anki import DEFAULT_DECK, AnkiClient
from music.srs.base import CardSpec, DueCard

PROBE_S = 5.0          # availability/counts are cached this long — status polls are frequent


class AnkiScheduler:
    id = "anki"
    label = "Anki"

    def __init__(self, client: AnkiClient | None, theme_decks: Callable[[], dict[str, str]]) -> None:
        self._client = client
        self.theme_decks = theme_decks
        self._lock = threading.Lock()
        self._up: tuple[float, bool] | None = None

    @property
    def client(self) -> AnkiClient:
        if self._client is None:
            self._client = AnkiClient()
        return self._client

    @property
    def note(self) -> str:
        return "" if self.available() else "Anki is closed (needs the AnkiConnect add-on)"

    def available(self) -> bool:
        with self._lock:
            now = time.monotonic()
            if self._up is None or now - self._up[0] > PROBE_S:
                self._up = (now, self.client.available())
            return self._up[1]

    def _theme_of(self) -> dict[str, str]:
        return {deck: theme for theme, deck in self.theme_decks().items()}

    def due(self, theme: str | None = None) -> list[DueCard]:
        theme_of = self._theme_of()
        cards = [DueCard(str(cid), front, theme_of.get(deck, ""))
                 for cid, front, deck in self.client.due_cards(DEFAULT_DECK)]
        return cards if theme is None else [c for c in cards if c.theme == theme]

    def add(self, theme: str, specs: list[CardSpec],
            key_of: Callable[[str], str] | None = None) -> dict:
        subdeck = self.theme_decks().get(theme)
        if subdeck is None:
            raise ValueError(f"{theme!r} has no Anki subdeck")
        key_of = key_of or (lambda front: front)
        self.client.ensure_deck(subdeck)
        existing = {}
        for note_id, front, back in self.client.notes_in_deck(subdeck) or []:
            existing.setdefault(key_of(front), (note_id, front, back))
        added = updated = unchanged = 0
        new: list[tuple[str, str]] = []
        for spec in specs:
            hit = existing.get(spec.key)
            if hit is None:
                new.append((spec.front, spec.back))
            elif hit[1] == spec.front and hit[2] == spec.back:
                unchanged += 1
            elif self.client.update_note(hit[0], spec.front, spec.back):
                updated += 1
        if new:
            tags = ("piano-chords", "song") if theme.startswith("song:") else ("piano-chords",)
            added = self.client.add_cards(subdeck, new, tags=tags)
        return {"added": added, "updated": updated, "unchanged": unchanged, "total": len(specs)}

    def answer(self, card_id: str, ease: int) -> bool:
        try:
            return self.client.answer(int(card_id), ease)
        except ValueError:
            return False

    def counts(self) -> dict[str, dict]:
        """Cards and due cards per theme — two AnkiConnect calls, whatever the theme count."""
        theme_of = self._theme_of()
        out: dict[str, dict] = {}
        ids = self.client.call("findCards", query=f'deck:"{DEFAULT_DECK}"')
        infos = self.client.call("cardsInfo", cards=list(ids)) if isinstance(ids, list) and ids else []
        for info in infos if isinstance(infos, list) else []:
            theme = theme_of.get(str((info or {}).get("deckName", "")))
            if theme is not None:
                out.setdefault(theme, {"cards": 0, "due": 0})["cards"] += 1
        for card in self.due():
            if card.theme:
                out.setdefault(card.theme, {"cards": 0, "due": 0})["due"] += 1
        return out
