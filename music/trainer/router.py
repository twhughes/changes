"""The trainer's slice of the HTTP API — mounted at /api/trainer (CONTRACTS.md §5)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from music.srs import ReviewUnavailable

router = APIRouter(prefix="/api/trainer", tags=["trainer"])

VIEW = {"id": "trainer", "title": "Trainer"}


class SeedBody(BaseModel):
    builtin: str
    #: Accepted and ignored: the lesson gate retired with the Lessons tab (2026-10-04).
    force: bool = False


@router.post("/seed", summary="Add a built-in deck to review — built-in scheduler or Anki "
             "(phase advance)", response_model=None)
def seed(body: SeedBody, request: Request):
    try:
        result = request.app.state.service.seed_builtin(body.builtin)
    except KeyError:
        raise HTTPException(status_code=404,
                            detail=f"unknown deck {body.builtin!r}") from None
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    except ReviewUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from None
    return {"builtin": body.builtin, **result}


@router.get("/decks", summary="Deck names — built-ins, plus 'review' sessions when cards are due")
def decks(request: Request) -> list[str]:
    return request.app.state.service.deck_names()


@router.get("/status", summary="MIDI port, decks, and the running drill")
def status(request: Request) -> dict:
    return request.app.state.service.status()
