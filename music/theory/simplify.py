"""The grading dial — what a song asks you to play (CONTRACTS.md §9).

A Real Book chart writes ``B7b9`` and ``A7b5(b9)``; Tyler wants to learn the
changes, not be failed for skipping a ♭9. ``simplify`` maps a written chord to
the chord the drill asks for:

* ``written`` — the symbol as written (tensions graded).
* ``core``    — root + chord type: maj7 / 7 / m7 / m7b5 / dim7 / mMaj7 / sus,
  plain triads for 6ths and add9s. Tensions, altered 5ths and slash basses drop.
* ``triads``  — root + major / minor / dim / aug / sus.

The type is read off the interval set, not the quality name, so every spelling
the parser accepts lands in a family. Song items grade loose, so playing the
♭9 on a ``core`` B7 still passes — the dial sets what is *required*.
"""

from __future__ import annotations

import re

from music.theory.chords import ChordSymbol, parse_chord

DIALS: tuple[str, ...] = ("core", "written", "triads")

_TRIAD = {
    "": "", "7": "", "maj7": "", "aug": "aug",
    "m": "m", "m7": "m", "mMaj7": "m",
    "dim": "dim", "dim7": "dim", "m7b5": "dim",
    "sus4": "sus4", "7sus4": "sus4", "sus2": "sus2", "5": "5",
}

# Minor family written the Real Book way ("E-9") keeps its dash.
_DASH = {"m": "-", "m7": "-7", "mMaj7": "-maj7", "m7b5": "-7b5"}

_ROOT_RE = re.compile(r"^\s*([A-G](?:##|bb|[#♯b♭])?)(.*)$")


def core_quality(intervals: frozenset[int]) -> str:
    """The chord type of an interval set: '', 'm', '7', 'maj7', 'm7', 'm7b5', …"""
    if 4 in intervals:            # major 3rd (a 3 beside it is a #9, not a minor 3rd)
        third = 4
    elif 3 in intervals:
        third = 3
    else:
        third = None
    seventh = 10 if 10 in intervals else 11 if 11 in intervals else None
    if third == 3:
        if 6 in intervals and 7 not in intervals:     # diminished 5th
            if seventh == 10:
                return "m7b5"
            if seventh is None and 9 in intervals:
                return "dim7"
            return "dim"
        if seventh == 11:
            return "mMaj7"
        return "m7" if seventh == 10 else "m"
    if third == 4:
        if seventh == 10:
            return "7"
        if seventh == 11:
            return "maj7"
        if 8 in intervals and 7 not in intervals:
            return "aug"
        return ""
    if 5 in intervals:
        return "7sus4" if seventh == 10 else "sus4"
    if 2 in intervals:
        return "sus2"
    return "5"


def simplify(chord: ChordSymbol, dial: str = "core") -> ChordSymbol:
    """The chord a song drill asks for under ``dial``. Raises ValueError on an unknown dial."""
    if dial not in DIALS:
        raise ValueError(f"unknown dial {dial!r} (want one of {', '.join(DIALS)})")
    if dial == "written":
        return chord
    quality = core_quality(chord.intervals)
    if dial == "triads":
        quality = _TRIAD[quality]
    m = _ROOT_RE.match(chord.text)
    root, written_quality = (m.group(1), m.group(2)) if m else ("C", "")
    if written_quality.startswith("-"):
        quality = _DASH.get(quality, quality)
    return parse_chord(root + quality)
