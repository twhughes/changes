"""The Anki bridge: AnkiConnect payloads, subdeck seeding, themed sessions, and
the trainer with (and without) Anki behind it. No network — the transport is
scripted. (The grade policy itself is tested in test_grading.py.)
"""

from music.learn.anki import DEFAULT_DECK, SUBDECKS, AnkiClient
from music.learn.decks import seed_fronts
from music.trainer.service import TrainerService
from tests.fakes import FakeMidiWorld
from tests.test_web import chord_notes, press, settle


class FakeTransport:
    """Scripted AnkiConnect: records payloads, answers per action."""

    def __init__(self, responses: dict | None = None, raises: Exception | None = None):
        self.responses = responses or {}
        self.raises = raises
        self.calls: list[dict] = []

    def __call__(self, payload: dict) -> dict:
        self.calls.append(payload)
        if self.raises is not None:
            raise self.raises
        canned = self.responses.get(payload["action"], {"result": None, "error": None})
        return dict(canned)

    def params(self, action: str) -> dict:
        return [c["params"] for c in self.calls if c["action"] == action][0]


def card_info(card_id: int, front: str, deck: str = DEFAULT_DECK) -> dict:
    return {"cardId": card_id, "deckName": deck,
            "fields": {"Front": {"value": front, "order": 0},
                       "Back": {"value": "", "order": 1}}}


def due_client(cards: list[tuple], answer=True) -> AnkiClient:
    """A client whose Anki is up with exactly these (id, front[, deck]) cards due."""
    transport = FakeTransport({
        "version": {"result": 6, "error": None},
        "findCards": {"result": [card[0] for card in cards], "error": None},
        "cardsInfo": {"result": [card_info(*card) for card in cards], "error": None},
        "answerCards": {"result": [answer], "error": None},
    })
    return AnkiClient(transport=transport)   # client.transport is the recorder


# ── the client ─────────────────────────────────────────────────────────────
def test_available_true_and_the_payload_shape():
    transport = FakeTransport({"version": {"result": 6, "error": None}})
    assert AnkiClient(transport=transport).available() is True
    assert transport.calls == [{"action": "version", "version": 6, "params": {}}]


def test_every_failure_mode_reads_as_unavailable():
    assert AnkiClient(transport=FakeTransport(raises=OSError("refused"))).available() is False
    error = FakeTransport({"version": {"result": None, "error": "collection is not available"}})
    assert AnkiClient(transport=error).available() is False
    assert AnkiClient(transport=lambda payload: "not json at all").available() is False


def test_ensure_deck_creates_by_name():
    transport = FakeTransport({"createDeck": {"result": 1699, "error": None}})
    assert AnkiClient(transport=transport).ensure_deck("Piano Chords") is True
    assert transport.calls[0] == {"action": "createDeck", "version": 6,
                                  "params": {"deck": "Piano Chords"}}


def test_seed_deck_adds_basic_notes_and_ignores_refused_duplicates():
    transport = FakeTransport({"addNotes": {"result": [101, None, 103], "error": None}})
    client = AnkiClient(transport=transport)
    assert client.seed_deck("Piano Chords", ["C7", "G7", "Bbmaj7"]) == 2
    notes = transport.params("addNotes")["notes"]
    assert [n["fields"] for n in notes] == [
        {"Front": "C7", "Back": ""}, {"Front": "G7", "Back": ""}, {"Front": "Bbmaj7", "Back": ""}]
    assert notes[0]["modelName"] == "Basic"
    assert notes[0]["deckName"] == "Piano Chords"
    assert notes[0]["options"] == {"allowDuplicate": False}


def test_seed_from_builtin_seeds_the_matching_subdeck():
    transport = FakeTransport({"createDeck": {"result": 1, "error": None},
                               "addNotes": {"result": [1] * 36, "error": None}})
    client = AnkiClient(transport=transport)
    assert client.seed_from_builtin("sevenths") == 36
    assert transport.params("createDeck") == {"deck": SUBDECKS["sevenths"]}
    notes = transport.params("addNotes")["notes"]
    assert all(n["deckName"] == SUBDECKS["sevenths"] for n in notes)
    fronts = [n["fields"]["Front"] for n in notes]
    assert fronts == seed_fronts("sevenths")
    assert len(fronts) == 36 and "G7" in fronts and "Cmaj7" in fronts


def test_seed_from_builtin_writes_progression_fronts():
    transport = FakeTransport({"createDeck": {"result": 1, "error": None},
                               "addNotes": {"result": [1] * 12, "error": None}})
    assert AnkiClient(transport=transport).seed_from_builtin("two-five-one") == 12
    fronts = [n["fields"]["Front"] for n in transport.params("addNotes")["notes"]]
    assert "ii–V–I in C" in fronts and "ii–V–I in Ab" in fronts


def test_due_cards_queries_due_and_new_and_strips_html_fronts():
    client = due_client([(11, "G7"), (12, "<div>Bbmaj7</div>"), (13, "&nbsp;")])
    assert client.due_cards("Piano Chords") == [
        (11, "G7", DEFAULT_DECK), (12, "Bbmaj7", DEFAULT_DECK)]
    assert client.transport.params("findCards") == {
        "query": 'deck:"Piano Chords" (is:due OR is:new)'}
    assert client.transport.params("cardsInfo") == {"cards": [11, 12, 13]}


def test_due_cards_is_empty_when_nothing_is_due_or_anki_is_gone():
    empty = AnkiClient(transport=FakeTransport({"findCards": {"result": [], "error": None}}))
    assert empty.due_cards("Piano Chords") == []
    assert AnkiClient(transport=FakeTransport(raises=OSError())).due_cards("Piano Chords") == []


def test_answer_presses_the_ease_button():
    client = due_client([(11, "G7")])
    assert client.answer(11, 3) is True
    assert client.transport.params("answerCards") == {"answers": [{"cardId": 11, "ease": 3}]}


def test_answer_is_false_when_the_addon_is_too_old_for_answer_cards():
    old = FakeTransport({"answerCards": {"result": None,
                                         "error": "unsupported action: answerCards"}})
    assert AnkiClient(transport=old).answer(11, 3) is False


# ── the trainer with Anki behind it (the review seam's anki backend, §10) ──
def make_service(anki=None):
    world = FakeMidiWorld()
    world.add_device(in_name="KeyLab 61 MIDI OUT")
    events: list[dict] = []
    service = TrainerService(midi_module=world, publish=events.append, anki_client=anki,
                             review_backend="anki")
    service.tick()                                  # auto-connects the fake port
    return world, service, events


def test_status_and_decks_offer_anki_when_cards_are_due():
    _, service, _ = make_service(due_client([(11, "G7")]))
    status = service.status()
    assert status["anki"] is True and status["review"] == {"backend": "anki", "available": True}
    assert status["decks"][0] == "review"
    assert "sevenths" in status["decks"]
    assert not any(d.startswith("review:") for d in status["decks"])  # legacy parent card


def test_decks_offer_a_theme_when_its_subdeck_has_cards():
    cards = [(21, "ii–V–I in Ab", SUBDECKS["two-five-one"]),
             (22, "C7 shell", SUBDECKS["shells"])]
    _, service, _ = make_service(due_client(cards))
    decks = service.deck_names()
    assert decks[0] == "review"
    assert "review:two-five-one" in decks and "review:shells" in decks
    assert "review:triads" not in decks


def test_an_anki_drill_answers_the_card_with_the_earned_ease():
    anki = due_client([(11, "G7")])
    world, service, events = make_service(anki)
    assert service.start_drill("anki-due") is True

    prompt = [e for e in events if e["type"] == "prompt"][0]
    assert prompt["chord"] == "G7" and prompt["prompt"] == "Play G7 — any voicing"
    assert prompt["total"] == 1

    press(world, chord_notes("G7"))
    settle(service)

    passed = [e for e in events if e["type"] == "passed"][0]
    assert passed["first_try"] is True
    assert passed["grade"]["label"] == "Easy" and passed["grade"]["accuracy"]["tier"] == "clean"
    assert passed["anki_ease"] == 4                   # clean + fast → Easy
    assert passed["review_ease"] == 4 and passed["backend"] == "anki"
    assert anki.transport.params("answerCards") == {"answers": [{"cardId": 11, "ease": 4}]}
    assert len(service.engine.items) == 1             # Anki owns rescheduling: no requeue
    assert [e for e in events if e["type"] == "done"]


def test_a_themed_drill_filters_by_subdeck_and_fills_from_the_builtin_deck():
    cards = [(21, "ii–V–I in Ab", SUBDECKS["two-five-one"]),
             (22, "C7 shell", SUBDECKS["shells"])]      # other theme: filtered out
    _, service, events = make_service(due_client(cards))
    assert service.start_drill("anki:two-five-one") is True

    prompt = [e for e in events if e["type"] == "prompt"][0]
    assert prompt["prompt"].startswith("ii–V–I in Ab:")
    # 1 due card + fill from the built-in deck's other 11 keys, no duplicates
    assert prompt["total"] == 12
    assert service._review_cards == {0: "21"}          # only the due card answers Anki
    prompts = [item.prompt for item in service.engine.items]
    assert len(set(prompts)) == 12


def test_anki_unreachable_behaves_exactly_like_before():
    dead = AnkiClient(transport=FakeTransport(raises=OSError("connection refused")))
    _, service, events = make_service(dead)
    status = service.status()
    assert status["anki"] is False
    assert status["decks"] == ["triads", "sevenths", "advanced", "two-five-one",
                               "minor-two-five-one", "turnaround", "tritone-sub",
                               "backdoor"]                              # the menu (§11 v2)
    assert service.start_drill("anki-due") is False
    assert [e["message"] for e in events if e["type"] == "error"] == ["nothing is due for review"]

    world, service, events = make_service(dead)
    assert service.start_drill("triads") is True
    press(world, chord_notes([e for e in events if e["type"] == "prompt"][0]["chord"]))
    settle(service)
    passed = [e for e in events if e["type"] == "passed"][0]
    assert "anki_ease" not in passed and passed["streak"] == 1
