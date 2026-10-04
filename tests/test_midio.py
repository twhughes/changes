"""midio: backend never-raise semantics, JSONL round-trip, tracker, replay."""

from music.midio.backend import MidiIO
from music.midio.capture import Recorder
from music.midio.events import MidiEvent, event_from_record, read_records
from music.midio.notes import NoteTracker
from music.midio.replay import replay_into
from tests.fakes import FakeMidiWorld


def test_backend_poll_and_first_keyboard():
    world = FakeMidiWorld()
    world.add_device(in_name="S-1 MIDI OUT")
    world.add_device(in_name="KeyLab 61 MIDI OUT")
    io = MidiIO(midi_module=world)
    assert io.first_keyboard() == "KeyLab 61 MIDI OUT"
    io.open_input("KeyLab 61 MIDI OUT")
    world.key("KeyLab 61 MIDI OUT", "note_on", 60, 90)
    world.key("KeyLab 61 MIDI OUT", "note_off", 60, 0)
    polled = io.poll()
    assert [(p[0], p[1]) for p in polled] == [("note_on", 60), ("note_off", 60)]
    assert all(isinstance(p[4], float) for p in polled)


def test_backend_never_raises_on_dead_port():
    world = FakeMidiWorld()
    world.add_device(in_name="kb", out_name="synth")
    io = MidiIO(midi_module=world)
    io.open_input("kb")
    io.open_output("synth")
    world.inputs["kb"].closed = True
    world.outputs["synth"].fail_next_send = True
    # iter_pending on a closed fake port still works; simulate failure via send
    assert io.send_note_on(60) is False
    assert io.send_note_on(60) is False  # now disconnected, still no raise


def test_vel0_normalizes_to_note_off():
    ev = MidiEvent.normalize("note_on", 60, 0, 0, 1.0)
    assert ev.type == "note_off"


def test_recorder_jsonl_round_trip(tmp_path):
    path = tmp_path / "cap.jsonl"
    rec = Recorder(path, port="kb", t0=100.0)
    rec.event("note_on", 55, 92, 0, 101.2341)
    rec.mark("item:0:prompt", 101.5)
    rec.event("note_on", 59, 88, 0, 101.9)
    rec.close()
    records = read_records(path)
    assert records[0]["kind"] == "header" and records[0]["v"] == 1
    assert records[1] == {"kind": "ev", "t": 1.2341, "type": "note_on",
                          "note": 55, "vel": 92, "ch": 0}
    assert records[2] == {"kind": "mark", "t": 1.5, "label": "item:0:prompt"}
    ev = event_from_record(records[3])
    assert (ev.note, ev.t) == (59, 1.9)


def test_tracker_stability():
    tr = NoteTracker()
    tr.feed(MidiEvent(1.0, "note_on", 60, 90))
    tr.feed(MidiEvent(1.1, "note_on", 64, 90))
    assert tr.stable_held(1.2, 0.3) is None          # not stable yet
    assert tr.stable_held(1.5, 0.3) == frozenset({60, 64})
    tr.feed(MidiEvent(1.6, "note_off", 64, 0))
    assert tr.stable_held(1.7, 0.3) is None          # changed
    tr.feed(MidiEvent(1.8, "note_off", 60, 0))
    assert tr.stable_held(5.0, 0.3) is None          # empty never stable


def test_replay_reproduces_tracker_states(tmp_path):
    path = tmp_path / "cap.jsonl"
    rec = Recorder(path, port="kb", t0=0.0)
    for i, note in enumerate([55, 59, 62, 65]):      # roll a G7
        rec.event("note_on", note, 90, 0, 1.0 + i * 0.05)
    rec.mark("chord-down", 1.2)
    rec.close()

    stable_seen = []

    def on_time(t, tracker):
        s = tracker.stable_held(t, 0.3)
        if s and s not in stable_seen:
            stable_seen.append(s)

    marks = []
    replay_into(path, on_time, on_mark=lambda t, label: marks.append(label))
    assert stable_seen == [frozenset({55, 59, 62, 65})]
    assert marks == ["chord-down"]
