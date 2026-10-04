"""MIDI substrate: device I/O, event capture (JSONL v1), NoteTracker, replay.

Layer: substrate. May import: theory (nothing else).
"""

from music.midio.backend import MidiIO
from music.midio.capture import Recorder
from music.midio.events import MidiEvent, read_records
from music.midio.notes import NoteTracker
from music.midio.replay import replay_into

__all__ = ["MidiIO", "Recorder", "MidiEvent", "read_records", "NoteTracker", "replay_into"]
