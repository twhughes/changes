"""Pitch-class primitives. (pc map proven in mashup's compat.py; extended with unicode accidentals.)"""

from __future__ import annotations

import re

# Natural note letters to pitch class.
_LETTER_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

_ACCIDENTAL = {"": 0, "#": 1, "♯": 1, "b": -1, "♭": -1, "##": 2, "bb": -2}

# Default spelling per pitch class (sharps for the "sharp" classes except the
# flat-friendly Eb/Ab/Bb, matching common lead-sheet practice).
_PC_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

_NOTE_RE = re.compile(r"^([A-Ga-g])(##|bb|[#♯b♭]?)$")


def parse_note(text: str) -> int:
    """'F#' / 'bb' spellings → pitch class 0-11. Raises ValueError on junk."""
    m = _NOTE_RE.match(text.strip())
    if not m:
        raise ValueError(f"not a note name: {text!r}")
    letter, acc = m.group(1).upper(), m.group(2)
    return (_LETTER_PC[letter] + _ACCIDENTAL[acc]) % 12


def pc_name(pc: int, prefer_flats: bool = False) -> str:
    """Pitch class → default spelling. prefer_flats picks Db/Gb over C#/F#."""
    pc %= 12
    if prefer_flats and pc in (1, 6):
        return {1: "Db", 6: "Gb"}[pc]
    return _PC_NAMES[pc]


def midi_to_pc(note: int) -> int:
    return note % 12


def note_name(midi_note: int) -> str:
    """MIDI note number → e.g. 'F#3' (middle C = C4 = 60)."""
    return f"{_PC_NAMES[midi_note % 12]}{midi_note // 12 - 1}"
