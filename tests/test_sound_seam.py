"""Sound seam: driver table, switching, the raw `note` firehose, note listeners."""
from fastapi.testclient import TestClient

from music.web.server import create_app
from tests.fakes import FakeMessage, FakeMidiWorld

PORT = "KeyLab 61 MIDI OUT"


def _client():
    world = FakeMidiWorld()
    world.add_device(in_name=PORT)
    app = create_app(midi_module=world)
    return app, TestClient(app, base_url="http://localhost:8768"), world


def _press(world, note, vel):
    world.inputs[PORT].pending.append(FakeMessage("note_on", note=note, velocity=vel))


def test_driver_table_and_default():
    _, c, _ = _client()
    st = c.get("/api/sound").json()
    ids = [d["id"] for d in st["drivers"]]
    assert ids == ["samples", "twin", "off"]      # E-piano (default) · S-1 twin · Off
    assert st["driver"] == "samples"


def test_the_choice_survives_a_restart():
    _, c, _ = _client()
    assert c.post("/api/sound/driver", json={"driver": "twin"}).status_code == 200
    _, again, _ = _client()                       # a new app: the cockpit restarted
    assert again.get("/api/sound").json()["driver"] == "twin"


def test_switch_browser_driver_publishes():
    app, c, _ = _client()
    seen = []
    app.state.hub.subscribe(seen.append)
    r = c.post("/api/sound/driver", json={"driver": "off"})
    assert r.status_code == 200 and r.json()["driver"] == "off"
    assert {"type": "sound", "driver": "off"} in seen
    assert c.post("/api/sound/driver", json={"driver": "nope"}).status_code == 404


def test_raw_note_event_published():
    app, _, world = _client()
    seen = []
    app.state.hub.subscribe(seen.append)
    svc = app.state.service
    svc.tick()                       # opens the fake port
    _press(world, 60, 90); svc.tick()
    _press(world, 60, 0); svc.tick()  # vel 0 → note_off
    notes = [e for e in seen if e["type"] == "note"]
    assert notes[0] == {"type": "note", "on": True, "note": 60, "vel": 90}
    assert notes[1]["on"] is False and notes[1]["note"] == 60


def test_note_listener_is_fed_and_isolated():
    app, _, world = _client()
    got = []
    svc = app.state.service
    svc.add_note_listener(lambda *a: got.append(a))
    svc.add_note_listener(lambda *a: 1 / 0)   # a broken synth must not stop the trainer
    svc.tick()
    _press(world, 64, 70); svc.tick()
    assert got == [("note_on", 64, 70)]


def test_test_chord_rides_the_firehose_for_browser_drivers():
    app, c, _ = _client()
    seen = []
    app.state.hub.subscribe(seen.append)
    r = c.post("/api/sound/test")
    assert r.status_code == 200 and r.json()["via"] == "browser"
    assert {"type": "note", "on": True, "note": 60, "vel": 100} in seen


def test_virtual_notes_join_the_midi_stream():
    app, _, _ = _client()
    seen = []
    app.state.hub.subscribe(seen.append)
    svc = app.state.service
    svc.inject(True, 62, 80); svc.tick()
    assert svc.tracker.held == {62}
    assert {"type": "note", "on": True, "note": 62, "vel": 80} in seen
    svc.inject(False, 62); svc.tick()
    assert svc.tracker.held == set()
