"""MIDI device I/O — the never-raise, lock-serialized mido wrapper.

Adapted from synth's MidiBackend (proven pattern): all sends under one RLock,
a failed send closes ports and returns False instead of raising, and
``midi_module`` lets tests inject a fake mido-shaped module.

This side of the platform is input-first (the keyboard), with output kept for
the instrument/drums milestones.
"""

from __future__ import annotations

import threading
import time

ALL_NOTES_OFF_CC = 123


class MidiIO:
    def __init__(self, midi_module=None) -> None:
        if midi_module is None:
            import mido
            midi_module = mido
        self._mido = midi_module
        self._input = None
        self._output = None
        self._in_name: str | None = None
        self._out_name: str | None = None
        self._channel = 0
        self._lock = threading.RLock()

    # ── discovery ──────────────────────────────────────────────────────────
    def input_names(self) -> list[str]:
        return self._mido.get_input_names()

    def output_names(self) -> list[str]:
        return self._mido.get_output_names()

    def first_keyboard(self, exclude: tuple[str, ...] = ("s-1", "iac")) -> str | None:
        """First input port that isn't an excluded device (case-insensitive)."""
        for name in self.input_names():
            if not any(x in name.lower() for x in exclude):
                return name
        return None

    # ── connection ─────────────────────────────────────────────────────────
    @property
    def channel(self) -> int:
        """0-indexed channel that note/CC sends go out on (default 0)."""
        return self._channel

    @channel.setter
    def channel(self, ch: int) -> None:
        self._channel = max(0, min(15, int(ch)))

    @property
    def input_connected(self) -> bool:
        return self._input is not None

    @property
    def input_name(self) -> str | None:
        return self._in_name

    def open_input(self, name: str) -> None:
        with self._lock:
            self._close_input_locked()
            self._input = self._mido.open_input(name)
            self._in_name = name

    def open_output(self, name: str) -> None:
        with self._lock:
            self._close_output_locked()
            self._output = self._mido.open_output(name)
            self._out_name = name

    def close(self) -> None:
        with self._lock:
            self._close_input_locked()
            self._close_output_locked()

    def _close_input_locked(self) -> None:
        if self._input:
            try:
                self._input.close()
            except Exception:
                pass
            self._input = None
        self._in_name = None

    def _close_output_locked(self) -> None:
        if self._output:
            try:
                self._output.close()
            except Exception:
                pass
            self._output = None
        self._out_name = None

    # ── input ──────────────────────────────────────────────────────────────
    def poll(self, types: tuple[str, ...] = ("note_on", "note_off"),
             ) -> list[tuple[str, int, int, int, float]]:
        """Drain pending input → [(type, data1, data2, ch, monotonic_t)].

        Only messages whose type is in ``types`` survive; the default keeps the
        note-only behaviour every existing caller relies on. ``data1``/``data2``
        are (note, velocity) for note messages and (control, value) for
        ``control_change`` — the S-1's knob feedback rides that second shape.
        Timestamps are ours, not the device's. A dead port closes quietly.
        """
        with self._lock:
            if self._input is None:
                return []
            out = []
            try:
                for msg in self._input.iter_pending():
                    if msg.type not in types:
                        continue
                    now = time.monotonic()
                    if msg.type == "control_change":
                        d1, d2 = msg.control, msg.value
                    else:
                        d1, d2 = msg.note, getattr(msg, "velocity", 0)
                    out.append((msg.type, d1, d2, getattr(msg, "channel", 0), now))
            except Exception:
                self._close_input_locked()
            return out

    # ── output (instrument/drums milestones) ───────────────────────────────
    def _send(self, msg) -> bool:
        with self._lock:
            if self._output is None:
                return False
            try:
                self._output.send(msg)
                return True
            except Exception:
                self._close_output_locked()
                return False

    def send_note_on(self, note: int, velocity: int = 100) -> bool:
        return self._send(self._mido.Message(
            "note_on", channel=self._channel, note=note, velocity=velocity))

    def send_note_off(self, note: int) -> bool:
        return self._send(self._mido.Message(
            "note_off", channel=self._channel, note=note, velocity=0))

    def all_notes_off(self) -> bool:
        return self._send(self._mido.Message(
            "control_change", channel=self._channel, control=ALL_NOTES_OFF_CC, value=0))

    def send_cc(self, cc: int, value: int, channel: int | None = None) -> bool:
        """Control Change. ``channel`` overrides the port's channel for one send."""
        ch = self._channel if channel is None else max(0, min(15, int(channel)))
        return self._send(self._mido.Message(
            "control_change", channel=ch, control=max(0, min(127, int(cc))),
            value=max(0, min(127, int(value)))))

    def send_program_change(self, program: int, channel: int | None = None) -> bool:
        """Program Change — pattern select on hardware that listens for it
        (the S-1 uses a dedicated channel, device default 16)."""
        ch = self._channel if channel is None else max(0, min(15, int(channel)))
        return self._send(self._mido.Message(
            "program_change", channel=ch, program=max(0, min(127, int(program)))))
