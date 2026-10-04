"""Cockpit shell: origin guard, view registry, and a real drill over the socket."""

import time

from fastapi.testclient import TestClient

from music.theory.chords import parse_chord
from music.trainer.service import TrainerService
from music.web.server import create_app
from tests.fakes import FakeMidiWorld

PORT_NAME = "KeyLab 61 MIDI OUT"
DEBOUNCE_PAD_S = 0.35   # DrillItem.debounce_s is 0.3 — real sleeps keep it honest


def make_world() -> FakeMidiWorld:
    world = FakeMidiWorld()
    world.add_device(in_name=PORT_NAME)
    return world


def make_client(world=None):
    """A client whose Host header is localhost (the guard's happy path)."""
    app = create_app(midi_module=world or make_world())
    return TestClient(app, base_url="http://localhost:8768"), app.state.service


def chord_notes(text: str) -> list[int]:
    """Any voicing of the symbol, one octave above middle C."""
    return sorted(60 + pc for pc in parse_chord(text).pcs())


def press(world, notes, port=PORT_NAME):
    for note in notes:
        world.key(port, "note_on", note, 90)


def settle(service, seconds=DEBOUNCE_PAD_S):
    """Poll, wait past the debounce, poll again — the grade lands on tick two."""
    service.tick()
    time.sleep(seconds)
    service.tick()


def ws_connect(client, host="localhost:8768"):
    """TestClient hardcodes ws://testserver, so spell the Host header out."""
    return client.websocket_connect("/ws/state", headers={"host": host})


def recv_until(ws, kind, limit=400):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg.get("type") == kind:
            return msg
    raise AssertionError(f"no {kind!r} event in {limit} messages")


# ── shell ──────────────────────────────────────────────────────────────────
def test_health_and_views():
    client, _ = make_client()
    assert client.get("/api/health").json() == {"ok": True}
    assert client.get("/api/views").json() == [{"id": "practice", "title": "Practice"}]


def test_decks_endpoint():
    client, _ = make_client()
    decks = client.get("/api/trainer/decks").json()
    assert "triads" in decks and "sevenths" in decks


def test_origin_guard_rejects_foreign_host_and_origin():
    app = create_app(midi_module=make_world())
    evil = TestClient(app, base_url="http://evil.com")
    assert evil.get("/api/health").status_code == 403

    local = TestClient(app, base_url="http://localhost:8768")
    assert local.get("/api/health").status_code == 200
    assert local.get("/api/health", headers={"Origin": "http://evil.com"}).status_code == 403
    assert local.get("/api/health",
                     headers={"Origin": "http://127.0.0.1:8768"}).status_code == 200


def test_status_reports_the_connected_port():
    client, service = make_client()
    assert client.get("/api/trainer/status").json()["midi_port"] is None
    service.tick()                                    # auto-connects
    status = client.get("/api/trainer/status").json()
    assert status["midi_port"] == PORT_NAME
    assert status["drill"] == {"active": False, "deck": None, "idx": -1,
                               "total": 0, "streak": 0,
                               "prompt": None, "chord": None, "level": None,
                               "staff": None, "ref": None, "recall": False, "step": 0,
                               "notes": None}


# ── the socket ─────────────────────────────────────────────────────────────
def test_ws_hello_then_start_prompts():
    client, service = make_client()
    with ws_connect(client) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        assert hello["status"]["drill"]["active"] is False
        assert hello["views"] == [{"id": "practice", "title": "Practice"}]

        ws.send_json({"type": "start", "deck": "triads"})
        prompt = recv_until(ws, "prompt")
        assert prompt["idx"] == 0 and prompt["total"] == 24   # triads = 12 major + 12 minor
        assert parse_chord(prompt["chord"])            # a real chord symbol
        assert service.status()["drill"]["active"] is True


def test_playing_the_prompted_chord_passes_over_the_socket():
    world = make_world()
    client, service = make_client(world)
    with ws_connect(client) as ws:
        ws.receive_json()                              # hello
        ws.send_json({"type": "start", "deck": "triads"})
        prompt = recv_until(ws, "prompt")

        service.tick()                                 # opens the fake port
        assert service.status()["midi_port"] == PORT_NAME
        press(world, chord_notes(prompt["chord"]))
        settle(service)

        held = recv_until(ws, "held")
        assert held["notes"] == chord_notes(prompt["chord"])
        passed = recv_until(ws, "passed")
        assert passed["idx"] == 0 and passed["first_try"] is True
        assert passed["streak"] == 1 and passed["latency_s"] >= 0
        assert recv_until(ws, "prompt")["idx"] == 1     # advanced


def test_ws_stop_ends_the_session_with_a_summary():
    world = make_world()
    client, service = make_client(world)
    with ws_connect(client) as ws:
        ws.receive_json()
        ws.send_json({"type": "start", "deck": "triads"})
        prompt = recv_until(ws, "prompt")
        service.tick()
        press(world, chord_notes(prompt["chord"]))
        settle(service)
        recv_until(ws, "passed")

        ws.send_json({"type": "stop"})
        done = recv_until(ws, "done")
        assert done["summary"]["passed"] == 1
        assert done["summary"]["mean_latency_s"] is not None
        assert service.status()["drill"]["active"] is False


def test_unknown_ws_message_is_ignored():
    client, service = make_client()
    with ws_connect(client) as ws:
        ws.receive_json()
        ws.send_json({"type": "nonsense"})
        ws.send_json({"type": "start", "deck": "triads"})
        assert recv_until(ws, "prompt")["idx"] == 0
        assert service.status()["drill"]["active"] is True


def test_unknown_deck_publishes_an_error():
    client, _ = make_client()
    with ws_connect(client) as ws:
        ws.receive_json()
        ws.send_json({"type": "start", "deck": "nope"})
        assert "nope" in recv_until(ws, "error")["message"]


# ── the service on its own (no loop, no socket) ────────────────────────────
def test_missed_card_requeues_and_breaks_the_streak():
    world = make_world()
    events: list[dict] = []
    service = TrainerService(midi_module=world, publish=events.append)
    service.tick()
    service.start_drill("triads")
    before = len(service.engine.items)
    notes = chord_notes([e for e in events if e["type"] == "prompt"][0]["chord"])

    press(world, notes[:1])                            # a miss: one tone only
    settle(service)
    press(world, notes[1:])                            # then the whole chord
    settle(service)

    passed = [e for e in events if e["type"] == "passed"][0]
    assert passed["first_try"] is False and passed["streak"] == 0
    assert len(service.engine.items) == before + 1     # the card comes back
    assert service.engine.items[3] is service.engine.items[0]


def test_skip_advances_and_resets_the_streak():
    world = make_world()
    events: list[dict] = []
    service = TrainerService(midi_module=world, publish=events.append)
    service.tick()
    service.start_drill("triads")
    service.skip()
    assert [e["type"] for e in events if e["type"] in ("skipped", "prompt")] == \
        ["prompt", "skipped", "prompt"]
    drill = service.status()["drill"]
    assert {k: drill[k] for k in ("active", "deck", "idx", "total", "streak")} == \
        {"active": True, "deck": "triads", "idx": 1, "total": 24, "streak": 0}
    # A mid-drill status carries the current item so late-joining clients can render it.
    assert drill["chord"] and drill["prompt"] and drill["level"] == "loose"


def test_held_publishes_are_throttled_to_the_changed_set():
    world = make_world()
    events: list[dict] = []
    service = TrainerService(midi_module=world, publish=events.append)
    service.tick()
    for _ in range(5):
        service.tick()                                 # idle ticks publish nothing
    assert [e for e in events if e["type"] == "held"] == []
    press(world, [60])
    service.tick()
    time.sleep(0.05)
    service.tick()
    assert [e["notes"] for e in events if e["type"] == "held"] == [[60]]


def test_held_carries_chord_names_and_pitch_classes():
    world = make_world()
    events: list[dict] = []
    service = TrainerService(midi_module=world, publish=events.append)
    service.tick()
    press(world, [55, 59, 62, 65])                     # G7 in root position
    service.tick()
    time.sleep(0.05)
    service.tick()

    held = [e for e in events if e["type"] == "held"][-1]
    assert held["notes"] == [55, 59, 62, 65]
    assert held["pcs"] == [2, 5, 7, 11]
    assert len(held["names"]) == 2                     # top-2 only
    assert held["names"][0] == {"name": "G7", "exact": True}


def test_held_names_are_empty_below_two_pitch_classes():
    world = make_world()
    events: list[dict] = []
    service = TrainerService(midi_module=world, publish=events.append)
    service.tick()
    press(world, [60, 72])                             # one pitch class, two octaves
    service.tick()
    time.sleep(0.05)
    service.tick()

    held = [e for e in events if e["type"] == "held"][-1]
    assert held["names"] == [] and held["pcs"] == [0]
