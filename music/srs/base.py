"""The review seam's shared shapes (CONTRACTS.md §10).

A scheduler is duck-typed — ``id``, ``label``, ``available()``, ``due(theme)``,
``add(theme, specs, key_of)``, ``answer(card_id, ease)``, ``counts()`` — so the
trainer never knows whether Anki or the built-in scheduler holds the cards.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CardSpec:
    """A card the app wants in review. ``key`` is its identity inside the theme."""
    key: str
    front: str
    back: str = ""


@dataclass(frozen=True)
class DueCard:
    card_id: str       # the backend's id (Anki's card id as text, or the local hash)
    front: str
    theme: str         # "" for a card outside every known theme (legacy Anki cards)


class ReviewUnavailable(RuntimeError):
    """The chosen backend cannot be reached (Anki closed)."""
