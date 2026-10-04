"""Songs import: page normalizing, Claude's reply, two-read comparison, URL rules.

Claude is never called: ``llm`` is a scripted fake that checks it was pointed at
a real raster. The real call (``claude_cli``) was exercised by hand on the Very
Early page — see STATUS.md.
"""

import base64
import json
import random
import socket
import struct
import threading
import zlib
from pathlib import Path

import pytest

from music.songs import importer
from music.songs.chart import parse_song
from music.songs.importer import ImportFailed, Upload
from music.songs.store import SongStore

READ = {
    "title": "Test Tune", "composer": "Nobody", "style": "Medium Swing", "time": "4/4",
    "key": "F",
    "sections": [
        {"label": "A", "lines": [["F6", "D-7", "G-7", "C7"],
                                 ["F6", "Bb7", "1. G-7:2 C7:2", "2. F6"]]},
        {"label": "B", "lines": [["Bbmaj7", "Bb-7", "A-7", "D7"]]},
    ],
    "form": ["A", "A", "B"], "notes": "",
}


def make_png(width: int = 240, height: int = 240, seed: int = 1) -> bytes:
    """A real PNG of noise — big enough (~170 KB) to count as an embedded scan."""
    rnd = random.Random(seed)
    raw = b"".join(b"\x00" + rnd.randbytes(width * 3) for _ in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def svg_with(png: bytes) -> bytes:
    payload = base64.b64encode(png).decode()
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="612" height="792"><image xlink:href="data:image/png;base64,{payload}"/></svg>'
            ).encode()


class FakeLLM:
    """Answers each read from a script; asserts the prompt names an existing raster."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.prompts: list[str] = []
        self.lock = threading.Lock()

    def __call__(self, prompt: str, read_dir: Path) -> str:
        with self.lock:
            self.prompts.append(prompt)
            reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        assert (read_dir / "page-1.png").is_file()
        assert str(read_dir / "page-1.png") in prompt
        if isinstance(reply, Exception):
            raise reply
        return reply if isinstance(reply, str) else json.dumps(reply)


def variant(**changes) -> dict:
    read = json.loads(json.dumps(READ))
    for (si, li, bi), cell in changes.get("cells", {}).items():
        read["sections"][si]["lines"][li][bi] = cell
    return read


# ── normalizing ──────────────────────────────────────────────────────────────
def test_sniff_reads_the_bytes_not_the_name():
    png = make_png(8, 8)
    assert importer.sniff(png) == ".png"
    assert importer.sniff(b"%PDF-1.7 ...") == ".pdf"
    assert importer.sniff(svg_with(png)) == ".svg"
    assert importer.sniff(b"\xff\xd8\xff\xe0rest") == ".jpg"
    assert importer.sniff(b"\x00\x00\x00\x18ftypheic....") == ".heic"
    assert importer.sniff(b"hello") is None


def test_an_svg_scan_is_extracted_pixel_for_pixel(tmp_path):
    png = make_png()
    page = tmp_path / "page.svg"
    page.write_bytes(svg_with(png))
    reads = importer.prepare_reads(page, tmp_path / "read")
    assert [p.name for p in reads] == ["page-1.png"]
    assert reads[0].read_bytes() == png


def test_a_png_page_is_read_as_is(tmp_path):
    page = tmp_path / "page.png"
    page.write_bytes(make_png(16, 16))
    assert importer.prepare_reads(page, tmp_path / "read")[0].read_bytes() == page.read_bytes()


# ── Claude's reply → song text ───────────────────────────────────────────────
def test_reply_json_survives_a_code_fence_and_prose():
    reply = "Here you go:\n```json\n" + json.dumps(READ) + "\n```"
    assert importer.parse_reply(reply)["title"] == "Test Tune"
    for bad in ("no json here", "{not json}", '{"title": "x"}'):
        with pytest.raises(ImportFailed):
            importer.parse_reply(bad)


@pytest.mark.parametrize("raw, cell, unsure", [
    ("B♭7(♯11)", "Bb7(#11)", False), ("1st G7", "1. G7", False), ("2) Cmaj7", "2. Cmaj7", False),
    ("G7#5?", "G7#5", True), (None, "", False), ("D–7", "D-7", False), ("1.", "1.", False),
])
def test_clean_cell(raw, cell, unsure):
    assert importer.clean_cell(raw) == (cell, unsure)


def test_read_to_text_builds_a_valid_song():
    text, unsure = importer.read_to_text(variant(cells={(1, 0, 3): "D7?"}), "tune.png")
    song, problems = parse_song(text)
    assert problems == [] and unsure == {"B.1.4"}
    assert song.title == "Test Tune" and song.form == ("A", "A", "B") and song.source == "tune.png"
    assert [b.volta for b in song.section("A").lines[1].bars] == [None, None, 1, 2]


def test_duplicate_labels_are_renamed_and_the_form_dropped():
    read = variant()
    read["sections"].append({"label": "A", "lines": ["| F6 | C7 |"]})    # string line, too
    text, _ = importer.read_to_text(read, "x")
    song, _ = parse_song(text)
    assert [s.label for s in song.sections] == ["A", "B", "A2"]
    assert song.form == () and len(song.section("A2").lines[0].bars) == 2


# ── the whole import ─────────────────────────────────────────────────────────
def test_two_agreeing_reads_make_a_clean_draft(tmp_path):
    store = SongStore(tmp_path)
    llm = FakeLLM(READ)
    stages = []
    song_id = importer.run_import(store, Upload(make_png(), "tune.png", "tune.png"), llm=llm,
                                  on_stage=lambda s, m: stages.append(s))
    assert song_id == "test-tune" and len(llm.prompts) == 2
    assert stages == ["normalize", "read", "compare", "saved"]
    song, problems = store.load(song_id)
    assert problems == [] and song.checked == ""
    assert store.live_flags(song_id, song) == []
    assert store.page(song_id).name == "page.png" and len(store.reads(song_id)) == 1
    record = store.import_record(song_id)
    assert len(record["reads"]) == 2 and record["origin"] == "tune.png"
    assert not any(p.name.startswith(".incoming") for p in tmp_path.iterdir())


def test_disagreements_and_doubts_become_flags(tmp_path):
    store = SongStore(tmp_path)
    other = variant(cells={(0, 0, 1): "D7", (1, 0, 3): "D7?"})
    song_id = importer.run_import(store, Upload(make_png(), "t.png", "t.png"),
                                  llm=FakeLLM(READ, other))
    song, _ = store.load(song_id)
    flags = {f["addr"]: f for f in store.live_flags(song_id, song)}
    assert set(flags) == {"A.1.2", "B.1.4"}
    assert flags["A.1.2"]["other"] in ("D7", "D-7")
    assert "not sure" in flags["B.1.4"]["message"]


def test_a_flag_clears_when_its_bar_is_edited(tmp_path):
    store = SongStore(tmp_path)
    song_id = importer.run_import(store, Upload(make_png(), "t.png", "t.png"),
                                  llm=FakeLLM(READ, variant(cells={(0, 0, 1): "D7"})))
    from music.songs.chart import format_song, replace_cell
    song, _ = store.load(song_id)
    assert len(store.live_flags(song_id, song)) == 1
    store.write_text(song_id, format_song(replace_cell(song, "A.1.2", "D-7b5")))
    song, _ = store.load(song_id)
    assert store.live_flags(song_id, song) == []


def test_one_failed_read_still_imports(tmp_path):
    store = SongStore(tmp_path)
    song_id = importer.run_import(store, Upload(make_png(), "t.png", "t.png"),
                                  llm=FakeLLM(ImportFailed("boom"), READ))
    assert store.load(song_id)[0].title == "Test Tune"


def test_failures_are_plain_messages(tmp_path):
    store = SongStore(tmp_path)
    with pytest.raises(ImportFailed, match="not a PDF, SVG or image"):
        importer.run_import(store, Upload(b"hello", "x.txt", "x.txt"), llm=FakeLLM(READ))
    with pytest.raises(ImportFailed, match="no JSON"):
        importer.run_import(store, Upload(make_png(), "t.png", "t"), llm=FakeLLM("sorry"))
    assert store.ids() == []
    assert not any(p.name.startswith(".incoming") for p in tmp_path.iterdir())


def test_a_reread_keeps_one_level_of_undo(tmp_path):
    store = SongStore(tmp_path)
    upload = Upload(make_png(), "t.png", "t.png")
    song_id = importer.run_import(store, upload, llm=FakeLLM(READ))
    before = store.text(song_id)
    importer.run_import(store, upload, llm=FakeLLM(variant(cells={(0, 0, 0): "F"})),
                        song_id=song_id)
    assert (store.dir(song_id) / "song.prev.txt").read_text() == before
    assert "| F " in store.text(song_id)


# ── URLs ─────────────────────────────────────────────────────────────────────
def _resolve_to(monkeypatch, ip: str):
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda host, port, **kw: [(socket.AF_INET, 0, 0, "", (ip, port))])


def test_url_rules(monkeypatch):
    with pytest.raises(ImportFailed, match="http"):
        importer.check_url("file:///etc/passwd")
    _resolve_to(monkeypatch, "192.168.1.5")
    with pytest.raises(ImportFailed, match="private"):
        importer.check_url("http://router.local/page.pdf")
    _resolve_to(monkeypatch, "127.0.0.1")
    monkeypatch.setattr(importer, "_hq_ports", lambda: {8768, 8800})
    with pytest.raises(ImportFailed, match="registered"):
        importer.check_url("http://localhost:6379/")
    importer.check_url("http://127.0.0.1:8800/media/x.png")          # an hq app: allowed
    _resolve_to(monkeypatch, "93.184.216.34")
    importer.check_url("https://example.com/x.pdf")


def test_page_candidates_prefer_pdf_then_svg_and_skip_logos():
    page = ('<img src="/static/logo.png"><a href="charts/very-early.pdf">pdf</a>'
            '<img src="https://cdn.x.org/scan-428.jpg"><embed src="sheet.svg">')
    assert importer.page_candidates(page, "https://x.org/tunes/") == [
        "https://x.org/tunes/charts/very-early.pdf", "https://x.org/tunes/sheet.svg",
        "https://cdn.x.org/scan-428.jpg"]


class _Response:
    def __init__(self, data: bytes, ctype: str):
        self.data, self.headers = data, {"Content-Type": ctype}

    def read(self, n=-1):
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_an_html_page_is_scanned_for_its_chart(monkeypatch):
    _resolve_to(monkeypatch, "93.184.216.34")
    png = make_png(16, 16)
    served = {"https://x.org/tune": (b'<html><img src="/p/scan.png"></html>', "text/html"),
              "https://x.org/p/scan.png": (png, "image/png")}
    upload = importer.fetch_url("https://x.org/tune",
                                opener=lambda req, timeout: _Response(*served[req.full_url]))
    assert upload.data == png and upload.name == "scan.png"
    assert upload.origin == "https://x.org/p/scan.png"


def test_reads_that_disagree_on_the_form_flag_the_form(tmp_path):
    store = SongStore(tmp_path)
    other = variant()
    other["form"] = ["A", "B"]
    song_id = importer.run_import(store, Upload(make_png(), "t.png", "t.png"),
                                  llm=FakeLLM(READ, other))
    song, problems = store.load(song_id)
    flags = {f["addr"]: f for f in store.live_flags(song_id, song)}
    assert set(flags) == {"form"}
    assert {flags["form"]["other"], " ".join(song.form)} == {"A A B", "A B"}
    # Applying either form settles it (the flag only lives while the form reads as flagged).
    from music.songs.chart import format_song
    song.form = ("A", "A", "B") if song.form != ("A", "A", "B") else ("A", "B")
    store.write_text(song_id, format_song(song))
    assert store.live_flags(song_id, store.load(song_id)[0]) == []


def test_looks_right_settles_open_flags(tmp_path):
    from music.songs.service import SongsService
    store = SongStore(tmp_path)
    song_id = importer.run_import(store, Upload(make_png(), "t.png", "t.png"),
                                  llm=FakeLLM(READ, variant(cells={(0, 0, 1): "D7"})))
    service = SongsService(store=store)
    assert len(service.song(song_id)["flags"]) == 1
    checked = service.patch(song_id, {"checked": True})
    assert checked["flags"] == [] and checked["checked"]
    assert store.import_record(song_id)["accepted_flags"][0]["addr"] == "A.1.2"
