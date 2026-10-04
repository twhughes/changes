"""Transposition — deck generators cycle chord shapes through 12 keys with this."""

from __future__ import annotations

from music.theory.chords import ChordSymbol
from music.theory.pitch import pc_name


def transpose(chord: ChordSymbol, semitones: int) -> ChordSymbol:
    root = (chord.root_pc + semitones) % 12
    bass = (chord.bass_pc + semitones) % 12 if chord.bass_pc is not None else None
    # Respell: flat-side roots read better with flat names.
    prefer_flats = root in (1, 3, 6, 8, 10)
    text = pc_name(root, prefer_flats) + chord.quality
    if bass is not None:
        text += "/" + pc_name(bass, prefer_flats)
    return ChordSymbol(root_pc=root, quality=chord.quality,
                       intervals=chord.intervals, bass_pc=bass, text=text)
