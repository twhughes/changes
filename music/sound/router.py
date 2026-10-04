"""/api/sound — pick the driver, open Logic. Mounted by web/server.py."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/sound", tags=["sound"])


class DriverIn(BaseModel):
    driver: str


@router.get("", summary="Active sound driver + the table of all drivers")
def status(request: Request) -> dict:
    return request.app.state.sound.status()


@router.post("/driver", summary="Switch the active sound driver")
def set_driver(body: DriverIn, request: Request) -> dict:
    try:
        return request.app.state.sound.set_driver(body.driver)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no driver {body.driver!r}") from None
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from None


@router.post("/test", summary="Play a C major chord through the active driver (diagnostic)")
def test_chord(request: Request) -> dict:
    return request.app.state.sound.test_chord()
