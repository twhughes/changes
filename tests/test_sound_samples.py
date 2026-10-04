"""The /api/sound/samples router: manifest, file serving, set selection, guards.

These tests never touch the real Wurlitzer pack — they build a throwaway set
(a fake manifest + a tiny real WAV) in a tmp dir and point the router at it.
"""

from __future__ import annotations

import json
import wave

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from music.sound import samples_api


def _tiny_wav(path) -> None:
    """Write a valid ~10 ms mono 16-bit WAV so decodeAudioData-shaped code is happy."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(b"\x00\x00" * 441)


def _make_set(root, name="fakeset"):
    """Create a minimal sample set under root/name; return its dir."""
    set_dir = root / name
    _tiny_wav(set_dir / "wav" / "note60.wav")
    manifest = {
        "name": "Fake EP",
        "license": "CC0",
        "source": "test",
        "release_s": 0.4,
        "samples": [
            {"file": "wav/note60.wav", "note": 60, "vel_lo": 1, "vel_hi": 127,
             "tune_cents": 0, "gain_db": 0.0, "loop": None},
        ],
    }
    (set_dir / "manifest.json").write_text(json.dumps(manifest))
    return set_dir


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A client over an app that mounts only the samples router, rooted at tmp."""
    monkeypatch.setattr(samples_api, "SAMPLES_ROOT", tmp_path)
    monkeypatch.delenv("MUSIC_SAMPLES", raising=False)
    app = FastAPI()
    app.include_router(samples_api.router)
    return TestClient(app, base_url="http://localhost:8768")


def test_manifest_and_file(client, tmp_path):
    _make_set(tmp_path)
    r = client.get("/api/sound/samples/manifest")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Fake EP"
    assert body["samples"][0]["note"] == 60
    # the file it names is served as audio/wav
    f = client.get("/api/sound/samples/file/wav/note60.wav")
    assert f.status_code == 200
    assert f.headers["content-type"] == "audio/wav"
    assert f.content[:4] == b"RIFF"
    assert f.headers.get("cache-control") == "no-store"


def test_manifest_404_when_no_set(client):
    r = client.get("/api/sound/samples/manifest")
    assert r.status_code == 404
    assert "sample set" in r.json()["detail"]


def test_env_var_pins_the_set(client, tmp_path, monkeypatch):
    _make_set(tmp_path, "alpha")
    _make_set(tmp_path, "beta")
    # unpinned: deterministic first-by-name = alpha
    assert client.get("/api/sound/samples/manifest").status_code == 200
    monkeypatch.setenv("MUSIC_SAMPLES", "beta")
    assert client.get("/api/sound/samples/manifest").status_code == 200
    monkeypatch.setenv("MUSIC_SAMPLES", "ghost")
    assert client.get("/api/sound/samples/manifest").status_code == 404


def test_missing_file_404(client, tmp_path):
    _make_set(tmp_path)
    assert client.get("/api/sound/samples/file/wav/nope.wav").status_code == 404


def test_path_traversal_blocked(client, tmp_path):
    _make_set(tmp_path)
    # a secret sibling of the set dir must not be reachable via ../
    (tmp_path / "secret.txt").write_text("nope")
    r = client.get("/api/sound/samples/file/../secret.txt")
    assert r.status_code == 404
    # encoded traversal too
    r2 = client.get("/api/sound/samples/file/%2e%2e/secret.txt")
    assert r2.status_code == 404
