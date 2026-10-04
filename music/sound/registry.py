"""The driver table. Each driver = one row here + one module.

A driver module exposes ``create() -> driver`` (server side) or nothing (browser
side, the JS module under web/static/sound/<id>.js is the driver). ``probe()``
returns ``(available: bool, note: str)`` and must be cheap and never raise.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class DriverSpec:
    id: str
    label: str
    side: str                       # "browser" | "server" | "external"
    probe: Callable[[], tuple[bool, str]]
    create: Callable[[], object] | None = None   # server-side only


def _ok() -> tuple[bool, str]:
    return True, ""


# Tyler, 2026-10-04: "sound engine hook-in, with the S-1 twin as easy default, or the
# e-keyboard option" — then, once he had played both, "probably e-piano as default". FM,
# FluidSynth and Logic retired (RETIRED.md). "off" stays: a digital piano or a hardware
# synth already makes its own sound.
DRIVERS: list[DriverSpec] = [
    DriverSpec("samples", "E-piano", "browser", _ok),
    # The S-1 twin (hq/synth's browser engine, vendored in web/static/sound/twin/) on 8 voices.
    DriverSpec("twin", "S-1 twin", "browser", _ok),
    DriverSpec("off", "Off", "browser", _ok),
]
DEFAULT_DRIVER = "samples"

BY_ID = {d.id: d for d in DRIVERS}
