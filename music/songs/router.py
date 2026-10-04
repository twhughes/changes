"""The songs slice of the HTTP API — mounted at /api/songs (CONTRACTS.md §9)."""

from __future__ import annotations

import urllib.parse

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from music.songs.chart import ChartError
from music.songs.importer import MAX_BYTES
from music.songs.store import PAGE_MIMES
from music.srs import ReviewUnavailable

router = APIRouter(prefix="/api/songs", tags=["songs"])

VIEW = {"id": "songs", "title": "Songs"}


class TextBody(BaseModel):
    text: str


class PatchBody(BaseModel):
    grade: str | None = None
    checked: bool | None = None
    title: str | None = None
    key: str | None = None
    composer: str | None = None
    style: str | None = None
    form: str | None = None


def _svc(request: Request):
    return request.app.state.songs


def _unprocessable(e: Exception) -> JSONResponse:
    errors = getattr(e, "errors", None) or [str(e)]
    return JSONResponse(status_code=422, content={"detail": "; ".join(errors), "errors": errors})


# Static paths first: "/imports" must not be read as a song id.
@router.get("", summary="Every song, summarized")
def list_songs(request: Request) -> list[dict]:
    return _svc(request).summaries()


@router.post("/import", summary="Import a page: JSON {url}, or the file's raw bytes (X-Filename)",
             response_model=None)
async def import_page(request: Request):
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="the file is over 25 MB")
    if ctype == "application/json":
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(status_code=400, detail="send {\"url\": …} or the file") from None
        url = str((body or {}).get("url") or "").strip()
        if not url:
            raise HTTPException(status_code=400, detail="no url given")
        return _svc(request).import_url(url)
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="the upload is empty")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="the file is over 25 MB")
    name = urllib.parse.unquote(request.headers.get("x-filename", "") or "upload")
    return _svc(request).import_bytes(data, name)


@router.get("/imports", summary="Import jobs, newest first")
def list_jobs(request: Request) -> list[dict]:
    return _svc(request).jobs()


@router.get("/imports/{job_id}", summary="One import job")
def get_job(job_id: str, request: Request) -> dict:
    try:
        return _svc(request).job(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no import job {job_id!r}") from None


@router.get("/{song_id}", summary="Song JSON v1", response_model=None)
def get_song(song_id: str, request: Request):
    try:
        return _svc(request).song(song_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no song {song_id!r}") from None
    except ChartError as e:
        return _unprocessable(e)


@router.get("/{song_id}/text", summary="The chart as song text v1")
def get_text(song_id: str, request: Request) -> dict:
    try:
        return {"text": _svc(request).text(song_id)}
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no song {song_id!r}") from None


@router.put("/{song_id}/text", summary="Replace the whole chart", response_model=None)
def put_text(song_id: str, body: TextBody, request: Request):
    try:
        return _svc(request).save_text(song_id, body.text)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no song {song_id!r}") from None
    except ChartError as e:
        return _unprocessable(e)


@router.put("/{song_id}/bar/{addr}", summary="Replace one written bar", response_model=None)
def put_bar(song_id: str, addr: str, body: TextBody, request: Request):
    try:
        return _svc(request).save_bar(song_id, addr, body.text)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no bar {addr!r} in {song_id!r}") from None
    except (ChartError, ValueError) as e:
        return _unprocessable(e)


@router.patch("/{song_id}", summary="Change the dial, the checked mark, title, key, form",
              response_model=None)
def patch_song(song_id: str, body: PatchBody, request: Request):
    try:
        return _svc(request).patch(song_id, body.model_dump())
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no song {song_id!r}") from None
    except (ChartError, ValueError) as e:
        return _unprocessable(e)


@router.delete("/{song_id}", summary="Move a song to songs/.trash")
def delete_song(song_id: str, request: Request) -> dict:
    try:
        _svc(request).delete(song_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no song {song_id!r}") from None
    return {"deleted": song_id}


@router.get("/{song_id}/page", summary="The original page file")
def get_page(song_id: str, request: Request) -> FileResponse:
    try:
        page = _svc(request).store.page(song_id)
    except KeyError:
        page = None
    if page is None:
        raise HTTPException(status_code=404, detail=f"{song_id!r} has no page")
    return FileResponse(page, media_type=PAGE_MIMES.get(page.suffix.lower()))


@router.get("/{song_id}/read/{n}", summary="The n-th raster Claude read (1-based)")
def get_read(song_id: str, n: int, request: Request) -> FileResponse:
    try:
        reads = _svc(request).store.reads(song_id)
    except KeyError:
        reads = []
    if not 1 <= n <= len(reads):
        raise HTTPException(status_code=404, detail="no such raster")
    return FileResponse(reads[n - 1], media_type="image/png")


@router.post("/{song_id}/reread", summary="Read the stored page again (one level of undo)")
def reread(song_id: str, request: Request) -> dict:
    try:
        return _svc(request).reread(song_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no song {song_id!r}") from None
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


@router.post("/{song_id}/seed", summary="Add the phrase cards to review (built-in or Anki)",
             response_model=None)
def seed(song_id: str, request: Request):
    try:
        return _svc(request).seed(song_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no song {song_id!r}") from None
    except ChartError as e:
        return _unprocessable(e)
    except ReviewUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from None


@router.get("/{song_id}/runs", summary="Practice receipts, newest first")
def runs(song_id: str, request: Request) -> list[dict]:
    return _svc(request).runs(song_id)
