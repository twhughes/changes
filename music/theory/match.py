"""The grading ladder: does this handful of MIDI notes count as that chord?

Semantics pinned in CONTRACTS.md §7. Grading depends only on the notes given —
never on timing or hardware — so live play and replayed recordings grade identically.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable

from music.theory.chords import ChordSymbol
from music.theory.pitch import note_name, pc_name


class Level(Enum):
    LOOSE = "loose"
    STRICT = "strict"
    INVERSION = "inversion"
    VOICED = "voiced"
    #: Pitch-exact items (sight reading): the played MIDI set must equal the
    #: target set. Graded by ``match_pitches``, never by ``match``.
    PITCH = "pitch"


@dataclass(frozen=True)
class VoicingConstraints:
    """Reserved for the VOICED level (enforced in a later milestone)."""
    intervals_from_bass: tuple[int, ...] | None = None
    note_count: int | None = None
    low: int | None = None
    high: int | None = None


@dataclass
class Verdict:
    ok: bool
    level: Level
    missing: list[int] = field(default_factory=list)   # required pcs not played
    extra: list[int] = field(default_factory=list)     # played pcs outside the chord
    bass_ok: bool | None = None                        # None below INVERSION
    per_note: list[tuple[int, str]] = field(default_factory=list)  # (midi, tag)
    summary: str = ""

    def to_dict(self) -> dict:
        return {
            "ok": self.ok, "level": self.level.value,
            "missing": self.missing, "extra": self.extra, "bass_ok": self.bass_ok,
            "per_note": [[n, t] for n, t in self.per_note], "summary": self.summary,
        }


def match(
    played_midi: Iterable[int],
    chord: ChordSymbol,
    level: Level = Level.LOOSE,
    constraints: VoicingConstraints | None = None,
) -> Verdict:
    notes = sorted(set(int(n) for n in played_midi))
    chord_pcs = chord.pcs()
    played_pcs = {n % 12 for n in notes}

    # Required set: the unaltered 5th is omittable on 4+-tone chords at every
    # level (shell voicings — root/3rd/7th — count; Tyler's call 2026-07-28).
    required = set(chord_pcs)
    if chord.fifth_omittable():
        required.discard((chord.root_pc + 7) % 12)

    missing = sorted(required - played_pcs)
    extra = sorted(played_pcs - chord_pcs)

    ok = not missing and bool(notes)
    if level is not Level.LOOSE:
        ok = ok and not extra

    bass_ok: bool | None = None
    if level in (Level.INVERSION, Level.VOICED):
        bass_ok = bool(notes) and notes[0] % 12 == chord.expected_bass_pc
        ok = ok and bool(bass_ok)
    # VOICED constraints: type pinned, enforcement lands with the player milestone.

    per_note: list[tuple[int, str]] = []
    for i, n in enumerate(notes):
        if i == 0 and bass_ok is not None:
            per_note.append((n, "bass" if bass_ok else "extra"))
        elif n % 12 in chord_pcs:
            per_note.append((n, "chord-tone"))
        else:
            per_note.append((n, "extra"))

    summary = _summarize(chord, notes, ok, missing, extra, bass_ok)
    return Verdict(ok=ok, level=level, missing=missing, extra=extra,
                   bass_ok=bass_ok, per_note=per_note, summary=summary)


def _summarize(chord: ChordSymbol, notes: list[int], ok: bool,
               missing: list[int], extra: list[int], bass_ok: bool | None) -> str:
    if not notes:
        return f"{chord.text}: nothing played"
    played = " ".join(note_name(n) for n in notes)
    if ok:
        return f"{chord.text} ✓  ({played})"
    parts = []
    if missing:
        parts.append("missing " + ", ".join(pc_name(pc) for pc in missing))
    if extra:
        parts.append("extra " + ", ".join(pc_name(pc) for pc in extra))
    if bass_ok is False:
        parts.append(f"bass should be {pc_name(chord.expected_bass_pc)}")
    detail = "; ".join(parts) if parts else "not matched"
    return f"{chord.text} ✗  ({played}) — {detail}"


def match_pitches(
    played_midi: Iterable[int],
    targets: Iterable[int],
    *,
    octave_exact: bool = True,
) -> Verdict:
    """Sight-reading grade: did these MIDI notes hit exactly those pitches?

    The staff fixes the octave, so by default a note is right only in the
    written octave (E4 is 64, not 52 or 76). ``octave_exact=False`` relaxes to
    pitch classes — the "any octave" reading drills. Like ``match``, this
    depends only on the notes given; timing lives in the engine.
    """
    notes = sorted(set(int(n) for n in played_midi))
    want = sorted(set(int(n) for n in targets))
    if octave_exact:
        played_keys = set(notes)
        want_keys = set(want)
        key_of = int
    else:
        played_keys = {n % 12 for n in notes}
        want_keys = {n % 12 for n in want}
        key_of = lambda n: n % 12  # noqa: E731
    missing = sorted(want_keys - played_keys)
    extra = sorted(played_keys - want_keys)
    ok = bool(notes) and not missing and not extra
    per_note = [(n, "chord-tone" if key_of(n) in want_keys else "extra") for n in notes]
    label = " ".join(note_name(n) if octave_exact else pc_name(n % 12) for n in want)
    if not notes:
        summary = f"{label}: nothing played"
    elif ok:
        summary = f"{label} ✓  ({' '.join(note_name(n) for n in notes)})"
    else:
        fmt = note_name if octave_exact else pc_name
        parts = []
        if missing:
            parts.append("missing " + ", ".join(fmt(n) for n in missing))
        if extra:
            parts.append("extra " + ", ".join(fmt(n) for n in extra))
        summary = f"{label} ✗  ({' '.join(note_name(n) for n in notes)}) — " + "; ".join(parts)
    return Verdict(ok=ok, level=Level.PITCH, missing=missing, extra=extra,
                   bass_ok=None, per_note=per_note, summary=summary)
