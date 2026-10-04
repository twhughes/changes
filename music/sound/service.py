"""SoundService — holds the active driver, swaps it, feeds server-side ones.

The choice is remembered in ``sessions/sound/config.json`` (``MUSIC_SOUND_DIR`` moves it):
a restart keeps the sound Tyler picked instead of falling back to the default.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Callable

from music.sound.registry import BY_ID, DEFAULT_DRIVER, DRIVERS, DriverSpec

REPO_ROOT = Path(__file__).resolve().parents[2]


def config_path() -> Path:
    return Path(os.environ.get("MUSIC_SOUND_DIR", REPO_ROOT / "sessions" / "sound")) / "config.json"


def _saved() -> str | None:
    try:
        driver = json.loads(config_path().read_text(encoding="utf-8")).get("driver")
    except (OSError, ValueError, AttributeError):
        return None
    return driver if driver in BY_ID else None


class SoundService:
    def __init__(self, publish: Callable[[dict], None] | None = None,
                 default: str | None = None) -> None:
        self.publish = publish or (lambda event: None)
        self._lock = threading.Lock()
        self.driver_id = default or _saved() or DEFAULT_DRIVER
        self._server_driver = None      # live object for side == "server"

    # ── status ────────────────────────────────────────────────────────────
    def status(self) -> dict:
        rows = []
        for d in DRIVERS:
            ok, note = d.probe()
            rows.append({"id": d.id, "label": d.label, "side": d.side,
                         "available": ok, "note": note})
        return {"driver": self.driver_id, "drivers": rows}

    def spec(self) -> DriverSpec:
        return BY_ID[self.driver_id]

    # ── switching ─────────────────────────────────────────────────────────
    def set_driver(self, driver_id: str) -> dict:
        if driver_id not in BY_ID:
            raise KeyError(driver_id)
        spec = BY_ID[driver_id]
        with self._lock:
            if self._server_driver is not None:
                try:
                    self._server_driver.all_off()
                    self._server_driver.close()
                finally:
                    self._server_driver = None
            if spec.side == "server":
                ok, note = spec.probe()
                if not ok:
                    raise RuntimeError(note or f"{driver_id} unavailable")
                self._server_driver = spec.create()
            self.driver_id = driver_id
            self._save()
        self.publish({"type": "sound", "driver": driver_id})
        return {"driver": driver_id}

    def _save(self) -> None:
        """Best-effort: a read-only disk costs only the memory of the choice."""
        path = config_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"driver": self.driver_id}) + "\n", encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            pass

    # ── the trainer's raw note hook ───────────────────────────────────────
    def on_note(self, type_: str, note: int, vel: int) -> None:
        drv = self._server_driver
        if drv is None:
            return
        if type_ == "note_on":
            drv.note_on(note, vel)
        elif type_ == "note_off":
            drv.note_off(note)

    def test_chord(self, notes=(60, 64, 67), hold_s: float = 0.6) -> dict:
        """Play a chord on the active *server* driver — a diagnostic for 'is it silent?'.

        Browser drivers can't be driven from here; the `note` firehose is
        published instead so the page plays it."""
        drv = self._server_driver
        if drv is None:
            for n in notes:
                self.publish({"type": "note", "on": True, "note": n, "vel": 100})
            threading.Timer(hold_s, lambda: [self.publish(
                {"type": "note", "on": False, "note": n, "vel": 0}) for n in notes]).start()
            return {"played": list(notes), "via": "browser"}
        for n in notes:
            drv.note_on(n, 100)
        threading.Timer(hold_s, lambda: [drv.note_off(n) for n in notes]).start()
        return {"played": list(notes), "via": self.driver_id}

    def close(self) -> None:
        with self._lock:
            if self._server_driver is not None:
                try:
                    self._server_driver.all_off()
                    self._server_driver.close()
                finally:
                    self._server_driver = None
