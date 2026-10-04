"""Review seam — spaced repetition with or without Anki (CONTRACTS.md §10).

``Review`` holds the active backend: ``local`` (the built-in SM-2 scheduler,
default) or ``anki`` (AnkiConnect). Layer: learning.
"""

from music.srs.base import CardSpec, DueCard, ReviewUnavailable
from music.srs.review import Review

__all__ = ["CardSpec", "DueCard", "Review", "ReviewUnavailable"]
