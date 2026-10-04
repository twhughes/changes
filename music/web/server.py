"""The cockpit shell — one FastAPI app, the WS hub, the view registry.

CONTRACTS.md §5: 127.0.0.1:8768, origin-guarded (this server touches MIDI
hardware), ``/ws/state`` sends a hello then deltas. The service runs on a plain
thread and hands events to the loop via ``call_soon_threadsafe``, one bounded
queue per client — a slow socket drops events, it never stalls the drill.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import threading
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from music.learn.anki import SUBDECKS
from music.learn.decks import DECK_GROUPS, DECK_INFO, MENU, builtin_decks
from music.songs.router import router as songs_router
from music.songs.service import SongsService
from music.sound.router import router as sound_router
from music.sound.samples_api import router as samples_router
from music.sound.service import SoundService
from music.srs import Review
from music.srs.router import router as srs_router
from music.trainer.router import router as trainer_router
from music.trainer.service import TrainerService

#: PORTS.md. MUSIC_PORT overrides it; an explicit --port still beats both.
DEFAULT_PORT = int(os.environ.get("MUSIC_PORT", "8768"))
DEFAULT_HOST = "127.0.0.1"
QUEUE_MAX = 512
STATIC_DIR = Path(__file__).parent / "static"


# Practice = chords + songs in one tree (CONTRACTS.md §11); it mounts the trainer and
# songs modules in its right pane, so those two are no longer tabs of their own.
PRACTICE_VIEW = {"id": "practice", "title": "Practice"}

# 2026-10-04 (Tyler: "just midi hub + flashcards + sound engine"): Practice is the app.
# Player, S-1, Lessons, Viz and 6-6 are retired — RETIRED.md says how to bring one back.
VIEWS: list[dict] = [PRACTICE_VIEW]

_LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}


def _is_local(value: str) -> bool:
    """True for 'localhost:8768', 'http://127.0.0.1:8768', '[::1]:8768'."""
    host = value.strip()
    if "//" in host:
        host = host.split("//", 1)[1]
    host = host.split("/", 1)[0]
    if host.startswith("["):
        host = host[1:].split("]", 1)[0]
    elif ":" in host:
        host = host.rsplit(":", 1)[0]
    return host.lower() in _LOCAL_HOSTNAMES


def _guard_headers(headers) -> str | None:
    """The reason to reject, or None. Absent headers are fine (curl, tests)."""
    host = headers.get("host")
    if host is not None and not _is_local(host):
        return "forbidden host"
    origin = headers.get("origin")
    if origin is not None and not _is_local(origin):
        return "forbidden origin"
    return None


class Hub:
    """Fan-out from the service thread to every connected client."""

    def __init__(self) -> None:
        self._subs: list[Callable[[dict], None]] = []
        self._lock = threading.Lock()

    def subscribe(self, cb: Callable[[dict], None]) -> None:
        with self._lock:
            self._subs.append(cb)

    def unsubscribe(self, cb: Callable[[dict], None]) -> None:
        with self._lock:
            if cb in self._subs:
                self._subs.remove(cb)

    def publish(self, event: dict) -> None:
        with self._lock:
            subs = list(self._subs)
        for cb in subs:
            try:
                cb(event)
            except Exception:  # one dead client never breaks the firehose
                pass


def create_app(midi_module=None) -> FastAPI:
    """The whole cockpit. ``midi_module`` injects a mido-shaped fake in tests."""
    app = FastAPI(title="music cockpit", version="0.1.0",
                  description="Chord trainer and MIDI cockpit. Live state on /ws/state.")
    hub = Hub()
    app.state.hub = hub
    # The trainer owns the keyboard (MIDI in) and the drill; one review scheduler
    # (built-in or Anki, CONTRACTS.md §10) serves it and the songs library.
    app.state.review = Review()
    app.state.service = TrainerService(midi_module=midi_module, publish=hub.publish,
                                       review=app.state.review)
    # Songs: the trainer drills them through the deck-source seam (it never
    # imports songs/), and a finished song drill becomes a receipt via the hub.
    app.state.songs = SongsService(publish=hub.publish, review=app.state.review)
    app.state.service.add_deck_source(app.state.songs.decks)
    app.state.songs.on_review_changed = app.state.service.refresh_due
    hub.subscribe(app.state.songs.on_event)
    # Sound: one active driver. Browser drivers just need the `note` firehose;
    # server drivers hang off the raw note listener (unthrottled).
    app.state.sound = SoundService(publish=hub.publish)
    app.state.service.add_note_listener(app.state.sound.on_note)

    @app.middleware("http")
    async def origin_guard(request: Request, call_next):
        reason = _guard_headers(request.headers)
        if reason:
            return JSONResponse({"detail": reason}, status_code=403)
        response = await call_next(request)
        # Safari keeps ES modules/HTML across restarts and then runs stale JS
        # against a newer API (the 🔈 driver list showed up empty that way).
        # Localhost dev server: never let the browser cache the shell.
        if not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health", tags=["shell"], summary="Liveness")
    def health() -> dict:
        return {"ok": True}

    @app.get("/api/views", tags=["shell"], summary="Registered views")
    def views() -> list[dict]:
        return VIEWS

    @app.get("/api/practice", tags=["shell"],
             summary="The Practice menu: review, chord decks by group, songs (§11)")
    def practice() -> dict:
        backend = app.state.review.active()
        available = backend.available()
        counts = backend.counts() if available else {}
        groups = [{"id": gid, "title": title, "decks": []} for gid, title in DECK_GROUPS]
        by_group = {g["id"]: g for g in groups}
        decks = builtin_decks()
        for name in MENU:                     # only what the menu offers (§11 v2)
            group, title, blurb = DECK_INFO[name]
            seen = counts.get(name, {})
            by_group[group]["decks"].append({
                "id": name, "title": title, "blurb": blurb, "cards": len(decks[name]),
                "in_review": seen.get("cards", 0) > 0, "due": seen.get("due", 0),
                "seedable": name in SUBDECKS})
        songs = []
        for summary in app.state.songs.summaries():
            seen = counts.get("song:" + summary["id"], {})
            songs.append({key: summary.get(key) for key in
                          ("id", "title", "composer", "key", "checked")}
                         | {"in_review": seen.get("cards", 0) > 0, "due": seen.get("due", 0),
                            "broken": bool(summary.get("broken"))})
        due = len(app.state.service.due_now()) if available else 0
        return {"review": {"backend": backend.id, "label": backend.label,
                           "available": available, "due": due},
                "groups": groups, "songs": songs}

    app.include_router(trainer_router)
    app.include_router(songs_router)
    app.include_router(srs_router)
    app.include_router(sound_router)
    app.include_router(samples_router)

    @app.websocket("/ws/state")
    async def ws_state(websocket: WebSocket) -> None:
        """hello, then the service firehose. In: start/skip/stop."""
        if _guard_headers(websocket.headers):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        service: TrainerService = app.state.service
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)

        def put(event: dict) -> None:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:  # slow socket: drop, never block the drill
                pass

        def push(event: dict) -> None:
            try:
                loop.call_soon_threadsafe(put, event)
            except RuntimeError:       # loop already closed
                pass

        hub.subscribe(push)
        try:
            await websocket.send_json({"type": "hello", "status": service.status(),
                                       "sound": {"driver": app.state.sound.driver_id},
                                       "views": VIEWS})

            async def sender() -> None:
                while True:
                    await websocket.send_json(await queue.get())

            async def receiver() -> None:
                while True:
                    msg = await websocket.receive_json()
                    kind = msg.get("type")
                    # Commands run inline (no hop off the loop) so a client that
                    # sends start→skip sees them applied in that order.
                    if kind == "start":
                        service.start_drill(str(msg.get("deck", "")))
                    elif kind == "skip":
                        service.skip()
                    elif kind == "stop":
                        service.stop_drill()
                    elif kind == "note_in":      # on-screen piano / musical typing
                        service.inject(bool(msg.get("on")), int(msg.get("note", 0)),
                                       int(msg.get("vel", 100)))

            tasks = {asyncio.create_task(sender()), asyncio.create_task(receiver())}
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
        except WebSocketDisconnect:
            pass
        finally:
            hub.unsubscribe(push)

    if STATIC_DIR.exists():  # mounted last so /api and /ws win
        app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
    return app


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    parser = argparse.ArgumentParser(prog="music-cockpit", description="the music cockpit")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)

    app = create_app()
    app.state.service.start_thread()
    url = f"http://{args.host}:{args.port}"
    if not args.no_browser:
        def open_browser() -> None:
            import webbrowser

            webbrowser.open(url)

        threading.Timer(1.2, open_browser).start()
    print(f"music cockpit -> {url}")
    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    finally:
        app.state.service.stop_thread()


if __name__ == "__main__":
    main()
