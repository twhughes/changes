#!/usr/bin/env python3
"""A throwaway cockpit for the Songs demo capture (tools/capture_songs_demo.mjs).

Never Tyler's real cockpit and never his real data:

* port 8996, 127.0.0.1 only (8768 is his cockpit, 8999 the lead's smoke server);
* ``FakeMidiWorld`` — no MIDI hardware is opened; the capture plays through the
  cockpit's virtual keys (``note_in`` on /ws/state);
* every place the cockpit writes goes to one temp dir: ``MUSIC_SONGS_DIR`` = a COPY
  of ``songs/`` (``--empty``: an empty library, for a live import),
  ``MUSIC_SONGS_RUNS``, ``MUSIC_SRS_DIR`` (the built-in review scheduler) and
  ``MUSIC_SOUND_DIR`` (the remembered 🔈 choice — a switch here never reaches Tyler's own);
* Anki offline: ``learn/anki.py``'s one network seam (the default AnkiClient
  transport) is swapped for one that refuses every call, before any client exists —
  so nothing reaches AnkiConnect, and the Anki backend reads as "Anki closed";
* no browser is opened. The temp dir is removed on exit (``--keep`` keeps it).

usage: .venv/bin/python tools/songs_demo_server.py [--port 8996] [--empty] [--keep]
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


def _anki_offline(payload: dict) -> dict:
    """AnkiClient transport that never connects: every call reads as 'Anki closed'."""
    raise ConnectionRefusedError("demo cockpit: Anki is kept offline on purpose")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="songs-demo-server", description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=8996)
    parser.add_argument("--songs", default=str(REPO / "songs"),
                        help="library to copy (default: the repo's songs/)")
    parser.add_argument("--empty", action="store_true",
                        help="start with an empty library (the demo imports the page live)")
    parser.add_argument("--keep", action="store_true", help="keep the temp dir on exit")
    args = parser.parse_args(argv)
    if args.port in (8768, 8999):
        parser.error(f"port {args.port} belongs to a real cockpit — use a scratch port")

    work = Path(tempfile.mkdtemp(prefix="songs-demo-"))
    library = work / "songs"
    if args.empty:
        library.mkdir()
    else:
        shutil.copytree(args.songs, library, ignore=shutil.ignore_patterns(".trash"))
    # Env first: the services read these when create_app() builds them.
    os.environ["MUSIC_SONGS_DIR"] = str(library)
    os.environ["MUSIC_SONGS_RUNS"] = str(work / "runs.jsonl")
    os.environ["MUSIC_SRS_DIR"] = str(work / "srs")
    os.environ["MUSIC_SOUND_DIR"] = str(work / "sound")

    import uvicorn

    import music.learn.anki as anki
    anki._urllib_transport = _anki_offline        # every default-built client is offline
    from music.web.server import create_app
    from tests.fakes import FakeMidiWorld

    app = create_app(midi_module=FakeMidiWorld())
    if anki.AnkiClient().available():
        raise SystemExit("demo cockpit: Anki is reachable — refusing to run")
    from music.sound.service import config_path
    if not config_path().resolve().is_relative_to(work.resolve()):
        raise SystemExit(f"demo cockpit: sound choice at {config_path()}, not the temp dir — refusing to run")
    review = getattr(app.state, "review", None)
    review_dir = getattr(review, "dir", None)
    if review is not None and (review_dir is None or Path(review_dir).resolve() != (work / "srs").resolve()):
        raise SystemExit(f"demo cockpit: review store at {review_dir}, not the temp dir — refusing to run")
    app.state.service.start_thread()
    # uvicorn shuts down gracefully on SIGTERM/SIGINT, then re-raises the signal with
    # the handler that was in place before it ran. Make that handler a SystemExit so
    # the finally below still runs and the temp dir is removed.
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda signum, frame: sys.exit(0))
    print(f"songs demo cockpit -> http://127.0.0.1:{args.port}  data={work}  (Anki offline)", flush=True)
    try:
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    finally:
        app.state.service.stop_thread()
        if args.keep:
            print(f"kept {work}", flush=True)
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
