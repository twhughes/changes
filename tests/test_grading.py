"""Grade policy v2 (CONTRACTS.md §7) and the Anki Front codec round-trip."""

from __future__ import annotations

import pytest

from music.learn.anki import SUBDECKS
from music.learn.decks import builtin_decks, item_for_front, seed_fronts
from music.learn.grading import grade
from music.theory.match import Level


def ok(latency=1.0):
    return {"ok": True, "missing": [], "extra": [], "latency_s": latency}


def miss(notes_off=1):
    return {"ok": False, "missing": list(range(notes_off)), "extra": [],
            "latency_s": 1.0}


# ── the grade table ────────────────────────────────────────────────────────
@pytest.mark.parametrize("attempts,latency,ease,accuracy,speed", [
    ([ok()], 1.9, 4, "clean", "fast"),
    ([ok()], 2.0, 3, "clean", "ok"),
    ([ok()], 5.9, 3, "clean", "ok"),
    ([ok()], 6.0, 2, "clean", "slow"),
    ([ok()], 30.0, 2, "clean", "crawl"),        # perfect but 30 s = Hard, not Easy
    ([miss(1), ok()], 1.5, 2, "slip", "fast"),  # one small slip caps at Hard...
    ([miss(2), ok()], 5.0, 2, "slip", "ok"),
    ([miss(1), ok()], 12.0, 1, "slip", "slow"),  # ...unless the recovery crawled
    ([miss(3), ok()], 3.0, 1, "rough", "ok"),   # 3 notes off is no longer a slip
    ([miss(1), miss(1), ok()], 3.0, 1, "rough", "ok"),
    ([miss(1)] * 4 + [ok()], 3.0, 1, "fail", "ok"),  # "really really messed up"
])
def test_grade_table(attempts, latency, ease, accuracy, speed):
    g = grade(attempts, latency)
    assert (g["ease"], g["accuracy"]["tier"], g["speed"]["tier"]) == (ease, accuracy, speed)


def test_breakdown_counts_wrong_attempts_and_worst_notes_off():
    g = grade([miss(2), miss(3), ok()], 4.0)
    assert g["accuracy"] == {"tier": "rough", "wrong": 2, "notes_off": 3}
    assert g["label"] == "Again"


def test_speed_budget_scales_with_chords_per_card():
    # a 3-chord ii–V–I gets 3× the budget: 5 s clean is still "fast"
    assert grade([ok()] * 3, 5.0, steps=3)["speed"]["tier"] == "fast"
    assert grade([ok()] * 3, 17.0, steps=3)["ease"] == 3      # <18 s → ok → Good
    assert grade([ok()], 5.0, steps=1)["speed"]["tier"] == "ok"


# ── the Front codec ────────────────────────────────────────────────────────
class TestFrontCodec:
    def test_plain_chord_is_any_voicing(self):
        item = item_for_front("G7")
        assert item.level is Level.LOOSE and item.prompt == "Play G7 — any voicing"

    def test_shell_suffix_is_strict(self):
        item = item_for_front("C7 shell")
        assert item.level is Level.STRICT and "shell" in item.prompt

    def test_slash_chord_is_an_inversion(self):
        item = item_for_front("C7/E")
        assert item.level is Level.INVERSION and item.chord.expected_bass_pc == 4

    def test_progression_front_transposes_to_the_key(self):
        item = item_for_front("ii–V–I in Ab")
        assert [c.text for c in item.seq] == ["Bbm7", "Eb7", "Abmaj7"]
        assert item.prompt.startswith("ii–V–I in Ab:")

    def test_junk_fronts_are_not_ours(self):
        assert item_for_front("what is a tritone?") is None
        assert item_for_front("") is None

    def test_every_seedable_deck_round_trips_exactly(self):
        for name in SUBDECKS:
            items = builtin_decks()[name]
            decoded = [item_for_front(front) for front in seed_fronts(name)]
            assert [d.prompt for d in decoded] == [i.prompt for i in items], name
            assert [d.level for d in decoded] == [i.level for i in items], name
            assert [tuple(c.text for c in d.seq) for d in decoded] == \
                   [tuple(c.text for c in i.seq) for i in items], name
