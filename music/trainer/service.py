"""TrainerService — the drill loop as a plain threaded service (no asyncio).

Owns the MIDI port, the NoteTracker and the running DrillEngine, and pushes
every state change out of one ``publish(event: dict)`` firehose. The web layer
adapts that firehose onto WebSockets (CONTRACTS.md §5); tests drive ``tick()``
directly, so nothing here may ever touch an event loop.
"""

from __future__ import annotations

import threading
import time
from typing import Callable

from music.learn.anki import SUBDECKS
from music.learn.decks import (
    MENU,
    REQUEUE_OFFSET,
    DeckRun,
    builtin_decks,
    item_for_front,
    seed_fronts,
)
from music.learn.drill import DrillEngine, DrillItem
from music.learn.grading import grade
from music.midio.backend import MidiIO
from music.midio.events import MidiEvent
from music.midio.notes import NoteTracker
from music.srs import CardSpec, DueCard, Review, ReviewUnavailable
from music.theory.chords import hint_voicing
from music.theory.match import Level
from music.theory.naming import name_notes

TICK_S = 0.005            # poll cadence of the service thread
HELD_MIN_INTERVAL_S = 0.033   # ~30 Hz held-note deltas (CONTRACTS.md §5)
RESCAN_S = 1.0            # how often to look for a keyboard while disconnected
SESSION_CARDS = 30        # a drill session is at most this many prompts...
MAX_CARDS = 60            # ...plus requeued misses, hard-capped here
REVIEW_DECK = "review"           # every due card, all themes mixed (CONTRACTS.md §10)
REVIEW_PREFIX = "review:"        # "review:two-five-one" = that theme's due cards only
ANKI_VIRTUAL_DECK = "anki-due"   # legacy names for the same two sessions
ANKI_THEME_PREFIX = "anki:"
PROBE_S = 5.0             # status polls must not hammer the backend (Anki is a network hop)


def session_summary(results: list[dict]) -> dict:
    """{passed, total, mean_latency_s} over ItemResult dicts.

    The mean sums whole milliseconds (every latency is already rounded to 3 places): an
    exact integer sum and one division, so the static page's twin gets the same digits on
    any Python (3.12's float sum() is compensated, a plain JS sum is not).
    """
    ms = [round(r["latency_s"] * 1000) for r in results
          if r["passed"] and r["latency_s"] is not None]
    return {
        "passed": sum(1 for r in results if r["passed"]),
        "total": len(results),
        "mean_latency_s": round(sum(ms) / (1000 * len(ms)), 3) if ms else None,
    }


class TrainerService:
    """MIDI in → tracker → drill engine → publish(event). Thread-safe."""

    def __init__(self, midi_module=None, publish: Callable[[dict], None] | None = None,
                 anki_client=None, review: Review | None = None,
                 review_backend: str | None = None) -> None:
        self.io = MidiIO(midi_module=midi_module)
        self.tracker = NoteTracker()
        self.publish: Callable[[dict], None] = publish or (lambda event: None)
        self.t0 = time.monotonic()
        self.deck_name: str | None = None
        self.run: DeckRun | None = None
        self.engine: DrillEngine | None = None
        self.streak = 0
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._last_scan = -RESCAN_S
        self._held_sent: list[int] = []
        self._held_at = -HELD_MIN_INTERVAL_S
        self._held_dirty = False
        self._held_names: list[dict] = []   # derived once per *change*, not per publish
        self._held_pcs: list[int] = []
        # Review (spaced repetition) lives behind its own lock: an Anki probe can
        # block for its timeout and must never hold up the tick loop.
        self.review = review or Review(anki_client=anki_client, backend=review_backend)
        self._review_lock = threading.Lock()
        self._review_up = False
        self._due: list[DueCard] = []
        self._due_at: float | None = None
        self._due_backend: str | None = None
        self._review_cards: dict[int, str] = {}   # drill item idx → the backend's card id
        # Same-layer apps (e.g. the player's wait-mode) borrow this one keyboard
        # connection: each feeder is called (now, tracker) at the end of a tick.
        # The composition root (web/server.py) wires them — no app imports another.
        self._feeders: list[Callable[[float, NoteTracker], None]] = []
        # Raw per-note listeners (e.g. a server-side synth): called (type, note, vel)
        # on every note_on/note_off *as it arrives* — never throttled like `held`.
        self._note_listeners: list[Callable[[str, int, int], None]] = []
        # Virtual notes (on-screen piano clicks, musical typing): queued here and
        # drained on the next tick *as if* they came off the wire — one path.
        self._virtual: list[tuple[str, int, int]] = []
        # Deck sources (e.g. the songs library) serve decks the built-ins don't
        # know; the composition root (web/server.py) wires them (CONTRACTS.md §9).
        self._sources: list = []
        self._requeue_on = True            # a run-through never requeues its one card

    def add_deck_source(self, source) -> None:
        """Register a deck source: deck_names/deck/item_for_front/anki_themes/fill."""
        self._sources.append(source)
        self.review.add_source(source)

    def _source_deck(self, name: str):
        """(items, requeue) from the first source that serves ``name``, else None."""
        for source in self._sources:
            try:
                served = source.deck(name)
            except Exception:              # a broken source must not break the trainer
                served = None
            if served is not None:
                return served
        return None

    def _decode(self, text: str) -> DrillItem | None:
        """A card Front → item: the built-in codec first, then each source's."""
        item = item_for_front(text)
        if item is not None:
            return item
        for source in self._sources:
            try:
                item = source.item_for_front(text)
            except Exception:
                item = None
            if item is not None:
                return item
        return None

    def _themes(self) -> dict[str, str]:
        """Every theme → its Anki subdeck: the built-ins, then the sources'."""
        return self.review.theme_decks()

    def _fill(self, theme: str) -> list[DrillItem]:
        if theme in SUBDECKS:
            return DeckRun(builtin_decks()[theme]).queue
        for source in self._sources:
            try:
                items = source.fill(theme)
            except Exception:
                items = []
            if items:
                return DeckRun(items).queue
        return []

    def add_note_listener(self, cb: Callable[[str, int, int], None]) -> None:
        """Register a ``(type, note, vel)`` hook fired per raw note event."""
        self._note_listeners.append(cb)

    def inject(self, on: bool, note: int, vel: int = 100) -> None:
        """Queue a virtual note event; it joins the MIDI stream on the next tick."""
        note = max(0, min(127, int(note)))
        vel = max(0, min(127, int(vel)))
        with self._lock:
            self._virtual.append(("note_on" if on else "note_off", note, vel))

    def add_feeder(self, feeder: Callable[[float, NoteTracker], None]) -> None:
        """Register a ``(now, tracker)`` hook run each tick after the drill feed."""
        self._feeders.append(feeder)

    def now(self) -> float:
        """Seconds since service start, at the event stream's 0.1 ms grain.

        Same rounding as MidiEvent.normalize on purpose: prompt times and note
        times get compared (the engine's arming check), so they must share a grain.
        """
        return round(time.monotonic() - self.t0, 4)

    # ── the poll cycle ─────────────────────────────────────────────────────
    def tick(self) -> None:
        """One cycle: reconnect if needed, drain MIDI, publish, feed the drill."""
        with self._lock:
            now = self.now()
            self._autoconnect(now)
            events = self.io.poll()
            if self._virtual:
                t_now = time.monotonic()
                events += [(ty, n, v, 0, t_now) for ty, n, v in self._virtual]
                self._virtual.clear()
            for type_, note, vel, ch, t in events:
                ev = MidiEvent.normalize(type_, note, vel, ch, t - self.t0)
                self.tracker.feed(ev)
                # Unthrottled per-note firehose: what the sound drivers key off.
                # `held` (below) is the debounced set for chord naming; attacks
                # need the raw edge.
                self.publish({"type": "note", "on": ev.type == "note_on",
                              "note": ev.note, "vel": ev.vel})
                for cb in self._note_listeners:
                    try:
                        cb(ev.type, ev.note, ev.vel)
                    except Exception:   # a synth failure must never stop the trainer
                        pass
            self._pump_held(now)
            if self.engine is not None and not self.engine.done:
                self.engine.feed(now, self.tracker)
            for feeder in self._feeders:   # e.g. the player's wait-mode
                feeder(now, self.tracker)

    def _autoconnect(self, now: float) -> None:
        if self.io.input_connected or (now - self._last_scan) < RESCAN_S:
            return
        self._last_scan = now
        name = self.io.first_keyboard()
        if not name:
            return
        try:
            self.io.open_input(name)
        except Exception:  # a device that vanished between listing and opening
            return
        self.publish({"type": "midi", "port": name, "connected": True})

    def _pump_held(self, now: float) -> None:
        """Publish the held set on change, rate-limited to ~30 Hz (trailing edge kept)."""
        held = sorted(self.tracker.held)
        if held != self._held_sent:
            self._held_sent = held
            self._held_dirty = True
            # Naming rides along with the set, so it is computed on the change and
            # reused by the throttled publish — never recomputed per 33 ms tick.
            self._held_names = [{"name": r.name, "exact": r.exact}
                                for r in name_notes(held, top=2)]
            self._held_pcs = sorted({n % 12 for n in held})
        if self._held_dirty and (now - self._held_at) >= HELD_MIN_INTERVAL_S:
            self._held_dirty = False
            self._held_at = now
            self.publish({"type": "held", "notes": list(self._held_sent),
                          "pcs": list(self._held_pcs), "names": list(self._held_names)})

    # ── review (spaced repetition: built-in or Anki — CONTRACTS.md §10) ────
    def _due_probe(self) -> list[DueCard]:
        """The active backend's due/new cards, refreshed every PROBE_S.

        Call this *outside* ``self._lock`` — the Anki backend does network I/O.
        """
        with self._review_lock:
            now = time.monotonic()
            backend = self.review.active()
            if (self._due_at is not None and (now - self._due_at) < PROBE_S
                    and self._due_backend == backend.id):
                return self._due
            self._due_at, self._due_backend = now, backend.id
            self._review_up = backend.available()
            self._due = backend.due(None) if self._review_up else []
            return self._due

    def due_now(self) -> list[DueCard]:
        """What a ``review`` session would drill right now (cached PROBE_S)."""
        return self._due_probe()

    def refresh_due(self) -> None:
        """Forget the cached due list — cards were just added elsewhere (a song)."""
        self._due_at = None

    def deck_names(self) -> list[str]:
        """Review sessions first (everything due, then per theme), then the built-ins.

        Song decks are not listed: the Practice menu (CONTRACTS.md §11) shows songs as
        songs, and their decks start by name through the deck-source seam.
        """
        due = self._due_probe()
        names = list(MENU)          # the menu's decks; any built-in still starts by name
        if not due:
            return names
        themes = sorted({card.theme for card in due if card.theme})
        return [REVIEW_DECK, *[REVIEW_PREFIX + theme for theme in themes], *names]

    def seed_builtin(self, name: str) -> dict:
        """Add a built-in deck's cards to review — the phase-advance act.

        Returns ``{backend, deck, added, updated, unchanged, total}`` (cards already
        there keep their schedule). Raises KeyError for an unknown deck, ValueError
        for a cram-only deck (no subdeck, e.g. sevenths-strict) and
        ReviewUnavailable when the chosen backend is down (Anki closed).
        """
        if name not in builtin_decks():
            raise KeyError(name)
        if name not in SUBDECKS:
            raise ValueError(f"{name!r} is cram-only — it has no review deck")
        backend = self.review.active()
        if not backend.available():
            raise ReviewUnavailable(f"{backend.label} is not available")
        specs = [CardSpec(front, front, "") for front in seed_fronts(name)]
        with self._review_lock:                # network I/O: never under _lock
            result = backend.add(name, specs)
            self._due_at = None
        return {"backend": backend.id, "deck": name, **result}

    def _start_review(self, theme: str | None = None) -> bool:
        """Drill what the review backend says is due — it keeps its own schedule.

        ``theme`` narrows to one theme's cards and, when those run short, tops the
        session up from that theme's deck (top-up cards grade on screen but never
        answer the scheduler).
        """
        due = self._due_probe()            # network: before the lock
        if theme is not None:
            due = [card for card in due if card.theme == theme]
        items: list[DrillItem] = []
        cards: dict[int, str] = {}
        for card in due[:SESSION_CARDS]:
            item = self._decode(card.front)
            if item is None:
                continue                   # a Front that isn't ours isn't ours to drill
            cards[len(items)] = card.card_id
            items.append(item)
        if theme is not None and items and len(items) < SESSION_CARDS:
            prompts = {item.prompt for item in items}
            fill = [i for i in self._fill(theme) if i.prompt not in prompts]
            items.extend(fill[: SESSION_CARDS - len(items)])
        with self._lock:
            if not items:
                self.publish({"type": "error", "message": "nothing is due for review"})
                return False
            self.deck_name = REVIEW_DECK if theme is None else REVIEW_PREFIX + theme
            self.streak = 0
            self._requeue_on = True
            self.run = None                # no requeue: the scheduler owns the misses
            self._review_cards = cards
            self.engine = DrillEngine(items, on_event=self._on_engine_event)
            self.engine.start(self.now())
            return True

    def _answer_review(self, idx: int, ease: int) -> int | None:
        """Press the ease this pass earned on its review card; the ease, or None."""
        card_id = self._review_cards.get(idx)
        if card_id is None:
            return None
        ok = self.review.active().answer(card_id, ease)
        self._due_at = None                # the due list just changed
        return ease if ok else None

    # ── commands ───────────────────────────────────────────────────────────
    def start_drill(self, deck_name: str) -> bool:
        """Shuffle a built-in deck and arm the engine over the first SESSION_CARDS."""
        if deck_name in (REVIEW_DECK, ANKI_VIRTUAL_DECK):
            return self._start_review()
        for prefix in (REVIEW_PREFIX, ANKI_THEME_PREFIX):
            if deck_name.startswith(prefix):
                return self._start_review(deck_name[len(prefix):])
        requeue = True
        items = builtin_decks().get(deck_name)
        if items is None:
            served = self._source_deck(deck_name)      # file I/O: before the lock
            if served is not None:
                items, requeue = served
        with self._lock:
            if items is None:
                self.publish({"type": "error", "message": f"unknown deck {deck_name!r}"})
                return False
            if not items:
                self.publish({"type": "error", "message": f"deck {deck_name!r} has no cards"})
                return False
            self.deck_name = deck_name
            self.streak = 0
            self._review_cards = {}
            self._requeue_on = requeue
            self.run = DeckRun(items, shuffle=True)
            self.engine = DrillEngine(self.run.queue[:SESSION_CARDS], on_event=self._on_engine_event)
            self.engine.start(self.now())
            return True

    def skip(self) -> None:
        with self._lock:
            if self.engine is not None and not self.engine.done:
                self.streak = 0
                self.engine.skip(self.now())

    def stop_drill(self) -> None:
        with self._lock:
            engine, self.engine = self.engine, None
            if engine is None or engine.done:
                return
            results = [r.to_dict() for r in engine.results]
            self.publish({"type": "done", "results": results, "deck": self.deck_name,
                          "summary": session_summary(results), "stopped": True})

    def status(self) -> dict:
        decks = self.deck_names()          # probes Anki (cached) outside the lock
        with self._lock:
            engine = self.engine
            return {
                "midi_port": self.io.input_name,
                "anki": self._review_up and self.review.backend_id == "anki",
                "review": {"backend": self.review.backend_id, "available": self._review_up},
                "decks": decks,
                "drill": {
                    "active": engine is not None and not engine.done,
                    "deck": self.deck_name,
                    "idx": engine.idx if engine is not None else -1,
                    "total": len(engine.items) if engine is not None else 0,
                    "streak": self.streak,
                    # Current item, so a client connecting mid-drill can render
                    # the prompt it missed (the live event fired before it joined).
                    "prompt": engine.current.prompt if engine is not None and engine.current else None,
                    # A recall card (a song phrase) never leaks its chords to the UI.
                    "chord": (engine.current.chord.text
                              if engine is not None and engine.current and not engine.current.is_pitch
                              and not engine.current.recall
                              else None),
                    "ref": engine.current.ref if engine is not None and engine.current else None,
                    # Which chord of a progression card is live — a reloaded view resumes there.
                    "step": engine._sub if engine is not None and engine.current else 0,
                    "recall": bool(engine is not None and engine.current and engine.current.recall),
                    "level": (Level.PITCH.value if engine is not None and engine.current
                              and engine.current.is_pitch
                              else engine.current.level.value
                              if engine is not None and engine.current else None),
                    "staff": engine.current.staff() if engine is not None and engine.current else None,
                    # "Show keys": the live chord's hint voicing (None for recall and pitch cards).
                    "notes": (hint_voicing(engine.current.seq[engine._sub])
                              if engine is not None and engine.current and not engine.current.is_pitch
                              and not engine.current.recall
                              else None),
                },
            }

    # ── engine → firehose ──────────────────────────────────────────────────
    def _on_engine_event(self, name: str, payload: dict) -> None:
        event = {"type": name, **payload}
        engine = self.engine
        if name == "prompt" and engine is not None:
            item = engine.items[payload["idx"]]
            # Pitch items (sight reading) show a staff, not a chord name; recall
            # items (song phrases) show neither — the chords are the answer.
            event["chord"] = None if item.is_pitch or item.recall else item.chord.text
            event["level"] = Level.PITCH.value if item.is_pitch else item.level.value
            event["staff"] = item.staff()
            event["ref"] = item.ref
            event["recall"] = item.recall
            # "Show keys" (CONTRACTS §5): the chord's hint voicing; a recall card keeps its secret.
            event["notes"] = None if item.is_pitch or item.recall else hint_voicing(item.chord)
        elif name == "step" and engine is not None:
            item = engine.items[payload["idx"]]
            if item.recall:
                event["chord"] = None
            event["notes"] = None if item.recall else hint_voicing(item.seq[payload["step"]])
        elif name == "passed":
            review_session = (self.deck_name or "").startswith(("review", "anki"))
            if payload.get("first_try"):
                self.streak += 1
            else:
                self.streak = 0
                if not review_session and self._requeue_on:
                    self._requeue(payload["idx"])   # the scheduler reschedules its own misses
            event["streak"] = self.streak
            # Grade every pass (built-in decks included — the breakdown is the
            # feedback loop); only Anki-backed cards get the button pressed.
            if engine is not None:
                item = engine.items[payload["idx"]]
                result = engine.results[payload["idx"]]
                card_grade = grade(result.attempts, payload["latency_s"],
                                   steps=len(item.seq))
                event["grade"] = card_grade
                ease = self._answer_review(payload["idx"], card_grade["ease"])
                if ease is not None:
                    event["review_ease"] = ease
                    event["backend"] = self.review.backend_id
                    if self.review.backend_id == "anki":
                        event["anki_ease"] = ease      # legacy name
        elif name == "done":
            event["deck"] = self.deck_name
            event["summary"] = session_summary(payload["results"])
        self.publish(event)

    def _requeue(self, idx: int) -> None:
        """A card missed on the first attempt comes back REQUEUE_OFFSET cards later."""
        engine = self.engine
        if engine is None or len(engine.items) >= MAX_CARDS:
            return
        item = engine.items[idx]
        engine.items.insert(min(idx + REQUEUE_OFFSET, len(engine.items)), item)
        if self.run is not None:
            self.run.requeue(item)  # keep the DeckRun's own queue honest too

    # ── thread (started by the server, never by __init__) ──────────────────
    def start_thread(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="trainer", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:  # one bad tick must never kill the loop
                pass
            time.sleep(TICK_S)

    def stop_thread(self) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=1.0)
        self.io.close()
