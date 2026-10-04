"""The review seam's HTTP slice — mounted at /api/srs (CONTRACTS.md §10)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/srs", tags=["review"])


class BackendBody(BaseModel):
    backend: str


@router.get("", summary="The active review backend and the choices")
def status(request: Request) -> dict:
    return request.app.state.review.status()


@router.post("/backend", summary="Switch the review backend (built-in or Anki)")
def set_backend(body: BackendBody, request: Request) -> dict:
    review = request.app.state.review
    try:
        review.set_backend(body.backend)
    except KeyError:
        raise HTTPException(status_code=400, detail=f"unknown backend {body.backend!r}") from None
    request.app.state.hub.publish({"type": "srs", "backend": body.backend})
    return review.status()
