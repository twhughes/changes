"""The review seam (CONTRACTS.md §10): the built-in scheduler, the Anki adapter,
the switch between them, and the trainer drilling a review session with no Anki.
"""

from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from music.learn.anki import SUBDECKS, AnkiClient
from music.srs import CardSpec, Review
from music.srs.anki import AnkiScheduler
from music.srs.local import SRS_POLICY, LocalScheduler, card_id
from music.trainer.service import TrainerService
from music.web.server import create_app
from tests.fakes import FakeMidiWorld
from tests.test_songs_api import FakeAnki
from tests.test_web import PORT_NAME, chord_notes, press, settle

T0 = datetime(2026, 10, 3, 9, 0, 0)


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, **kw):
        self.t += timedelta(**kw)


def local(tmp_path, clock=None):
    return LocalScheduler(tmp_path / "cards.json", clock=clock or Clock())


# ── the built-in scheduler ───────────────────────────────────────────────────
def test_add_is_idempotent_and_updates_in_place(tmp_path):
    srs = local(tmp_path)
    specs = [CardSpec("G7", "G7"), CardSpec("C7", "C7")]
    assert srs.add("sevenths", specs) == {"added": 2, "updated": 0, "unchanged": 0, "total": 2}
    assert srs.add("sevenths", specs)["unchanged"] == 2
    moved = srs.add("sevenths", [CardSpec("G7", "G7", back="G B D F")])
    assert moved["updated"] == 1 and srs.card(card_id("sevenths", "G7"))["back"] == "G B D F"


def test_new_cards_are_due_at_once_in_insertion_order(tmp_path):
    srs = local(tmp_path)
    srs.add("shells", [CardSpec(k, k) for k in ("C7 shell", "F7 shell", "Bb7 shell")])
    assert [c.front for c in srs.due()] == ["C7 shell", "F7 shell", "Bb7 shell"]
    assert srs.due("triads") == []
    assert srs.counts() == {"shells": {"cards": 3, "due": 3}}


def test_the_sm2_walk(tmp_path):
    clock = Clock()
    srs = local(tmp_path, clock)
    srs.add("t", [CardSpec("G7", "G7")])
    cid = card_id("t", "G7")
    assert srs.answer(cid, 1)                                   # Again: a minute
    assert srs.due() == []
    clock.advance(minutes=SRS_POLICY["again_minutes"])
    assert [c.front for c in srs.due()] == ["G7"]
    srs.answer(cid, 3)                                          # Good: graduates to a day
    card = srs.card(cid)
    assert card["state"] == "review" and card["interval"] == 1.0
    clock.advance(days=1)
    srs.answer(cid, 3)                                          # Good again: × ease
    grown = srs.card(cid)["interval"]
    assert grown >= 2.0
    clock.advance(days=grown)
    srs.answer(cid, 4)                                          # Easy: grows more, ease up
    assert srs.card(cid)["interval"] > grown * 2
    clock.advance(days=srs.card(cid)["interval"])
    srs.answer(cid, 1)                                          # a lapse relearns in minutes
    card = srs.card(cid)
    assert card["state"] == "learning" and card["lapses"] == 1
    assert card["ease"] >= SRS_POLICY["min_ease"]
    assert not srs.answer("nope", 3) and not srs.answer(cid, 7)


def test_learning_cards_come_before_reviews_and_new_ones(tmp_path):
    clock = Clock()
    srs = local(tmp_path, clock)
    srs.add("t", [CardSpec(k, k) for k in ("A", "B", "C")])
    srs.answer(card_id("t", "A"), 3)               # review, due tomorrow
    srs.answer(card_id("t", "B"), 1)               # learning, due in a minute
    clock.advance(days=2)
    assert [c.front for c in srs.due()] == ["B", "A", "C"]


def test_cards_survive_a_restart(tmp_path):
    srs = local(tmp_path)
    srs.add("t", [CardSpec("G7", "G7")])
    srs.answer(card_id("t", "G7"), 3)
    again = local(tmp_path)
    assert again.card(card_id("t", "G7"))["state"] == "review"


# ── the switch ───────────────────────────────────────────────────────────────
def test_review_defaults_to_built_in_and_remembers_the_choice(tmp_path):
    review = Review(tmp_path, anki_client=AnkiClient(transport=FakeAnki()))
    assert review.active().id == "local"
    status = review.status()
    assert status["backend"] == "local" and status["available"] is True
    assert {b["id"] for b in status["backends"]} == {"local", "anki"}
    review.set_backend("anki")
    assert Review(tmp_path).backend_id == "anki"                  # persisted
    try:
        review.set_backend("paper")
        raise AssertionError("unknown backend accepted")
    except KeyError:
        pass


def test_anki_closed_reads_as_unavailable(tmp_path):
    def closed(_payload):
        raise OSError("refused")
    review = Review(tmp_path, anki_client=AnkiClient(transport=closed))
    anki = next(b for b in review.status()["backends"] if b["id"] == "anki")
    assert anki["available"] is False and "closed" in anki["note"]


def test_the_anki_adapter_updates_by_key_and_counts_by_theme():
    fake = FakeAnki()                     # the stateful fake from the songs tests
    scheduler = AnkiScheduler(AnkiClient(transport=fake), lambda: dict(SUBDECKS))
    first = scheduler.add("shells", [CardSpec("C7 shell", "C7 shell")])
    assert first["added"] == 1
    assert scheduler.add("shells", [CardSpec("C7 shell", "C7 shell", "C E Bb")])["updated"] == 1
    assert list(fake.notes.values())[0]["Back"] == "C E Bb"


# ── the trainer drills a review session with no Anki ─────────────────────────
def test_a_review_session_on_the_built_in_scheduler(tmp_path):
    world = FakeMidiWorld()
    world.add_device(in_name=PORT_NAME)
    events = []
    review = Review(tmp_path)
    service = TrainerService(midi_module=world, publish=events.append, review=review)
    service.tick()
    assert service.seed_builtin("triads")["added"] == 24
    assert service.deck_names()[:2] == ["review", "review:triads"]
    assert service.start_drill("review:triads")
    prompt = [e for e in events if e["type"] == "prompt"][0]
    press(world, chord_notes(prompt["chord"]))
    settle(service)
    passed = [e for e in events if e["type"] == "passed"][0]
    assert passed["review_ease"] == 4 and passed["backend"] == "local"
    assert "anki_ease" not in passed
    assert review.local.counts()["triads"] == {"cards": 24, "due": 23}   # one moved to later


# ── the Practice menu (§11) ──────────────────────────────────────────────────
def test_practice_menu_and_srs_api():
    app = create_app(midi_module=FakeMidiWorld())
    client = TestClient(app, base_url="http://localhost:8768")
    menu = client.get("/api/practice").json()
    assert menu["review"] == {"backend": "local", "label": "Built-in", "available": True, "due": 0}
    # The menu v2 (§11): Chords and Progressions only — the jazz ones — as Tyler asked.
    assert [[d["id"] for d in g["decks"]] for g in menu["groups"]] == [
        ["triads", "sevenths", "advanced"],
        ["two-five-one", "minor-two-five-one", "turnaround", "tritone-sub", "backdoor"]]
    titles = [d["title"] for g in menu["groups"] for d in g["decks"]]
    assert titles == ["Triads", "Sevenths", "Advanced", "ii–V–I", "Minor ii–V–i", "Turnaround",
                      "Tritone sub", "Backdoor"]
    triads = menu["groups"][0]["decks"][0]
    assert triads["title"] == "Triads" and triads["cards"] == 24
    assert triads["in_review"] is False and triads["seedable"] is True
    assert menu["songs"] == []

    assert client.post("/api/trainer/seed", json={"builtin": "triads", "force": True}).json()[
        "added"] == 24
    menu = client.get("/api/practice").json()
    assert menu["review"]["due"] == 24
    assert menu["groups"][0]["decks"][0]["in_review"] is True

    assert client.get("/api/srs").json()["backend"] == "local"
    assert client.post("/api/srs/backend", json={"backend": "paper"}).status_code == 400
    assert client.post("/api/srs/backend", json={"backend": "anki"}).json()["backend"] == "anki"


def test_two_processes_never_overwrite_each_other(tmp_path):
    """The cockpit holds a cache; the CLI adds cards behind its back; nothing is lost."""
    cockpit, cli = local(tmp_path), local(tmp_path)
    cockpit.add("triads", [CardSpec("C", "C")])
    cli.add("song:x", [CardSpec("k", "X · A line 1 (start)")])
    cockpit.answer(card_id("triads", "C"), 3)
    themes = local(tmp_path).counts()
    assert set(themes) == {"triads", "song:x"}
