"""/api/sound/samples — the multisampled electric-piano set, served to the browser.

The browser ``samples`` sound driver (web/static/sound/samples.js) needs two
things over HTTP: the set's ``manifest.json`` and each WAV it names. This router
serves both from a set directory under ``music/sound/samples/``.

Set selection: the ``MUSIC_SAMPLES`` env var names the set (a subdir name); with
it unset, the single subdir that contains a ``manifest.json`` wins. No set
installed → ``GET /manifest`` returns 404 with a helpful detail (the driver then
runs silent), rather than the server failing to start.

``web/server.py`` mounts this with::

    from music.sound.samples_api import router as samples_router
    app.include_router(samples_router)
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

router = APIRouter(prefix="/api/sound/samples", tags=["sound"])

#: music/sound/samples/ — one subdir per installed set.
SAMPLES_ROOT = Path(__file__).resolve().parent / "samples"


def _set_dir() -> Path | None:
    """The active set's directory, or None if no set is installed.

    ``MUSIC_SAMPLES`` pins the set by name; otherwise the lone subdir holding a
    ``manifest.json`` is used. If several qualify and none is pinned, the first
    by name is picked (deterministic) so the endpoint never guesses at random.
    """
    root = SAMPLES_ROOT
    pinned = os.environ.get("MUSIC_SAMPLES")
    if pinned:
        cand = root / pinned
        return cand if (cand / "manifest.json").is_file() else None
    if not root.is_dir():
        return None
    have = sorted(d for d in root.iterdir()
                  if d.is_dir() and (d / "manifest.json").is_file())
    return have[0] if have else None


@router.get("/manifest", summary="The active sample set's manifest")
def manifest() -> JSONResponse:
    set_dir = _set_dir()
    if set_dir is None:
        raise HTTPException(
            status_code=404,
            detail=("no sample set installed — put one under music/sound/samples/"
                    "<name>/ with a manifest.json (see samples/README.md), or set "
                    "MUSIC_SAMPLES"),
        )
    try:
        data = json.loads((set_dir / "manifest.json").read_text())
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"bad manifest: {e}") from None
    return JSONResponse(data)


@router.get("/file/{name:path}", summary="One sample file from the active set")
def file(name: str) -> FileResponse:
    set_dir = _set_dir()
    if set_dir is None:
        raise HTTPException(status_code=404, detail="no sample set installed")
    base = set_dir.resolve()
    path = (base / name).resolve()
    # Path-traversal guard (mirrors player/router.py's stem endpoint): the
    # resolved path must live inside the set dir and be a real file.
    if base not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail=f"no sample {name!r}")
    media = "audio/wav" if path.suffix.lower() == ".wav" else "application/octet-stream"
    # no-store: the browser must never serve a stale sample from a swapped set.
    return FileResponse(path, media_type=media, headers={"Cache-Control": "no-store"})
