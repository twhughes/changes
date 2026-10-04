"""Sight reading (M10): pitch-exact grading, the note Front codec, reading decks,
and the trainer's staff payload — all headless, all over the one engine."""

from music.learn.decks import builtin_decks, item_for_front, seed_fronts
from music.learn.drill import DrillEngine, DrillItem
from music.learn.reading import (
    BASS_RANGE,
    TREBLE_RANGE,
    item_for_pitch_front,
    parse_pitch,
    pitch_front,
    reading_decks,
)
from music.midio.events import MidiEvent
from music.midio.notes import NoteTracker
from music.theory.chords import parse_chord
from music.theory.match import Level, match_pitches
from tests.test_web import make_client, make_world, press, recv_until, settle, ws_connect


# ── theory: match_pitches ───────────────────────────────────────────────────
def test_match_pitches_exact_octave():
    v = match_pitches([64], [64])
    assert v.ok and v.level is Level.PITCH and v.summary.startswith("E4 ✓")
    wrong_octave = match_pitches([52], [64])
    assert not wrong_octave.ok and wrong_octave.missing == [64] and wrong_octave.extra == [52]
    assert "missing E4" in wrong_octave.summary and "extra E3" in wrong_octave.summary


def test_match_pitches_any_octave_relaxes_to_pitch_classes():
    v = match_pitches([52, 76], [64], octave_exact=False)
    assert v.ok and v.missing == [] and v.extra == []
    assert match_pitches([], [64]).ok is False


def test_match_pitches_dyad_and_per_note_tags():
    v = match_pitches([64, 67, 70], [64, 67])
    assert not v.ok and v.extra == [70] and v.missing == []
    assert v.per_note == [(64, "chord-tone"), (67, "chord-tone"), (70, "extra")]
    assert match_pitches([64, 67], [64, 67]).ok


# ── codec ───────────────────────────────────────────────────────────────────
def test_parse_pitch_and_front_round_trip():
    assert parse_pitch("C4") == 60 and parse_pitch("Bb3") == 58 and parse_pitch("F#2") == 42
    assert pitch_front((67, 64), "treble") == "E4+G4 treble"
    item = item_for_pitch_front("E4+G4 treble")
    assert item.pitches == (64, 67) and item.clef == "treble" and item.is_pitch
    assert item.level is Level.PITCH
    assert item.staff() == {"clef": "treble", "pitches": [64, 67], "key": "C"}
    assert item_for_pitch_front("G7") is None
    assert item_for_pitch_front("E4 alto") is None
    assert item_for_pitch_front("H4 treble") is None


def test_item_for_front_dispatches_notes_before_chords():
    assert item_for_front("F2 bass").pitches == (41,)
    assert item_for_front("G7").chord.text == "G7" and not item_for_front("G7").is_pitch
    for deck in ("reading-treble", "reading-bass", "reading-grand", "reading-intervals"):
        for front in seed_fronts(deck):
            decoded = item_for_front(front)
            assert decoded is not None and decoded.is_pitch, front
            assert pitch_front(decoded.pitches, decoded.clef) == front
    for front in seed_fronts("reading-chords"):
        assert item_for_front(front).chord.text == front


# ── decks ───────────────────────────────────────────────────────────────────
def test_reading_decks_shape():
    decks = reading_decks()
    assert set(decks) == {"reading-treble", "reading-bass", "reading-grand",
                          "reading-intervals", "reading-chords"}
    assert len(decks["reading-treble"]) == TREBLE_RANGE[1] - TREBLE_RANGE[0] + 1
    assert len(decks["reading-bass"]) == BASS_RANGE[1] - BASS_RANGE[0] + 1
    assert all(it.clef == "bass" for it in decks["reading-bass"])
    assert all(len(it.pitches) == 2 for it in decks["reading-intervals"])
    assert all(not it.is_pitch and it.level is Level.LOOSE for it in decks["reading-chords"])
    assert set(decks) <= set(builtin_decks())          # merged, so the trainer drills them
    assert "Dm7" in seed_fronts("reading-chords")


# ── engine: the pitch branch ────────────────────────────────────────────────
def test_engine_grades_pitch_items_by_exact_pitch():
    events = []
    items = [DrillItem(prompt="E4", chord=parse_chord("C"), level=Level.PITCH, pitches=(64,)),
             DrillItem(prompt="E4 any", chord=parse_chord("C"), level=Level.PITCH,
                       pitches=(64,), octave_exact=False)]
    eng = DrillEngine(items, on_event=lambda n, p: events.append((n, p)))
    tr = NoteTracker()
    eng.start(0.0)
    assert eng.results[0].check == {"pitches": [64], "level": "pitch", "octave_exact": True}
    tr.feed(MidiEvent(1.0, "note_on", 52, 90))           # E3: right class, wrong octave
    eng.feed(1.5, tr)
    assert eng.idx == 0 and not eng.results[0].attempts[-1]["ok"]
    tr.feed(MidiEvent(2.0, "note_off", 52, 0))
    tr.feed(MidiEvent(2.1, "note_on", 64, 90))
    eng.feed(2.6, tr)
    assert eng.results[0].passed and eng.idx == 1
    tr.feed(MidiEvent(3.0, "note_off", 64, 0))            # hands off arms item 2
    tr.feed(MidiEvent(3.5, "note_on", 76, 90))            # E5 passes the any-octave item
    eng.feed(4.0, tr)
    assert eng.done and eng.results[1].passed
    assert [e[0] for e in events] == ["prompt", "attempt", "attempt", "passed",
                                      "prompt", "attempt", "passed", "done"]


# ── trainer over the socket: the staff payload ──────────────────────────────
def test_trainer_prompt_carries_staff_for_reading_decks():
    world = make_world()
    client, service = make_client(world)
    service.tick()
    with ws_connect(client) as ws:
        recv_until(ws, "hello")
        ws.send_json({"type": "start", "deck": "reading-bass"})
        prompt = recv_until(ws, "prompt")
        assert prompt["chord"] is None and prompt["level"] == "pitch"
        assert prompt["staff"]["clef"] == "bass" and len(prompt["staff"]["pitches"]) == 1
        status = client.get("/api/trainer/status").json()["drill"]
        assert status["staff"] == prompt["staff"] and status["chord"] is None
        press(world, [prompt["staff"]["pitches"][0]])
        settle(service)
        passed = recv_until(ws, "passed")
        assert passed["idx"] == 0 and passed["grade"]["label"] in ("Easy", "Good", "Hard")
    # A chord deck still reports no staff.
    with ws_connect(client) as ws:
        recv_until(ws, "hello")
        ws.send_json({"type": "start", "deck": "triads"})
        prompt = recv_until(ws, "prompt")
        assert prompt["staff"] is None and prompt["chord"]
