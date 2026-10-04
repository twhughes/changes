"""Sight-reading decks (PLAN M10, GOAL-JAZZ "sight-reading track").

The ladder: single notes on each clef → both clefs → two-note dyads →
chord-symbol realization. Every item is a ``DrillItem`` with ``pitches`` set,
so the trainer grades it with ``theory.match_pitches`` (pitch-exact: the staff
fixes the octave) and the cockpit shows a staff instead of a chord name.

Fronts round-trip through a one-line codec, like the chord decks:

    "E4 treble"       → play E4 (64), shown on the treble clef
    "E4+G4 treble"    → play E4 and G4 together (a dyad)
    "F2 bass"         → play F2 (41) on the bass clef
    "C4 grand"        → C4 on the grand staff (middle C, either side)

Middle C is C4 = MIDI 60. Pitch names use the default spelling (sharps except
Eb/Ab/Bb) so a Front is always the string ``note_name`` returns.
"""

from __future__ import annotations

import re

from music.learn.drill import DrillItem
from music.theory.chords import parse_chord
from music.theory.match import Level
from music.theory.pitch import note_name, parse_note

CLEFS = ("treble", "bass", "grand")

#: Written ranges per clef, inclusive MIDI numbers — a couple of ledger lines
#: each side of the staff, which is what a lead sheet actually asks for.
TREBLE_RANGE = (60, 84)     # C4 … C6
BASS_RANGE = (36, 60)       # C2 … C4
GRAND_RANGE = (48, 72)      # C3 … C5 — the hand-off zone around middle C

#: Dyads drilled on the treble clef: (semitones) — thirds, fourths, fifths,
#: sixths, octaves. Bigger intervals are chord territory (reading-chords).
INTERVALS = (3, 4, 5, 7, 8, 9, 12)

_PLACEHOLDER = parse_chord("C")     # DrillItem needs a chord; pitch items ignore it
_NOTE_RE = re.compile(r"^([A-G](?:##|bb|[#♯b♭])?)(-?\d+)$")
_FRONT_RE = re.compile(
    r"^(?P<notes>[A-G][#♯b♭]*-?\d+(?:\+[A-G][#♯b♭]*-?\d+)*)\s+(?P<clef>treble|bass|grand)$")


def parse_pitch(text: str) -> int:
    """'E4' → 64, 'Bb3' → 58, 'C#-1' → 1. Raises ValueError on junk."""
    m = _NOTE_RE.match(text.strip())
    if not m:
        raise ValueError(f"not a pitch: {text!r}")
    pc = parse_note(m.group(1))
    octave = int(m.group(2))
    midi = (octave + 1) * 12 + pc
    if not 0 <= midi <= 127:
        raise ValueError(f"pitch out of MIDI range: {text!r}")
    return midi


def pitch_front(pitches: tuple[int, ...] | list[int], clef: str) -> str:
    """The codec's encoder: pitches + clef → the one-line card Front."""
    if clef not in CLEFS:
        raise ValueError(f"unknown clef {clef!r}")
    return "+".join(note_name(p) for p in sorted(pitches)) + " " + clef


def item_for_pitch_front(text: str) -> DrillItem | None:
    """Decode 'E4 treble' / 'E4+G4 bass' into a pitch DrillItem; None if not ours."""
    m = _FRONT_RE.match(text.strip())
    if not m:
        return None
    try:
        pitches = tuple(sorted(parse_pitch(p) for p in m.group("notes").split("+")))
    except ValueError:
        return None
    clef = m.group("clef")
    return DrillItem(prompt=_prompt(pitches, clef), chord=_PLACEHOLDER, level=Level.PITCH,
                     pitches=pitches, clef=clef)


def _prompt(pitches: tuple[int, ...], clef: str) -> str:
    names = " + ".join(note_name(p) for p in pitches)
    what = "note" if len(pitches) == 1 else "notes"
    return f"Read the {what} on the {clef} staff — play {names}"


def _single_notes(clef: str, lo: int, hi: int) -> list[DrillItem]:
    return [item_for_pitch_front(pitch_front((p,), clef)) for p in range(lo, hi + 1)]


def _dyads(clef: str, lo: int, hi: int) -> list[DrillItem]:
    items = []
    for low in range(lo, hi + 1):
        for gap in INTERVALS:
            high = low + gap
            if high <= hi:
                items.append(item_for_pitch_front(pitch_front((low, high), clef)))
    return items


def _chord_realization() -> list[DrillItem]:
    """Chord symbols read off a chart, any voicing: the last rung before standards."""
    from music.learn.decks import PROGRESSIONS  # local: decks imports this module
    from music.theory.transpose import transpose

    seen: set[str] = set()
    items = []
    for texts in PROGRESSIONS.values():
        bases = [parse_chord(t) for t in texts]
        for n in range(12):
            for base in bases:
                c = transpose(base, n)
                if c.text in seen:
                    continue
                seen.add(c.text)
                items.append(DrillItem(prompt=f"Read {c.text} off the chart — any voicing",
                                       chord=c, level=Level.LOOSE))
    return items


def reading_decks() -> dict[str, list[DrillItem]]:
    """Deck name → items. Merged into ``builtin_decks()`` by decks.py."""
    return {
        "reading-treble": _single_notes("treble", *TREBLE_RANGE),
        "reading-bass": _single_notes("bass", *BASS_RANGE),
        "reading-grand": _single_notes("grand", *GRAND_RANGE),
        "reading-intervals": _dyads("treble", *TREBLE_RANGE),
        "reading-chords": _chord_realization(),
    }


def reading_fronts(deck_name: str) -> list[str]:
    """One Front per item of a reading deck (KeyError for a non-reading deck)."""
    items = reading_decks()[deck_name]
    return [pitch_front(it.pitches, it.clef) if it.is_pitch else it.chord.text for it in items]
