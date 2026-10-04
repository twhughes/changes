"""Every test runs against throwaway data dirs: the review scheduler's cards, the
songs library and the practice receipts never touch Tyler's real files."""

import pytest


@pytest.fixture(autouse=True)
def _isolated_data(tmp_path, monkeypatch):
    monkeypatch.setenv("MUSIC_SRS_DIR", str(tmp_path / "srs"))
    monkeypatch.setenv("MUSIC_SOUND_DIR", str(tmp_path / "sound"))
    monkeypatch.setenv("MUSIC_SONGS_DIR", str(tmp_path / "songs-lib"))
    monkeypatch.setenv("MUSIC_SONGS_RUNS", str(tmp_path / "runs.jsonl"))
