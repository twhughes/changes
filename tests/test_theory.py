"""Theory kernel: parsing, the grading ladder, naming, transposition."""

import pytest

from music.theory import Level, match, name_notes, parse_chord, transpose
from music.theory.pitch import parse_note

# ── parsing ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,root,quality,bass", [
    ("C", 0, "", None),
    ("G7", 7, "7", None),
    ("F#m7b5", 6, "m7b5", None),
    ("Bbmaj7", 10, "maj7", None),
    ("C/E", 0, "", 4),
    ("Am7/G", 9, "m7", 7),
    ("Ebm", 3, "m", None),
    ("Ddim7", 2, "dim7", None),
    ("Asus4", 9, "sus4", None),
    ("C#mMaj7", 1, "mMaj7", None),
])
def test_parse_chord(text, root, quality, bass):
    c = parse_chord(text)
    assert (c.root_pc, c.quality, c.bass_pc) == (root, quality, bass)


@pytest.mark.parametrize("alias,canonical", [
    ("CM7", "Cmaj7"), ("Amin7", "Am7"), ("Bø", "Bm7b5"), ("F+", "Faug"),
    ("G°7", "Gdim7"), ("Dsus", "Dsus4"), ("E-7", "Em7"),
])
def test_quality_aliases(alias, canonical):
    assert parse_chord(alias).pcs() == parse_chord(canonical).pcs()


@pytest.mark.parametrize("bad", ["H7", "C%", "Xm", "", "7", "Cmaj7/H"])
def test_parse_rejects_junk(bad):
    with pytest.raises(ValueError):
        parse_chord(bad)


def test_enharmonic_roots_same_pcs():
    assert parse_chord("C#7").pcs() == parse_chord("Db7").pcs()
    assert parse_note("E#") == parse_note("F")
    assert parse_note("Cb") == parse_note("B")


def test_chord_pcs_g7():
    assert parse_chord("G7").pcs() == {7, 11, 2, 5}  # G B D F


# ── grading ladder ─────────────────────────────────────────────────────────

G7 = parse_chord("G7")

def test_loose_any_voicing_passes():
    for voicing in ([55, 59, 62, 65], [43, 59, 65, 74], [50, 53, 55, 59]):
        assert match(voicing, G7, Level.LOOSE).ok, voicing

def test_loose_extras_allowed_but_missing_fails():
    assert match([55, 59, 62, 65, 60], G7, Level.LOOSE).ok          # +C extra: fine
    v = match([55, 59, 62], G7, Level.LOOSE)                        # no F
    assert not v.ok and v.missing == [5]


def test_shell_voicing_passes_all_levels():
    # Root + 3rd + 7th (no 5th) is a real voicing — passes loose AND strict.
    assert match([43, 59, 65], G7, Level.LOOSE).ok                  # G B F
    assert match([43, 59, 65], G7, Level.STRICT).ok
    assert match([43, 59, 65], G7, Level.INVERSION).ok              # G in bass
    # Triads still need their 5th: C E is not a C chord.
    assert not match([60, 64], parse_chord("C"), Level.LOOSE).ok

def test_loose_empty_fails():
    assert not match([], G7, Level.LOOSE).ok

def test_strict_no_extras_fifth_omittable():
    assert not match([55, 59, 62, 65, 60], G7, Level.STRICT).ok     # extra C
    assert match([55, 59, 65], G7, Level.STRICT).ok                 # G B F: 5th omitted
    v = match([55, 62, 65], G7, Level.STRICT)                       # no 3rd
    assert not v.ok and v.missing == [11]

def test_strict_triad_fifth_required():
    c = parse_chord("C")
    assert not match([60, 64], c, Level.STRICT).ok                  # C E dyad ≠ C triad
    assert match([60, 64, 67], c, Level.STRICT).ok

def test_inversion_slash_bass():
    c_over_e = parse_chord("C/E")
    assert match([52, 55, 60], c_over_e, Level.INVERSION).ok        # E G C
    v = match([48, 52, 55], c_over_e, Level.INVERSION)              # C in bass
    assert not v.ok and v.bass_ok is False

def test_inversion_root_default():
    assert match([43, 59, 62, 65], G7, Level.INVERSION).ok          # G in bass
    assert not match([41, 55, 59, 62], G7, Level.INVERSION).ok      # F in bass

def test_per_note_tags():
    v = match([55, 59, 62, 65, 61], G7, Level.LOOSE)
    tags = dict(v.per_note)
    assert tags[59] == "chord-tone" and tags[61] == "extra"

def test_octave_and_doubling_irrelevant():
    assert match([31, 43, 55, 59, 71, 74, 77], G7, Level.STRICT).ok

def test_power_chord_and_dim7():
    assert match([45, 52], parse_chord("A5"), Level.STRICT).ok
    assert match([59, 62, 65, 68], parse_chord("Bdim7"), Level.STRICT).ok


# ── naming ─────────────────────────────────────────────────────────────────

def test_name_c7():
    assert name_notes([60, 64, 67, 70])[0].name == "C7"

def test_name_minor_and_maj7():
    assert name_notes([57, 60, 64])[0].name == "Am"
    assert name_notes([60, 64, 67, 71])[0].name == "Cmaj7"

def test_name_am7_c6_ambiguity_prefers_bass_root():
    # A C E G with A in the bass reads Am7; with C in the bass, C6 wins.
    assert name_notes([57, 60, 64, 67])[0].name == "Am7"
    top_c_bass = name_notes([48, 57, 64, 67])[0].name
    assert top_c_bass in ("C6", "Am7/C")

def test_name_slash_chord():
    names = [r.name for r in name_notes([52, 55, 60])]
    assert "C/E" in names

def test_name_too_few_notes():
    assert name_notes([60]) == []


# ── transposition ──────────────────────────────────────────────────────────

def test_transpose_basic():
    assert transpose(parse_chord("G7"), 5).text == "C7"
    assert transpose(parse_chord("C/E"), 2).text == "D/F#"

def test_transpose_prefers_flats_on_flat_roots():
    assert transpose(parse_chord("C"), 3).text == "Eb"
    assert transpose(parse_chord("Am7"), 1).text == "Bbm7"

def test_transpose_round_trip():
    c = parse_chord("F#m7b5")
    assert transpose(transpose(c, 7), 5).pcs() == c.pcs()
