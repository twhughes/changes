"""Mido-shaped fakes so everything runs with zero hardware.

Pattern copied from synth/tests/fakes.py (the proven approach: tests control
time by pumping messages; opening a missing port raises like real mido).
"""

from __future__ import annotations


class FakeMessage:
    def __init__(self, type: str, note: int = 0, velocity: int = 0, channel: int = 0,
                 control: int = 0, value: int = 0, program: int = 0):
        self.type = type
        self.note = note
        self.velocity = velocity
        self.channel = channel
        self.control = control
        self.value = value
        self.program = program

    def __repr__(self) -> str:  # test failures should name the message, not an object id
        return (f"<{self.type} ch{self.channel} note={self.note} vel={self.velocity} "
                f"cc={self.control} val={self.value} prog={self.program}>")


class FakeMidiPort:
    def __init__(self, name: str):
        self.name = name
        self.sent: list = []
        self.pending: list = []
        self.closed = False
        self.fail_next_send = False

    def send(self, msg):
        if self.fail_next_send or self.closed:
            raise OSError("port gone")
        self.sent.append(msg)

    def iter_pending(self):
        msgs, self.pending = self.pending, []
        yield from msgs

    def close(self):
        self.closed = True


class FakeMidiWorld:
    """Patchable stand-in for the mido module surface MidiIO uses."""

    Message = FakeMessage

    def __init__(self):
        self.outputs: dict[str, FakeMidiPort] = {}
        self.inputs: dict[str, FakeMidiPort] = {}

    def add_device(self, out_name: str | None = None, in_name: str | None = None):
        if out_name:
            self.outputs.setdefault(out_name, FakeMidiPort(out_name))
        if in_name:
            self.inputs.setdefault(in_name, FakeMidiPort(in_name))

    def get_output_names(self):
        return list(self.outputs)

    def get_input_names(self):
        return list(self.inputs)

    def open_output(self, name):
        if name not in self.outputs:
            raise OSError(f"unknown port {name!r}")
        port = self.outputs[name]
        port.closed = False
        return port

    def open_input(self, name):
        if name not in self.inputs:
            raise OSError(f"unknown port {name!r}")
        port = self.inputs[name]
        port.closed = False
        return port

    def remove_device(self, out_name: str | None = None, in_name: str | None = None):
        """Unplug: the port disappears from the bus (an open handle goes dead)."""
        for name, ports in ((out_name, self.outputs), (in_name, self.inputs)):
            if name and name in ports:
                ports.pop(name).closed = True

    # test helper: put note messages on an input port's queue
    def key(self, port_name: str, type: str, note: int, vel: int = 90):
        self.inputs[port_name].pending.append(FakeMessage(type, note=note, velocity=vel))

    # test helper: put a control_change (a knob twist) on an input port's queue
    def knob(self, port_name: str, control: int, value: int, channel: int = 0):
        self.inputs[port_name].pending.append(
            FakeMessage("control_change", control=control, value=value, channel=channel))
