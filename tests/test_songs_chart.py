"""Songs, the pure half: Real Book spellings, the grading dial, song text v1.

The fixture is Very Early as read off the Real Book page (tests/fixtures/songs/)
— 3/4, an A section with 1st/2nd endings, split bars in B, a slash chord in
the ending — so every rule of CONTRACTS.md §9 has a real bar to bite on.
"""

from pathlib import Path

import pytest

from music.songs.chart import (
    ChartError,
    distinct_chords,
    format_cell,
    format_song,
    parse_front,
    parse_song,
    phrase_back,
    phrase_front,
    phrases,
    play_bars,
    pretty,
    replace_cell,
    run_steps,
    slugify,
    song_dict,
)
from music.theory import match, parse_chord, simplify
from music.theory.chords import QUALITIES
from music.theory.naming import name_notes

FIXTURE = Path(__file__).parent / "fixtures" / "songs" / "very-early.txt"


def very_early(grade: str = "core"):
    song, problems = parse_song(FIXTURE.read_text())
    song.grade = grade
    return song, problems


# ── theory: the spellings a Real Book page uses ──────────────────────────────
@pytest.mark.parametrize("text, pcs", [
    ("Bb7(#11)", {10, 2, 5, 8, 4}),          # lydian dominant keeps its 5th
    ("A7b5(b9)", {9, 1, 3, 7, 10}),          # b5 replaces the 5th, b9 the 9th
    ("E-9", {4, 7, 11, 2, 6}),
    ("G7#5", {7, 11, 3, 5}),
    ("C6/9", {0, 4, 7, 9, 2}),               # the one slash that is not a bass
    ("D-maj7", {2, 5, 9, 1}),
    ("F7alt", {5, 9, 3}),                    # 3rd + 7th; the alterations are free
    ("Cmaj7#11", {0, 4, 7, 11, 6}),
    ("G13b9", {7, 11, 2, 5, 4, 8}),          # b9 replaces the 13 chord's 9th
    ("F7(b9,#9)", {5, 9, 0, 3, 6, 8}),
    ("Cm7(11)", {0, 3, 7, 10, 5}),
    ("C△7", {0, 4, 7, 11}),
    ("Cmi7b5", {0, 3, 6, 10}),
    ("B♭7(♯11)", {10, 2, 5, 8, 4}),
])
def test_real_book_spellings_parse(text, pcs):
    assert set(parse_chord(text).pcs()) == pcs


@pytest.mark.parametrize("text", ["Cxyz", "C7b", "H7", "C7maj9foo", "N.C."])
def test_junk_still_raises(text):
    with pytest.raises(ValueError):
        parse_chord(text)


def test_naming_vocabulary_is_unchanged():
    """New spellings live outside QUALITIES: C-E-Bb must still read as C7, not C7alt."""
    assert "7alt" not in QUALITIES and "m11" not in QUALITIES
    assert not any("alt" in r.name for r in name_notes([60, 64, 70], top=10))
    assert name_notes([60, 64, 67, 70])[0].name == "C7"


def test_transposed_compound_chords_reparse():
    from music.theory import transpose
    chord = transpose(parse_chord("A7b5(b9)"), 3)
    assert parse_chord(chord.text).pcs() == chord.pcs()


# ── the grading dial ─────────────────────────────────────────────────────────
@pytest.mark.parametrize("written, core, triads", [
    ("Cmaj7", "Cmaj7", "C"), ("B7b9", "B7", "B"), ("E-9", "E-7", "E-"),
    ("A7b5(b9)", "A7", "A"), ("Bb7(#11)", "Bb7", "Bb"), ("G7#5", "G7", "G"),
    ("D-7/C", "D-7", "D-"), ("C6", "C", "C"), ("Cm6", "Cm", "Cm"), ("C6/9", "C", "C"),
    ("Bø7", "Bm7b5", "Bdim"), ("Bo7", "Bdim7", "Bdim"), ("G7sus", "G7sus4", "Gsus4"),
    ("Am11", "Am7", "Am"), ("D-maj7", "D-maj7", "D-"), ("Eb-7(b5)", "Eb-7b5", "Ebdim"),
    ("F7alt", "F7", "F"), ("Caug", "Caug", "Caug"),
])
def test_dial_targets(written, core, triads):
    chord = parse_chord(written)
    assert simplify(chord, "core").text == core
    assert simplify(chord, "triads").text == triads
    assert simplify(chord, "written") is chord


def test_core_lets_the_tensions_ride_along():
    """Loose grading: the ♭9 is not required on a core B7, and playing it still passes."""
    target = simplify(parse_chord("B7b9"), "core")
    assert match([59, 63, 69], target).ok                  # B D# A — the shell
    assert match([59, 63, 69, 72], target).ok             # + the C (the b9)


def test_unknown_dial_raises():
    with pytest.raises(ValueError):
        simplify(parse_chord("C7"), "loose")


# ── song text v1 ─────────────────────────────────────────────────────────────
def test_fixture_parses_clean_and_round_trips():
    song, problems = very_early()
    assert problems == []
    assert song.title == "Very Early" and song.time == "3/4" and song.beats_per_bar == 3
    assert song.form == ("A", "A", "B", "Ending")
    text = format_song(song)
    again, _ = parse_song(text)
    assert format_song(again) == text


def test_cells_format_back_exactly():
    song, _ = very_early()
    a4 = song.section("A").lines[3].bars
    assert [format_cell(b, 3) for b in a4] == ["E-9", "Ab7", "Dbmaj7", "1. G7", "2. G7#5"]
    b4 = song.section("B").lines[3].bars
    assert format_cell(b4[0], 3) == "D-7:2 E-7:1"
    assert [s.beats for s in b4[1].slots] == [1, 2]


def test_even_split_and_marks():
    song, problems = parse_song("title: T\ntime: 4/4\n[A]\n| C G7 | % |  | N.C. | 1. | 2. F |\n")
    bars = song.sections[0].lines[0].bars
    assert [s.beats for s in bars[0].slots] == [2, 2]
    assert bars[1].repeat and [s.symbol for s in bars[1].slots] == ["C", "G7"]
    assert bars[2].hold and bars[2].slots[0].symbol == "G7"
    assert bars[3].slots[0].symbol == ""
    assert bars[4].volta == 1 and bars[4].hold
    assert [format_cell(b, 4) for b in bars] == ["C G7", "%", "", "N.C.", "1.", "2. F"]
    assert problems == []


def test_problems_are_soft_errors_are_hard():
    song, problems = parse_song("title: T\n[A]\n| Cmaj7 | Cxyz | C:3 G:3 |\n")
    assert [p.addr for p in problems] == ["A.1.2", "A.1.3"]
    with pytest.raises(ChartError) as e:
        parse_song("composer: nobody\n[A]\n| C |\n[A]\n| D |\nform: A B\n")
    joined = " ".join(e.value.errors)
    assert "title" in joined and "twice" in joined and "go above" in joined


def test_form_must_name_real_sections():
    with pytest.raises(ChartError):
        parse_song("title: T\nform: A B\n[A]\n| C |\n")


def test_header_url_with_a_pipe_stays_a_header():
    song, _ = parse_song("title: T\nsource: https://x.org/a|b\n[A]\n| C |\n")
    assert song.source == "https://x.org/a|b"


def test_replace_cell():
    song, _ = very_early()
    new = replace_cell(song, "A.4.5", "2. G7b9")
    assert format_cell(new.section("A").lines[3].bars[4], 3) == "2. G7b9"
    with pytest.raises(KeyError):
        replace_cell(song, "A.9.1", "C")


# ── what practice derives ────────────────────────────────────────────────────
def test_play_order_takes_each_ending_once():
    song, _ = very_early()
    bars = play_bars(song)
    assert len(bars) == 16 + 16 + 16 + 4
    assert [b.addr for b in bars[14:18]] == ["A.4.3", "A.4.4", "A.1.1", "A.1.2"]
    assert bars[31].addr == "A.4.5" and bars[31].passno == 2
    assert bars[32].addr == "B.1.1"


def test_core_merges_identical_endings_written_splits_them():
    core, _ = very_early("core")
    assert [p.id for p in phrases(core)] == ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4",
                                             "Ending1"]
    written, _ = very_early("written")
    ids = [p.id for p in phrases(written)]
    assert "A4.1" in ids and "A4.2" in ids and "A4" not in ids


def test_phrase_steps_cues_and_card_faces():
    song, _ = very_early()
    by_id = {p.id: p for p in phrases(song)}
    a2 = by_id["A2"]
    assert [s.play.text for s in a2.steps] == ["Dbmaj7", "G7", "Cmaj7", "Bb7"]
    assert a2.cue.text == "Ab7" and by_id["A1"].cue is None
    assert by_id["B1"].cue.text == "G7"                     # the 2nd ending, under core
    assert phrase_front(song, a2) == "Very Early · A line 2 (after A♭7)"
    assert phrase_back(a2) == "D♭maj7 · G7 · Cmaj7 · B♭7"
    assert len(by_id["B4"].steps) == 8                      # split bars: two chords each


def test_fronts_decode_with_or_without_the_cue():
    assert parse_front("Very Early · A line 2 (after A♭7)") == ("Very Early", "A", 2, None)
    assert parse_front("Very Early · A line 4 · 2nd ending (start)") == ("Very Early", "A", 4, 2)
    assert parse_front("A · B · Ending line 1") == ("A · B", "Ending", 1, None)
    assert parse_front("G7") is None


def test_runs_merge_repeated_chords_and_skip_rests():
    song, _ = parse_song("title: T\n[A]\n| C | C | N.C. | G7 |\n")
    steps = run_steps(song)
    assert [(s.play.text, s.addr) for s in steps] == [("C", "A.1.1"), ("G7", "A.1.4")]


def test_whole_run_and_section_runs():
    song, _ = very_early()
    assert len(run_steps(song)) == 57
    a = run_steps(song, "A")
    assert [s.play.text for s in a][-1] == "G7" and a[0].n == 1


def test_distinct_chords_dedupe_by_sound():
    song, _ = very_early()
    chords = [c.text for c, _ in distinct_chords(song)]
    assert len(chords) == len(set(chords)) == 18
    b7 = next(s for c, s in distinct_chords(song) if c.text == "B7")
    assert b7 == ["B7b9"]


def test_song_dict_shape():
    song, problems = very_early()
    d = song_dict(song, problems)
    bar = d["sections"][0]["lines"][3]["bars"][4]
    assert bar == {"addr": "A.4.5", "volta": 2, "repeat": False, "text": "2. G7#5",
                   "slots": [{"symbol": "G7#5", "beats": 3, "play": "G7", "ok": True}]}
    assert d["play"][0] == {"n": 1, "addr": "A.1.1", "section": "A", "pass": 1}
    assert set(d["runs"]) == {"all", "A", "B", "Ending"}
    assert d["phrases"][1]["front"] == "Very Early · A line 2 (after A♭7)"
    assert d["chords"][0] == {"play": "Cmaj7", "symbols": ["Cmaj7"], "notes": [48, 64, 67, 71]}
    assert d["phrases"][0]["steps"][0]["notes"] == [48, 64, 67, 71]
    assert d["runs"]["all"][0] == {"play": "Cmaj7", "symbol": "Cmaj7", "addr": "A.1.1",
                                   "slot": 0, "notes": [48, 64, 67, 71], "n": 1}


def test_helpers():
    assert pretty("Bb7(#11)") == "B♭7(♯11)" and pretty("Abm7b5") == "A♭m7♭5"
    assert slugify("Very Early") == "very-early" and slugify("!!!") == "song"


def test_a_section_the_form_never_plays_is_a_problem():
    _, problems = parse_song("title: T\nform: A A\n[A]\n| C |\n[Ending]\n| G7 | C |\n")
    assert [p.message for p in problems] == ["[Ending] is not in the form, so it is never played"]
    _, problems = parse_song("title: T\n[A]\n| C |\n[Ending]\n| G7 | C |\n")
    assert problems == []                         # no form = every section once
