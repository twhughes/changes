"""Theory kernel — pure functions, zero deps, the chord matcher's one authority (the server
path has no JS twin; the static page's twin must pass this kernel's parity vectors, CONTRACTS.md §12).

Layer: theory. May import: nothing outside stdlib.
"""

from music.theory.chords import ChordSymbol, parse_chord
from music.theory.match import Level, Verdict, VoicingConstraints, match
from music.theory.naming import name_notes
from music.theory.pitch import midi_to_pc, parse_note, pc_name
from music.theory.simplify import DIALS, simplify
from music.theory.transpose import transpose

THEORY_VERSION = "0.3.0"  # recorded in session.json; bump on grading-semantics changes
# 0.2.0 (2026-07-28): 5th omittable at ALL levels on 4+-tone chords (shell voicings pass)
# 0.3.0 (2026-10-03): Real Book spellings parse (tensions "7b5(b9)", "6/9", "alt", "m11"…)
#   and the grading dial (simplify). Symbols that parsed before grade exactly as before.

__all__ = [
    "ChordSymbol", "parse_chord", "Level", "Verdict", "VoicingConstraints",
    "match", "name_notes", "midi_to_pc", "pc_name", "parse_note",
    "transpose", "simplify", "DIALS", "THEORY_VERSION",
]
