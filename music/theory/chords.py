"""Chord symbols: the quality vocabulary and the parser ("G7", "F#m7b5", "C/E")."""

from __future__ import annotations

import re
from dataclasses import dataclass

from music.theory.pitch import parse_note

# Canonical quality → intervals from root (semitones mod 12, always includes 0).
QUALITIES: dict[str, frozenset[int]] = {
    "": frozenset({0, 4, 7}),            # major triad
    "m": frozenset({0, 3, 7}),
    "dim": frozenset({0, 3, 6}),
    "aug": frozenset({0, 4, 8}),
    "5": frozenset({0, 7}),              # power chord
    "6": frozenset({0, 4, 7, 9}),
    "m6": frozenset({0, 3, 7, 9}),
    "7": frozenset({0, 4, 7, 10}),
    "maj7": frozenset({0, 4, 7, 11}),
    "m7": frozenset({0, 3, 7, 10}),
    "m7b5": frozenset({0, 3, 6, 10}),
    "dim7": frozenset({0, 3, 6, 9}),
    "mMaj7": frozenset({0, 3, 7, 11}),
    "sus2": frozenset({0, 2, 7}),
    "sus4": frozenset({0, 5, 7}),
    "7sus4": frozenset({0, 5, 7, 10}),
    "9": frozenset({0, 2, 4, 7, 10}),
    "maj9": frozenset({0, 2, 4, 7, 11}),
    "m9": frozenset({0, 2, 3, 7, 10}),
    "add9": frozenset({0, 2, 4, 7}),
    "11": frozenset({0, 2, 5, 7, 10}),   # dominant 11th, 3rd omitted by convention
    "13": frozenset({0, 2, 4, 7, 9, 10}),  # 11th omitted by convention
    "7b9": frozenset({0, 1, 4, 7, 10}),
    "7#9": frozenset({0, 3, 4, 7, 10}),
    "7b5": frozenset({0, 4, 6, 10}),
    "7#5": frozenset({0, 4, 8, 10}),
}

# Real Book qualities that parse but stay OUT of QUALITIES on purpose: naming
# ranks its guesses over QUALITIES only, and an "alt" or "m11" in there would
# rename the plain shells Tyler plays (C-E-Bb would start reading as C7alt).
EXTENDED: dict[str, frozenset[int]] = {
    "69": frozenset({0, 2, 4, 7, 9}),
    "m69": frozenset({0, 2, 3, 7, 9}),
    "m11": frozenset({0, 2, 3, 5, 7, 10}),
    "m13": frozenset({0, 2, 3, 7, 9, 10}),
    "maj13": frozenset({0, 2, 4, 7, 9, 11}),
    "9sus4": frozenset({0, 2, 5, 7, 10}),
    "13sus4": frozenset({0, 2, 5, 7, 9, 10}),
    # Altered dominant: the 3rd and 7th ARE the chord; its 5th and 9th are
    # whatever the player alters them to, so none of them is required.
    "7alt": frozenset({0, 4, 10}),
}

# Spellings people actually write → canonical key in QUALITIES or EXTENDED.
_ALIASES = {
    "maj": "", "M": "", "major": "",
    "min": "m", "-": "m", "minor": "m", "mi": "m",
    "M7": "maj7", "Maj7": "maj7", "Δ": "maj7", "Δ7": "maj7", "ma7": "maj7",
    "^": "maj7", "^7": "maj7",
    "M9": "maj9", "Maj9": "maj9", "Δ9": "maj9", "^9": "maj9",
    "M13": "maj13", "Maj13": "maj13", "Δ13": "maj13", "^13": "maj13",
    "ø": "m7b5", "ø7": "m7b5", "Ø": "m7b5", "Ø7": "m7b5", "h": "m7b5", "h7": "m7b5",
    "m7♭5": "m7b5", "min7b5": "m7b5", "-7b5": "m7b5",
    "°": "dim", "o": "dim", "°7": "dim7", "o7": "dim7",
    "+": "aug", "+5": "aug", "#5": "aug",
    "mM7": "mMaj7", "m(maj7)": "mMaj7", "minMaj7": "mMaj7", "-Maj7": "mMaj7",
    "-maj7": "mMaj7", "mmaj7": "mMaj7", "-Δ7": "mMaj7", "-Δ": "mMaj7", "mΔ7": "mMaj7",
    "mΔ": "mMaj7", "-^7": "mMaj7",
    "sus": "sus4", "7sus": "7sus4", "sus7": "7sus4", "9sus": "9sus4", "13sus": "13sus4",
    "min7": "m7", "-7": "m7", "mi7": "m7", "min6": "m6", "-6": "m6", "mi6": "m6",
    "min9": "m9", "-9": "m9", "mi9": "m9",
    "min11": "m11", "-11": "m11", "mi11": "m11", "min13": "m13", "-13": "m13",
    "-69": "m69", "6add9": "69",
    "dom7": "7", "7♭9": "7b9", "7♯9": "7#9", "7♭5": "7b5", "7♯5": "7#5",
    "7+": "7#5", "+7": "7#5", "7+5": "7#5", "aug7": "7#5", "7aug": "7#5",
    "alt": "7alt", "alt7": "7alt", "7(alt)": "7alt",
    "add2": "add9",
}

# Tensions written after a base quality: "7b5(b9)", "maj7#11", "13b9", "7(b9,#9)".
# token → (interval it adds, intervals it replaces). An altered 5th replaces the
# plain 5th; an altered 9th the plain 9th; a b13 the plain 13th. A #11 keeps the
# 5th (lydian sounds both).
_TENSIONS: dict[str, tuple[int, frozenset[int]]] = {
    "b5": (6, frozenset({7})), "#5": (8, frozenset({7})),
    "b9": (1, frozenset({2})), "9": (2, frozenset()), "#9": (3, frozenset({2})),
    "11": (5, frozenset()), "#11": (6, frozenset()),
    "b13": (8, frozenset({9})), "13": (9, frozenset()),
}
_TENSION_RE = re.compile(r"(?:add)?([b#+-]?)(5|9|11|13)")


def _intervals_of(quality: str) -> frozenset[int] | None:
    return QUALITIES.get(quality, EXTENDED.get(quality))


def _compound(qual_txt: str) -> tuple[str, frozenset[int]] | None:
    """'7b5(b9)' → ('7b5b9', intervals): a known base plus tension tokens.

    The longest known base wins ("7b5" before "7"), and every character after
    it must be a tension — anything else and this is not a chord we know.
    """
    text = qual_txt.replace("♭", "b").replace("♯", "#")
    text = re.sub(r"[()\s,]", "", text)
    for cut in range(len(text), -1, -1):
        base = _ALIASES.get(text[:cut], text[:cut])
        intervals = _intervals_of(base)
        if intervals is None:
            continue
        rest, tokens = text[cut:], []
        while rest:
            m = _TENSION_RE.match(rest)
            if not m:
                break
            sign = {"+": "#", "-": "b"}.get(m.group(1), m.group(1))
            token = sign + m.group(2)
            if token not in _TENSIONS:
                break
            tokens.append(token)
            rest = rest[m.end():]
        if rest or not tokens:
            continue
        ivs = set(intervals)
        for token in tokens:
            add, drop = _TENSIONS[token]
            ivs -= drop
            ivs.add(add)
        return base + "".join(tokens), frozenset(ivs)
    return None

# Qualities where the 7th degree of the scale... no: where interval 7 (the perfect 5th)
# is unaltered and conventionally omittable when the chord has 4+ tones.
_FIFTH = 7

_CHORD_RE = re.compile(
    r"^\s*([A-G](?:##|bb|[#♯b♭])?)"   # root
    r"([^/\s]*)"                       # quality text
    r"(?:/([A-G](?:##|bb|[#♯b♭])?))?"  # optional slash bass
    r"\s*$"
)


@dataclass(frozen=True)
class ChordSymbol:
    root_pc: int
    quality: str                  # canonical key into QUALITIES
    intervals: frozenset[int]     # semitones from root, incl. 0
    bass_pc: int | None           # slash bass pc, None if unspecified
    text: str                     # as written

    def pcs(self) -> frozenset[int]:
        """Absolute pitch classes of the chord tones."""
        return frozenset((self.root_pc + i) % 12 for i in self.intervals)

    @property
    def expected_bass_pc(self) -> int:
        return self.bass_pc if self.bass_pc is not None else self.root_pc

    def fifth_omittable(self) -> bool:
        """The unaltered 5th may be left out of 4+-tone voicings (strict level)."""
        return _FIFTH in self.intervals and len(self.intervals) >= 4


def hint_voicing(chord: ChordSymbol) -> list[int]:
    """One close voicing to light on the piano as a hint (any voicing still passes).

    The bass (slash note, else the root) in octave 3; every other chord tone in the
    octave above middle C. Computed in Python so the browser never parses a chord
    (the static page's twin rebuilds it from the chord table: bass + pcs).
    """
    low = chord.expected_bass_pc
    upper = sorted({60 + (chord.root_pc + i) % 12 for i in chord.intervals} - {60 + low})
    return [48 + low, *upper]


def parse_chord(text: str) -> ChordSymbol:
    """'G7' / 'F#m7b5' / 'C/E' / 'Bb7(#11)' → ChordSymbol. Raises ValueError."""
    # "6/9" is the one slash that is not a bass note; △ is the Real Book's Δ.
    m = _CHORD_RE.match(text.replace("6/9", "69").replace("△", "Δ"))
    if not m:
        raise ValueError(f"not a chord symbol: {text!r}")
    root_txt, qual_txt, bass_txt = m.group(1), m.group(2), m.group(3)
    root_pc = parse_note(root_txt)
    quality = _ALIASES.get(qual_txt, qual_txt)
    intervals = _intervals_of(quality)
    if intervals is None:
        compound = _compound(qual_txt)
        if compound is None:
            raise ValueError(f"unknown chord quality {qual_txt!r} in {text!r}")
        quality, intervals = compound
    bass_pc = parse_note(bass_txt) if bass_txt else None
    return ChordSymbol(
        root_pc=root_pc, quality=quality, intervals=intervals,
        bass_pc=bass_pc, text=text.strip(),
    )
