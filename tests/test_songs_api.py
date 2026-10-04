"""Songs as an app: /api/songs, the trainer's song decks, Anki seeding, receipts.

Everything runs on fakes — a scripted Claude (no network), a scripted
AnkiConnect, and the FakeMidiWorld keyboard — inside a tmp songs library.
"""

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from music.learn.anki import AnkiClient
from music.songs.decks import SongDecks, anki_subdeck
from music.songs.store import SongStore
from music.web.server import create_app
from tests.fakes import FakeMidiWorld
from tests.test_songs_import import READ, FakeLLM, make_png
from tests.test_web import PORT_NAME, chord_notes, press, settle

FIXTURE = Path(__file__).parent / "fixtures" / "songs" / "very-early.txt"


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setenv("MUSIC_SONGS_DIR", str(tmp_path / "songs"))
    monkeypatch.setenv("MUSIC_SONGS_RUNS", str(tmp_path / "runs.jsonl"))
    store = SongStore(tmp_path / "songs")
    store.write_text("very-early", FIXTURE.read_text())
    return store


@pytest.fixture
def app_parts(library):
    world = FakeMidiWorld()
    world.add_device(in_name=PORT_NAME)
    events: list[dict] = []
    app = create_app(midi_module=world)
    app.state.hub.subscribe(events.append)
    client = TestClient(app, base_url="http://localhost:8768")
    return client, app, world, events


def release(world, notes):
    for note in notes:
        world.key(PORT_NAME, "note_off", note, 0)


def play(world, service, text):
    notes = chord_notes(text)
    press(world, notes)
    settle(service)
    release(world, notes)
    settle(service, 0.05)


def wait_job(client, job_id, limit=5.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < limit:
        job = client.get(f"/api/songs/imports/{job_id}").json()
        if job["done"]:
            return job
        time.sleep(0.02)
    raise AssertionError("import never finished")


class FakeAnki:
    """A stateful AnkiConnect: decks, notes with fields, the actions seeding uses."""

    def __init__(self):
        self.notes: dict[int, dict] = {}
        self.decks: set[str] = set()
        self.next_id = 1000

    def __call__(self, payload):
        action, params = payload["action"], payload["params"]
        if action == "version":
            return {"result": 6, "error": None}
        if action == "createDeck":
            self.decks.add(params["deck"])
            return {"result": 1, "error": None}
        if action == "findNotes":
            deck = params["query"].split('"')[1]
            return {"result": [i for i, n in self.notes.items() if n["deck"] == deck], "error": None}
        if action == "notesInfo":
            return {"result": [{"noteId": i, "fields": {
                "Front": {"value": self.notes[i]["Front"]}, "Back": {"value": self.notes[i]["Back"]}}}
                for i in params["notes"]], "error": None}
        if action == "addNotes":
            ids = []
            for note in params["notes"]:
                self.next_id += 1
                self.notes[self.next_id] = {"deck": note["deckName"], **note["fields"],
                                            "tags": note["tags"]}
                ids.append(self.next_id)
            return {"result": ids, "error": None}
        if action == "updateNoteFields":
            self.notes[params["note"]["id"]].update(params["note"]["fields"])
            return {"result": None, "error": None}
        if action == "findCards":                 # one card per note; the query spans subdecks
            deck = params["query"].split('"')[1]
            return {"result": [i for i, n in self.notes.items()
                               if n["deck"] == deck or n["deck"].startswith(deck + "::")], "error": None}
        if action == "cardsInfo":
            return {"result": [{"cardId": i, "deckName": self.notes[i]["deck"],
                                "fields": {"Front": {"value": self.notes[i]["Front"]}}}
                               for i in params["cards"]], "error": None}
        return {"result": None, "error": f"unsupported {action}"}


# ── reading and editing ──────────────────────────────────────────────────────
def test_list_and_get(app_parts):
    client, *_ = app_parts
    [summary] = client.get("/api/songs").json()
    assert summary["id"] == "very-early" and summary["phrases"] == 9 and summary["chords"] == 18
    assert summary["checked"] == "" and summary["flags"] == 0
    song = client.get("/api/songs/very-early").json()
    assert song["decks"]["phrases"] == "song:very-early:phrases"
    assert song["anki"] == {"subdeck": "Music::PianoChords::Songs::Very Early",
                            "theme": "anki:song:very-early"}
    assert song["page"] is None and song["flags"] == []
    assert client.get("/api/songs/nope").status_code == 404


def test_edit_a_bar_the_dial_and_the_checked_mark(app_parts):
    client, _app, _world, events = app_parts
    song = client.put("/api/songs/very-early/bar/A.4.5", json={"text": "2. G7b9"}).json()
    assert song["sections"][0]["lines"][3]["bars"][4]["text"] == "2. G7b9"
    assert {"type": "songs", "event": "changed", "song": "very-early"} in events
    bad = client.put("/api/songs/very-early/bar/A.1.1", json={"text": "C | D"})
    assert bad.status_code == 422
    assert client.put("/api/songs/very-early/bar/Z.1.1", json={"text": "C"}).status_code == 404

    written = client.patch("/api/songs/very-early", json={"grade": "written"}).json()
    assert "A4.1" in [p["id"] for p in written["phrases"]]
    assert client.patch("/api/songs/very-early", json={"grade": "loose"}).status_code == 422
    checked = client.patch("/api/songs/very-early", json={"checked": True}).json()
    assert len(checked["checked"]) == 10
    assert client.patch("/api/songs/very-early", json={"form": "A B Q"}).status_code == 422


def test_the_text_editor_round_trip(app_parts):
    client, *_ = app_parts
    text = client.get("/api/songs/very-early/text").json()["text"]
    bad = client.put("/api/songs/very-early/text", json={"text": "[A]\n| C |\n"})
    assert bad.status_code == 422 and any("title" in e for e in bad.json()["errors"])
    assert client.get("/api/songs/very-early/text").json()["text"] == text      # untouched
    ok = client.put("/api/songs/very-early/text",
                    json={"text": text.replace("title: Very Early", "title: Very Early (RB)")})
    assert ok.json()["title"] == "Very Early (RB)"


def test_delete_moves_to_trash(app_parts, library):
    client, *_ = app_parts
    assert client.delete("/api/songs/very-early").json() == {"deleted": "very-early"}
    assert client.get("/api/songs/very-early").status_code == 404
    assert any((library.root / ".trash").iterdir())


# ── importing over HTTP ──────────────────────────────────────────────────────
def test_upload_import_runs_as_a_job(app_parts):
    client, app, _world, events = app_parts
    app.state.songs._llm = FakeLLM(READ)
    started = client.post("/api/songs/import", content=make_png(),
                          headers={"content-type": "image/png", "x-filename": "test%20tune.png"}).json()
    job = wait_job(client, started["job"])
    assert job["stage"] == "saved" and job["song"] == "test-tune" and job["error"] is None
    stages = [e["stage"] for e in events if e.get("event") == "import"]
    assert stages[0] == "queued" and stages[-1] == "saved"
    saved = [e for e in events if e.get("event") == "import" and e["stage"] == "saved"]
    assert len(saved) == 1 and saved[0]["song"] == "test-tune"
    song = client.get("/api/songs/test-tune").json()
    assert song["page"]["mime"] == "image/png" and song["page"]["name"] == "test tune.png"
    page = client.get("/api/songs/test-tune/page")
    assert page.status_code == 200 and page.headers["content-type"] == "image/png"
    assert client.get("/api/songs/test-tune/read/1").status_code == 200
    assert client.get("/api/songs/imports").json()[0]["job"] == started["job"]


def test_a_bad_upload_fails_visibly(app_parts):
    client, app, *_ = app_parts
    app.state.songs._llm = FakeLLM(READ)
    started = client.post("/api/songs/import", content=b"not an image",
                          headers={"content-type": "application/octet-stream"}).json()
    job = wait_job(client, started["job"])
    assert job["stage"] == "error" and "not a PDF" in job["error"]
    assert client.post("/api/songs/import", json={}).status_code == 400
    assert client.post("/api/songs/import", content=b"",
                       headers={"content-type": "image/png"}).status_code == 400


def test_url_import_uses_the_fetcher(app_parts):
    client, app, *_ = app_parts
    from music.songs.importer import Upload
    app.state.songs._llm = FakeLLM(READ)
    app.state.songs._fetch = lambda url: Upload(make_png(), "scan.png", url)
    job = wait_job(client, client.post("/api/songs/import",
                                       json={"url": "https://x.org/scan.png"}).json()["job"])
    assert job["song"] == "test-tune"
    assert client.get("/api/songs/test-tune").json()["source"] == "https://x.org/scan.png"


# ── the trainer drills songs ─────────────────────────────────────────────────
def test_song_decks_are_offered_and_phrases_hide_their_chords(app_parts):
    client, app, world, events = app_parts
    service = app.state.service
    # Songs are not deck-list clutter (§11): they start by name through the seam.
    assert not any(d.startswith("song:") for d in client.get("/api/trainer/decks").json())
    service.tick()
    assert service.start_drill("song:very-early:phrases")
    prompt = [e for e in events if e["type"] == "prompt"][-1]
    assert prompt["chord"] is None and prompt["recall"] is True
    assert prompt["ref"].startswith("song:very-early:phrase:")
    assert service.status()["drill"]["chord"] is None

    phrase_id = prompt["ref"].rsplit(":", 1)[1]
    song = client.get("/api/songs/very-early").json()
    phrase = next(p for p in song["phrases"] if p["id"] == phrase_id)
    for step in phrase["steps"]:
        play(world, service, step["play"])
    steps = [e for e in events if e["type"] == "step"]
    assert steps and all(e["chord"] is None for e in steps)
    assert [e for e in events if e["type"] == "passed"][-1]["first_try"] is True


def test_the_chords_deck_shows_the_chord(app_parts):
    _client, app, *_ = app_parts
    service = app.state.service
    events = []
    service.publish = events.append
    service.start_drill("song:very-early:chords")
    prompt = [e for e in events if e["type"] == "prompt"][0]
    assert prompt["chord"] and prompt["recall"] is False and len(service.engine.items) == 18


def test_a_run_through_never_requeues(app_parts):
    _client, app, world, events = app_parts
    service = app.state.service
    service.tick()
    service.start_drill("song:very-early:run:Ending")
    assert len(service.engine.items) == 1
    play(world, service, "C7")                       # wrong: the ending starts on D-7
    for chord in ["D-7", "C#-7", "Bbmaj7", "Gmaj7", "Bmaj7"]:
        play(world, service, chord)
    assert [e for e in events if e["type"] == "passed"][-1]["first_try"] is False
    assert [e for e in events if e["type"] == "done"]    # one card, no requeue


def test_a_finished_run_writes_a_receipt_with_missed_bars(app_parts):
    client, app, world, events = app_parts
    service = app.state.service
    service.tick()
    service.start_drill("song:very-early:run:Ending")
    play(world, service, "D-7")
    play(world, service, "F7")                       # miss on C#-7, in bar Ending.1.1
    for chord in ["C#-7", "Bbmaj7", "Gmaj7", "Bmaj7"]:
        play(world, service, chord)
    receipt = [e for e in events if e.get("event") == "receipt"][-1]["receipt"]
    assert receipt["mode"] == "play" and receipt["misses"] == {"Ending.1.1": 1}
    assert client.get("/api/songs/very-early/runs").json()[0]["misses"] == {"Ending.1.1": 1}


def test_unknown_song_decks_error(app_parts):
    _client, app, _world, events = app_parts
    assert app.state.service.start_drill("song:nope:phrases") is False
    assert app.state.service.start_drill("song:very-early:run:Q") is False
    assert [e for e in events if e["type"] == "error"]


# ── Anki ─────────────────────────────────────────────────────────────────────
def test_review_seeding_works_without_anki(app_parts):
    """The built-in scheduler is the default backend (§10): no Anki anywhere."""
    client, app, *_ = app_parts
    first = client.post("/api/songs/very-early/seed").json()
    assert first == {"backend": "local", "deck": "song:very-early", "added": 9, "updated": 0,
                     "unchanged": 0, "total": 9}
    assert client.get("/api/songs/very-early").json()["review"] == {
        "theme": "song:very-early", "backend": "local", "label": "Built-in", "available": True,
        "cards": 9, "due": 9}
    assert client.post("/api/songs/very-early/seed").json()["unchanged"] == 9
    # An edit to a song in review rewrites its cards on the spot — no second Add to review.
    client.put("/api/songs/very-early/bar/A.2.4", json={"text": "E7"})    # A2's back + A3's cue
    local = app.state.review.local
    backs = [local.card(d.card_id)["back"] for d in local.due("song:very-early")]
    assert sum("E7" in b for b in backs) == 1 and len(backs) == 9
    assert client.post("/api/songs/very-early/seed").json()["unchanged"] == 9
    assert "review:song:very-early" in app.state.service.deck_names()


def test_an_edit_leaves_a_song_out_of_review_out(app_parts):
    """Only a song already in review syncs: editing a chart never adds cards by itself."""
    client, app, *_ = app_parts
    client.put("/api/songs/very-early/bar/A.2.4", json={"text": "E7"})
    assert app.state.review.local.counts().get("song:very-early") is None


def test_seeding_adds_then_updates_never_duplicates(app_parts):
    client, app, *_ = app_parts
    anki = FakeAnki()
    app.state.review.anki._client = AnkiClient(transport=anki)
    app.state.review.set_backend("anki")
    first = client.post("/api/songs/very-early/seed").json()
    assert first == {"backend": "anki", "deck": "Music::PianoChords::Songs::Very Early",
                     "added": 9, "updated": 0, "unchanged": 0, "total": 9}
    fronts = sorted(n["Front"] for n in anki.notes.values())
    assert "Very Early · A line 2 (after A♭7)" in fronts
    assert all("song" in n["tags"] for n in anki.notes.values())
    again = client.post("/api/songs/very-early/seed").json()
    assert again["added"] == 0 and again["unchanged"] == 9

    client.put("/api/songs/very-early/bar/A.2.4", json={"text": "E7"})    # A2's back + A3's cue
    assert sum("E7" in n["Back"] for n in anki.notes.values()) == 1, "the edit synced Anki"
    fixed = client.post("/api/songs/very-early/seed").json()
    assert fixed["added"] == 0 and fixed["unchanged"] == 9 and len(anki.notes) == 9


def test_seeding_with_anki_closed_is_503(app_parts):
    client, app, *_ = app_parts

    def closed(_payload):
        raise OSError("refused")

    app.state.review.anki._client = AnkiClient(transport=closed)
    app.state.review.set_backend("anki")
    assert client.post("/api/songs/very-early/seed").status_code == 503


def test_anki_song_cards_decode_and_theme_sessions_fill(library):
    decks = SongDecks(library)
    item = decks.item_for_front("Very Early · A line 2 (after A♭7)")
    assert item.recall and [c.text for c in item.chords] == ["Dbmaj7", "G7", "Cmaj7", "Bb7"]
    assert decks.item_for_front("very early · B line 4 (start)").ref == "song:very-early:phrase:B4"
    assert decks.item_for_front("Very Early · Q line 1") is None
    assert decks.item_for_front("G7") is None
    assert decks.anki_themes() == {"song:very-early": anki_subdeck("Very Early")}
    assert len(decks.fill("song:very-early")) == 9


def test_the_trainer_runs_an_anki_song_session(library):
    from music.trainer.service import TrainerService
    from tests.test_anki import due_client
    subdeck = anki_subdeck("Very Early")
    client = due_client([(1, "Very Early · B line 1 (after G7)", subdeck)])
    world = FakeMidiWorld()
    world.add_device(in_name=PORT_NAME)
    events = []
    service = TrainerService(midi_module=world, publish=events.append, anki_client=client,
                             review_backend="anki")
    service.add_deck_source(SongDecks(library))
    assert "review:song:very-early" in service.deck_names()
    assert service.start_drill("anki:song:very-early")          # the legacy name still works
    assert len(service.engine.items) == 9                  # 1 due + 8 fill
    assert service.engine.items[0].ref == "song:very-early:phrase:B1"
