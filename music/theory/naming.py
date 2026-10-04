"""Logic-style chord naming: you play notes, we say what they are."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from music.theory.chords import QUALITIES
from music.theory.pitch import pc_name

# Commonness bonus — breaks ties toward the names a musician would actually say.
_COMMONNESS = {
    "": 10, "m": 10, "7": 9, "m7": 9, "maj7": 8, "6": 6, "m6": 5, "dim": 5,
    "sus4": 5, "sus2": 5, "m7b5": 5, "dim7": 5, "aug": 4, "9": 4, "add9": 4,
    "maj9": 3, "m9": 3, "7sus4": 3, "mMaj7": 2, "5": 2,
    "11": 1, "13": 1, "7b9": 1, "7#9": 1, "7b5": 1, "7#5": 1,
}


@dataclass(frozen=True)
class RankedName:
    name: str          # e.g. "Am7/C"
    root_pc: int
    quality: str
    score: float
    exact: bool        # played pcs == chord pcs exactly


def name_notes(midi_notes: Iterable[int], top: int = 3) -> list[RankedName]:
    """Rank plausible chord names for the played notes (empty list if < 2 pcs)."""
    notes = sorted(set(int(n) for n in midi_notes))
    pcs = {n % 12 for n in notes}
    if len(pcs) < 2:
        return []
    bass_pc = notes[0] % 12

    ranked: list[RankedName] = []
    for root in sorted(pcs):
        rel = frozenset((pc - root) % 12 for pc in pcs)
        for quality, ivs in QUALITIES.items():
            if not ivs <= rel:
                continue  # every chord tone must be present to claim the name
            extras = len(rel - ivs)
            exact = extras == 0
            score = (
                len(ivs) * 10          # bigger explained set wins
                - extras * 12          # unexplained notes hurt more
                + (8 if exact else 0)
                + (6 if root == bass_pc else 0)   # root position reads best
                + _COMMONNESS.get(quality, 0)
            )
            name = pc_name(root) + quality
            if root != bass_pc:
                name += "/" + pc_name(bass_pc)
            ranked.append(RankedName(name, root, quality, score, exact))

    ranked.sort(key=lambda r: (-r.score, r.root_pc))
    # One name per (root, quality is already unique); dedupe identical names.
    seen: set[str] = set()
    out = []
    for r in ranked:
        if r.name not in seen:
            seen.add(r.name)
            out.append(r)
    return out[:top]
