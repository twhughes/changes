"""Tests for the jazz-automaticity additions: shells/inversions/progression
decks, the DrillEngine's progression stepping, and the phase-advance seed."""

from __future__ import annotations

import pytest

from music.learn.decks import DECK_INFO, MENU, builtin_decks
from music.learn.drill import DrillEngine, DrillItem
from music.midio.events import MidiEvent
from music.midio.notes import NoteTracker
from music.theory.chords import hint_voicing, parse_chord
from music.theory.match import Level, match
from music.trainer.service import TrainerService
from tests.fakes import FakeMidiWorld
from tests.test_web import press, settle


# ── the new decks ────────────────────────────────────────────
class TestDecks:
    def test_shells_are_strict_sevenths_in_all_keys(self):
        deck = builtin_decks()["shells"]
        assert len(deck) == 36
        assert all(i.level is Level.STRICT for i in deck)
        assert all("shell" in i.prompt for i in deck)

    def test_inversions_pin_the_bass(self):
        deck = builtin_decks()["inversions"]
        assert len(deck) == 72
        assert all(i.level is Level.INVERSION for i in deck)
        first = deck[0]                      # C7/E
        assert first.chord.expected_bass_pc == 4

    def test_two_five_one_is_twelve_atomic_progressions(self):
        deck = builtin_decks()["two-five-one"]
        assert len(deck) == 12
        item = deck[0]
        assert [c.text for c in item.seq] == ["Dm7", "G7", "Cmaj7"]
        assert "ii–V–I in C" in item.prompt

    def test_four_five_one_transposes(self):
        deck = builtin_decks()["four-five-one"]
        texts = [[c.text for c in i.seq] for i in deck]
        assert ["F", "G", "C"] in texts
        assert ["Gb", "Ab", "Db"] in texts   # flat-side respelling

    def test_single_item_seq_is_just_the_chord(self):
        item = DrillItem(prompt="Play C", chord=parse_chord("C"))
        assert item.seq == (item.chord,)

    def test_the_jazz_progressions_in_c(self):
        """Tyler, 2026-10-04: "focus on the common ones, especially jazz ones"."""
        firsts = {name: [c.text for c in builtin_decks()[name][0].seq]
                  for name in ("tritone-sub", "backdoor")}
        assert firsts == {"tritone-sub": ["Dm7", "Db7", "Cmaj7"],
                          "backdoor": ["Fm7", "Bb7", "Cmaj7"]}
        assert builtin_decks()["backdoor"][0].prompt.startswith("iv–♭VII7–I in C:")
        assert "four-five-one" not in MENU and "four-five-one" in builtin_decks()

    def test_every_menu_deck_says_what_it_is(self):
        assert set(DECK_INFO) == set(MENU)
        for group, title, blurb in DECK_INFO.values():
            assert group in ("chords", "progressions") and title and "all 12 keys" in blurb

    def test_advanced_is_the_jazz_chords_and_their_altered_notes_count(self):
        deck = builtin_decks()["advanced"]
        assert len(deck) == 48 and all(i.level is Level.LOOSE for i in deck)
        assert [i.chord.text for i in deck[::12]] == ["Cm7b5", "Cdim7", "C7sus4", "C7#5"]
        # A near miss never passes: the altered 5th and the sus 4th are required.
        near = {"Cm7b5": (48, 51, 55, 58),      # Cm7 — a perfect 5th, not ♭5
                "Cdim7": (48, 51, 54, 58),      # Cm7♭5 — B♭, not A
                "C7sus4": (48, 52, 55, 58),     # C7 — the 3rd, not the 4th
                "C7#5": (48, 52, 55, 58)}       # C7 — a perfect 5th, not ♯5
        for text, notes in near.items():
            assert not match(notes, parse_chord(text)).ok, text
            assert match(hint_voicing(parse_chord(text)), parse_chord(text)).ok, text


# ── "Show keys": the trainer sends each chord's hint voicing ─────────────────
def test_hint_voicing_puts_the_bass_low_and_the_rest_above_middle_c():
    assert hint_voicing(parse_chord("Dm7")) == [50, 60, 65, 69]      # D low; F A C above
    assert hint_voicing(parse_chord("C7/E")) == [52, 60, 67, 70]
    assert hint_voicing(parse_chord("Db7")) == [49, 65, 68, 71]


def test_prompt_and_step_carry_the_hint_notes():
    world = FakeMidiWorld()
    world.add_device(in_name="KeyLab 61 MIDI OUT")
    events: list[dict] = []
    service = TrainerService(midi_module=world, publish=events.append)
    service.tick()
    assert service.start_drill("tritone-sub") is True
    prompt = [e for e in events if e["type"] == "prompt"][0]
    first = parse_chord(prompt["chord"])
    assert prompt["notes"] == hint_voicing(first)
    press(world, hint_voicing(first))
    settle(service)
    step = [e for e in events if e["type"] == "step"][0]
    assert step["notes"] == hint_voicing(parse_chord(step["chord"]))
    assert service.status()["drill"]["notes"] == step["notes"]     # a reload resumes the hint


# ── progression stepping in the engine ───────────────────────
def _prog_engine():
    events = []
    chords = tuple(parse_chord(t) for t in ("Dm7", "G7", "Cmaj7"))
    item = DrillItem(prompt="ii–V–I in C", chord=chords[0], chords=chords,
                     level=Level.LOOSE, debounce_s=0.3)
    eng = DrillEngine([item], on_event=lambda name, p: events.append((name, p)))
    return eng, events


def _play(tracker, eng, t, notes_on=(), notes_off=()):
    for n in notes_on:
        tracker.feed(MidiEvent(t, "note_on", n, 90))
    for n in notes_off:
        tracker.feed(MidiEvent(t, "note_off", n, 0))
    eng.feed(t, tracker)


DM7 = (50, 53, 57, 60)
G7 = (55, 59, 62, 65)
CMAJ7 = (48, 52, 55, 59)


class TestProgressionEngine:
    def test_steps_through_and_passes_first_try(self):
        eng, events = _prog_engine()
        tr = NoteTracker()
        eng.start(0.0)
        _play(tr, eng, 1.0, notes_on=DM7)
        eng.feed(1.4, tr)                       # debounce elapses -> graded
        assert ("step", {"idx": 0, "step": 1, "of": 3, "chord": "G7"}) in events
        _play(tr, eng, 2.0, notes_off=DM7)
        _play(tr, eng, 2.5, notes_on=G7)
        eng.feed(2.9, tr)
        assert any(n == "step" and p["chord"] == "Cmaj7" for n, p in events)
        _play(tr, eng, 3.5, notes_off=G7)
        _play(tr, eng, 4.0, notes_on=CMAJ7)
        eng.feed(4.4, tr)
        passed = [p for n, p in events if n == "passed"]
        assert passed and passed[0]["first_try"] is True
        assert eng.done
        assert eng.results[0].check["chord"] == "Dm7 → G7 → Cmaj7"

    def test_wrong_step_breaks_first_try_but_not_the_run(self):
        eng, events = _prog_engine()
        tr = NoteTracker()
        eng.start(0.0)
        _play(tr, eng, 1.0, notes_on=DM7)
        eng.feed(1.4, tr)
        _play(tr, eng, 2.0, notes_off=DM7)
        _play(tr, eng, 2.5, notes_on=CMAJ7)     # wrong: skipped the V
        eng.feed(2.9, tr)
        _play(tr, eng, 3.5, notes_off=CMAJ7)
        _play(tr, eng, 4.0, notes_on=G7)
        eng.feed(4.4, tr)
        _play(tr, eng, 5.0, notes_off=G7)
        _play(tr, eng, 5.5, notes_on=CMAJ7)
        eng.feed(5.9, tr)
        passed = [p for n, p in events if n == "passed"]
        assert passed and passed[0]["first_try"] is False
        assert eng.results[0].passed


# ── phase-advance seeding ────────────────────────────────────
class TestSeedBuiltin:
    def _service(self, client):
        from music.trainer.service import TrainerService
        from tests.fakes import FakeMidiWorld

        return TrainerService(midi_module=FakeMidiWorld(), anki_client=client)

    def test_seed_builtin_adds_the_deck_to_review(self):
        """Through the review seam (§10): the built-in scheduler by default, no Anki."""
        svc = self._service(None)
        first = svc.seed_builtin("shells")
        assert first == {"backend": "local", "deck": "shells", "added": 36, "updated": 0,
                         "unchanged": 0, "total": 36}
        assert svc.seed_builtin("shells")["unchanged"] == 36       # reseeding is safe

    def test_progression_decks_seed_too(self):
        result = self._service(None).seed_builtin("two-five-one")
        assert result["added"] == 12 and result["deck"] == "two-five-one"

    def test_seed_builtin_rejects_unknown_and_cram_only_decks(self):
        svc = self._service(object())
        with pytest.raises(KeyError):
            svc.seed_builtin("nope")
        with pytest.raises(ValueError):
            svc.seed_builtin("sevenths-strict")   # cram-only: no Anki subdeck
