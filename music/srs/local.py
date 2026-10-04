"""The built-in scheduler — spaced repetition with no Anki (CONTRACTS.md §10).

A small SM-2: new and lapsed cards walk short learning steps (minutes), then
graduate to review intervals in days that grow by the card's ease. Every knob
is in ``SRS_POLICY``; the trainer's grade policy supplies the ease (1 Again ·
2 Hard · 3 Good · 4 Easy), exactly what it would press in Anki.

Storage is one JSON file (``sessions/srs/cards.json``), rewritten atomically
on every change and re-read whenever another process (the ``python -m
music.songs review`` command, a second cockpit) changed it — the cache never
overwrites cards it has not seen. The clock is injected so tests can
fast-forward days.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from music.srs.base import CardSpec, DueCard

SRS_POLICY: dict = {
    "again_minutes": 1,          # a miss comes back within the session
    "hard_new_minutes": 10,      # a shaky new card comes back a little later
    "relearn_minutes": 10,       # a forgotten review card relearns in ten
    "graduate_days": 1.0,        # Good on a new card
    "easy_days": 4.0,            # Easy on a new card
    "start_ease": 2.5,
    "min_ease": 1.3,
    "hard_factor": 1.2,          # Hard on a review card: grow a little
    "easy_bonus": 1.3,           # Easy on a review card: grow a lot
    "ease_delta": {1: -0.20, 2: -0.15, 3: 0.0, 4: 0.15},
    "max_days": 365.0,
}

_STATE_ORDER = {"learning": 0, "review": 1, "new": 2}


def _iso(t: datetime) -> str:
    return t.isoformat(timespec="seconds")


def card_id(theme: str, key: str) -> str:
    return hashlib.sha1(f"{theme}\x00{key}".encode()).hexdigest()[:12]


class LocalScheduler:
    id = "local"
    label = "Built-in"
    note = "spaced repetition inside the cockpit — no Anki needed"

    def __init__(self, path: Path | str, clock: Callable[[], datetime] | None = None) -> None:
        self.path = Path(path)
        self.clock = clock or datetime.now
        self._lock = threading.Lock()
        self._cards: list[dict] | None = None
        self._stamp: tuple[int, int] | None = None     # (mtime_ns, size) of what we hold

    # ── storage ───────────────────────────────────────────────────────────
    def _disk_stamp(self) -> tuple[int, int] | None:
        try:
            st = self.path.stat()
        except OSError:
            return None
        return st.st_mtime_ns, st.st_size

    def _load(self) -> list[dict]:
        stamp = self._disk_stamp()
        if self._cards is None or stamp != self._stamp:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                self._cards = list(data.get("cards") or [])
            except (OSError, ValueError):
                self._cards = []
            self._stamp = stamp
        return self._cards

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.tmp")
        tmp.write_text(json.dumps({"v": 1, "cards": self._cards}, ensure_ascii=False, indent=0),
                       encoding="utf-8")
        os.replace(tmp, self.path)
        self._stamp = self._disk_stamp()

    # ── the interface ─────────────────────────────────────────────────────
    def available(self) -> bool:
        return True

    def due(self, theme: str | None = None) -> list[DueCard]:
        now = _iso(self.clock())
        with self._lock:
            cards = [c for c in self._load()
                     if c["due"] <= now and (theme is None or c["theme"] == theme)]
        order = {c["id"]: i for i, c in enumerate(cards)}
        cards.sort(key=lambda c: (_STATE_ORDER.get(c["state"], 3),
                                  c["due"] if c["state"] != "new" else "", order[c["id"]]))
        return [DueCard(c["id"], c["front"], c["theme"]) for c in cards]

    def add(self, theme: str, specs: list[CardSpec],
            key_of: Callable[[str], str] | None = None) -> dict:
        added = updated = unchanged = 0
        now = _iso(self.clock())
        with self._lock:
            cards = self._load()
            by_id = {c["id"]: c for c in cards}
            for spec in specs:
                cid = card_id(theme, spec.key)
                card = by_id.get(cid)
                if card is None:
                    card = {"id": cid, "theme": theme, "key": spec.key, "front": spec.front,
                            "back": spec.back, "state": "new", "due": now, "interval": 0.0,
                            "ease": SRS_POLICY["start_ease"], "reps": 0, "lapses": 0,
                            "added": now, "last": None}
                    cards.append(card)
                    by_id[cid] = card
                    added += 1
                elif card["front"] != spec.front or card["back"] != spec.back:
                    card["front"], card["back"] = spec.front, spec.back
                    updated += 1
                else:
                    unchanged += 1
            if added or updated:
                self._save()
        return {"added": added, "updated": updated, "unchanged": unchanged, "total": len(specs)}

    def answer(self, card_id_: str, ease: int) -> bool:
        p = SRS_POLICY
        now = self.clock()
        with self._lock:
            card = next((c for c in self._load() if c["id"] == card_id_), None)
            if card is None or ease not in (1, 2, 3, 4):
                return False
            card["ease"] = max(p["min_ease"], card["ease"] + p["ease_delta"][ease])
            if card["state"] in ("new", "learning"):
                if ease == 1:
                    card["state"], wait = "learning", timedelta(minutes=p["again_minutes"])
                elif ease == 2:
                    card["state"], wait = "learning", timedelta(minutes=p["hard_new_minutes"])
                else:
                    days = p["graduate_days"] if ease == 3 else p["easy_days"]
                    card["state"], card["interval"] = "review", days
                    wait = timedelta(days=days)
            else:
                if ease == 1:
                    card["lapses"] += 1
                    card["state"], card["interval"] = "learning", 0.0
                    wait = timedelta(minutes=p["relearn_minutes"])
                else:
                    interval = max(card["interval"], 1.0)
                    if ease == 2:
                        interval *= p["hard_factor"]
                    elif ease == 3:
                        interval = max(interval + 1, interval * card["ease"])
                    else:
                        interval = interval * card["ease"] * p["easy_bonus"]
                    card["interval"] = min(p["max_days"], round(interval, 2))
                    wait = timedelta(days=card["interval"])
            card["reps"] += 1
            card["due"] = _iso(now + wait)
            card["last"] = _iso(now)
            self._save()
        return True

    def counts(self) -> dict[str, dict]:
        now = _iso(self.clock())
        out: dict[str, dict] = {}
        with self._lock:
            for c in self._load():
                row = out.setdefault(c["theme"], {"cards": 0, "due": 0})
                row["cards"] += 1
                if c["due"] <= now:
                    row["due"] += 1
        return out

    def card(self, card_id_: str) -> dict | None:
        """One card's record (tests and the API's curiosity)."""
        with self._lock:
            return next((dict(c) for c in self._load() if c["id"] == card_id_), None)
