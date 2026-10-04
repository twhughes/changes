"""Page → song: fetch, normalize, two independent Claude reads, compare, save.

CONTRACTS.md §9. The pipeline, one stage per job event:

    fetch      a URL (public http(s); loopback only on registered hq ports;
               an HTML page is scanned for its chart) — or uploaded bytes
    normalize  keep the original as page.<ext>; make PNG rasters for Claude:
               an SVG's embedded scan is extracted (headless Chrome renders a
               vector-only SVG), a PDF goes through pdftoppm, HEIC/TIFF through sips
    read       two Claude reads of the same rasters, in parallel, each blind to
               the other — Claude in a locked-down CLI call (below)
    compare    the read with fewer problems becomes the chart; every bar where
               the other read disagrees, or a read marked a chord unsure, is a flag
    saved      songs/<id>/song.txt (+ import.json with both reads and the flags)

**The Claude call is vendored on purpose.** It follows the spawn shape of
``hq/llm.py`` ``run()`` (prompt on stdin, ``-p``) but does not import it: this
repo may be published and must not reach into HQ, and a page image is untrusted
input — ``--safe-mode --restricted --tools Read`` leaves a prompt injected
through the picture nothing to run. Tests inject ``llm`` instead.
"""

from __future__ import annotations

import base64
import html
import importlib.util
import ipaddress
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

from music.songs.chart import (
    ChartError,
    Song,
    format_cell,
    parse_song,
    written_bars,
)
from music.songs.store import IMPORT_FILE, READ_DIR, SONG_FILE, SongStore
from music.theory.chords import parse_chord

MAX_BYTES = 25 * 1024 * 1024
MAX_PAGES = 4                 # a standard is 1–2 pages; more is probably a whole book
MAX_SIDE = 2000               # px; Claude reads a phone photo fine at this size
FETCH_TIMEOUT_S = 20
READ_TIMEOUT_S = 300
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) music-songs/1.0"
HQ = Path(os.environ.get("HQ", Path(__file__).resolve().parents[3]))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

LLM = Callable[[str, Path], str]           # (prompt, read dir) -> reply text
OnStage = Callable[[str, str], None]       # (stage, message)


class ImportFailed(RuntimeError):
    """A stage failed; the message is shown to Tyler as-is."""


@dataclass
class Upload:
    data: bytes
    name: str          # file name (or the URL's last path part)
    origin: str        # where it came from: the URL, or the file name


# ── the Claude call ──────────────────────────────────────────────────────────
def _tool(name: str, *fallbacks: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    return next((p for p in fallbacks if Path(p).exists()), None)


def claude_cli(prompt: str, read_dir: Path, *, model: str | None = None,
               timeout: int = READ_TIMEOUT_S) -> str:
    """One locked-down Claude call: the Read tool only, confined to ``read_dir``.

    ``--safe-mode`` drops Tyler's CLAUDE.md/skills/hooks (they would shape the
    reply), ``--restricted`` drops every code-running tool and WebFetch, and
    ``--tools Read`` leaves the one tool the job needs.
    """
    binary = _tool("claude", str(Path.home() / ".local" / "bin" / "claude"))
    if binary is None:
        raise ImportFailed("the claude CLI is not installed — type the chart in the text editor instead")
    cmd = [binary, "-p", "--safe-mode", "--restricted", "--tools", "Read",
           "--strict-mcp-config", "--no-session-persistence"]
    model = model or os.environ.get("MUSIC_SONGS_MODEL") or None
    if model:
        cmd += ["--model", model]
    cmd += ["--add-dir", str(read_dir)]
    try:
        proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                              timeout=timeout, cwd=str(read_dir), check=False)
    except subprocess.TimeoutExpired:
        raise ImportFailed(f"Claude took longer than {timeout} s to read the page") from None
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-300:]
        raise ImportFailed(f"Claude failed (exit {proc.returncode}): {tail}")
    return proc.stdout


READ_PROMPT = """You are transcribing a jazz lead sheet (a Real Book style chord chart).
Use the Read tool on these image files, in order: {paths}
Transcribe the CHORD SYMBOLS and the FORM exactly as printed. Look at the melody only to
judge where a chord falls inside a bar. If the printed chart and your memory of the tune
disagree, the printed chart wins — never add or "correct" chords from memory.

Reply with ONLY one JSON object (no prose, no code fence):
{{"title": "...", "composer": "...", "style": "...", "time": "4/4", "key": "C",
 "sections": [{{"label": "A", "lines": [["Cmaj7", "Bb7", "Ebmaj7", "Ab7"], ["..."]]}}],
 "form": ["A", "A", "B"],
 "notes": "anything that does not fit above (D.C., coda, fine)"}}

sections:
- One section per rehearsal mark (the boxed letters A, B, C …), using the printed letter.
  No marks at all = one section "A". An ending, coda or tag printed as its own line is its
  own section ("Ending", "Coda"). Labels: letters/digits only, no spaces.
- "lines" = the printed systems of that section, top to bottom: one array per printed line,
  one string per BAR (count the barlines).
- A bar string = that bar's chords left to right, separated by single spaces.
  * More than one chord in a bar: give each its beats after a colon, adding up to the bar —
    in 3/4 "D-7:2 E-7:1", in 4/4 "Dm7:2 G7:2".
  * No new chord in the bar (the previous chord continues): "" (empty string).
  * A repeat-bar sign: "%". No chord (N.C.): "N.C.".
  * Bars under a 1st or 2nd ending bracket start with "1. " or "2. " ("1. G7"); keep both
    endings in the line where they are printed, in printed order.
- Symbols in ASCII exactly as printed: b = flat, # = sharp; keep the chart's own minor style
  ("-7" stays "-7", "m7" stays "m7"); "maj7" for a triangle; "m7b5" for ø; "dim7" for o7;
  parentheses as printed ("Bb7(#11)", "A7b5(b9)"); slash basses as printed ("D-7/C").
- Not sure of a symbol? Put "?" at its end ("G7#5?").
form: the order the sections are played for ONE chorus — expand repeat signs and 1st/2nd
endings (a section with a repeat and two endings appears twice: "A", "A"). Put an ending or
coda section last only if the chart says to play it at the end.
time: the time signature. key: from the key signature and the final chord ("C", "Cm").
style: the printed tempo/style marking ("Medium Waltz"), else "".
"""


# ── fetching ─────────────────────────────────────────────────────────────────
def _hq_ports() -> set[int]:
    """Registered hq ports (DRAG.md's loopback carve-out). Absent HQ → only our own."""
    path = HQ / "hq_ports.py"
    own = {int(os.environ.get("MUSIC_PORT", "8768"))}
    if not path.is_file():
        return own
    try:
        spec = importlib.util.spec_from_file_location("hq_ports_for_songs", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return own | {row["port"] for row in mod.registry() if not row.get("external")}
    except Exception:
        return own


def check_url(url: str) -> None:
    """Refuse what DRAG.md refuses: non-http(s), private addresses, unregistered loopback."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ImportFailed("only http(s) links can be imported")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(parts.hostname, port, proto=socket.IPPROTO_TCP)
    except OSError:
        raise ImportFailed(f"cannot find the host {parts.hostname}") from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_loopback:
            if port not in _hq_ports():
                raise ImportFailed(f"localhost:{port} is not a registered hq port")
        elif ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ImportFailed("links to private network addresses are refused")


def _get(url: str, opener=None) -> tuple[bytes, str]:
    check_url(url)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                   "Accept": "*/*"})
    open_ = opener or urllib.request.urlopen
    try:
        with open_(request, timeout=FETCH_TIMEOUT_S) as response:  # noqa: S310 (checked above)
            data = response.read(MAX_BYTES + 1)
            ctype = response.headers.get("Content-Type", "") if response.headers else ""
    except ImportFailed:
        raise
    except Exception as e:
        raise ImportFailed(f"could not download {url[:80]}: {e}") from None
    if len(data) > MAX_BYTES:
        raise ImportFailed("the file is over 25 MB")
    return data, ctype.split(";")[0].strip().lower()


_MEDIA_EXT = (".pdf", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic")
_SKIP_RE = re.compile(r"logo|icon|avatar|sprite|banner|favicon|emoji|badge|button", re.I)
_ATTR_RE = re.compile(r"""(?:src|href|data|content)\s*=\s*["']([^"']+)["']""", re.I)


def page_candidates(page_html: str, base_url: str) -> list[str]:
    """Chart files an HTML page points at, best first: PDF, SVG, then images."""
    seen: list[str] = []
    for raw in _ATTR_RE.findall(page_html):
        link = html.unescape(raw.strip())
        if link.startswith(("data:", "javascript:", "#", "mailto:")):
            continue
        absolute = urllib.parse.urljoin(base_url, link)
        path = urllib.parse.urlsplit(absolute).path.lower()
        if not path.endswith(_MEDIA_EXT) or _SKIP_RE.search(path):
            continue
        if absolute not in seen:
            seen.append(absolute)
    rank = {".pdf": 0, ".svg": 1}
    return sorted(seen, key=lambda u: rank.get(Path(urllib.parse.urlsplit(u).path.lower()).suffix, 2))


def fetch_url(url: str, opener=None, on_stage: OnStage | None = None) -> Upload:
    """Download a chart. An HTML page is scanned and its best chart link fetched."""
    data, ctype = _get(url, opener)
    name = Path(urllib.parse.urlsplit(url).path).name or "page"
    if ctype == "text/html" or (not sniff(data) and b"<html" in data[:2048].lower()):
        candidates = page_candidates(data.decode("utf-8", "replace"), url)
        if not candidates:
            raise ImportFailed("that page has no chart file (PDF/SVG/image) in it — "
                               "save the chart and drop the file instead")
        for link in candidates[:3]:
            if on_stage:
                on_stage("fetch", f"found {Path(urllib.parse.urlsplit(link).path).name} on the page")
            try:
                inner, _ = _get(link, opener)
            except ImportFailed:
                continue
            if sniff(inner):
                return Upload(inner, Path(urllib.parse.urlsplit(link).path).name, link)
        raise ImportFailed("none of the chart links on that page downloaded")
    return Upload(data, name, url)


# ── normalizing ──────────────────────────────────────────────────────────────
def sniff(data: bytes) -> str | None:
    """The file's real type as an extension ('.pdf', '.svg' …), from its bytes."""
    head = data[:512]
    if head.startswith(b"%PDF"):
        return ".pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    if head[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1", b"ftypheif", b"ftyphevc"):
        return ".heic"
    if head.startswith((b"II*\x00", b"MM\x00*")):
        return ".tif"
    text = data[:4096].lstrip(b"\xef\xbb\xbf").lstrip().lower()
    if text.startswith((b"<svg", b"<?xml")) and b"<svg" in data[:65536].lower():
        return ".svg"
    return None


def _png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return 0, 0
    return struct.unpack(">II", head[16:24])


def _sips(*args: str) -> None:
    sips = _tool("sips", "/usr/bin/sips")
    if sips is None:
        raise ImportFailed("sips is missing (macOS image tool)")
    proc = subprocess.run([sips, *args], capture_output=True, text=True, check=False, timeout=60)
    if proc.returncode != 0:
        raise ImportFailed(f"sips could not convert the image: {proc.stderr.strip()[-200:]}")


def _to_png(src: Path, dest: Path) -> Path:
    if src.suffix.lower() == ".png":
        if src.resolve() != dest.resolve():
            shutil.copyfile(src, dest)
    else:
        _sips("-s", "format", "png", str(src), "--out", str(dest))
    width, height = _png_size(dest)
    if max(width, height) > MAX_SIDE:
        _sips("-Z", str(MAX_SIDE), str(dest))
    return dest


_EMBED_RE = re.compile(rb"data:image/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)")


def _svg_rasters(svg: bytes) -> list[tuple[str, bytes]]:
    out = []
    for kind, payload in _EMBED_RE.findall(svg):
        try:
            out.append((kind.decode(), base64.b64decode(re.sub(rb"\s", b"", payload))))
        except ValueError:
            continue
    return sorted(out, key=lambda kb: -len(kb[1]))


def _svg_size(svg: bytes) -> tuple[int, int]:
    head = svg[:4096].decode("utf-8", "replace")
    w = re.search(r'\bwidth="([\d.]+)', head)
    h = re.search(r'\bheight="([\d.]+)', head)
    if w and h:
        return int(float(w.group(1))), int(float(h.group(1)))
    vb = re.search(r'viewBox="[\d.\s-]+?\s([\d.]+)\s+([\d.]+)"', head)
    if vb:
        return int(float(vb.group(1))), int(float(vb.group(2)))
    return 816, 1056


def _render_svg(svg_path: Path, dest: Path) -> None:
    """Vector-only SVG → PNG with headless Chrome (a throwaway profile, no window)."""
    if not Path(CHROME).exists():
        raise ImportFailed("a vector SVG needs Google Chrome to render it — export a PNG/PDF instead")
    width, height = _svg_size(svg_path.read_bytes())
    with tempfile.TemporaryDirectory() as profile:
        wrapper = Path(profile) / "page.html"
        wrapper.write_text(f'<html><body style="margin:0;background:#fff">'
                           f'<img src="{svg_path.resolve().as_uri()}" width="{width}" '
                           f'height="{height}"></body></html>')
        cmd = [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
               f"--user-data-dir={profile}", "--force-device-scale-factor=2",
               "--allow-file-access-from-files", f"--window-size={width},{height}",
               f"--screenshot={dest}", wrapper.as_uri()]
        subprocess.run(cmd, capture_output=True, timeout=60, check=False)
    if not dest.exists():
        raise ImportFailed("Chrome could not render the SVG")


def prepare_reads(page: Path, read_dir: Path) -> list[Path]:
    """The PNG(s) Claude will read, made from the original page file."""
    if read_dir.exists():
        shutil.rmtree(read_dir)
    read_dir.mkdir(parents=True)
    kind = page.suffix.lower()
    if kind == ".svg":
        rasters = _svg_rasters(page.read_bytes())
        if rasters and len(rasters[0][1]) >= 50_000:      # an embedded scan: use its pixels
            ext, data = rasters[0]
            raw = read_dir / f"embedded.{'jpg' if ext.startswith('jp') else ext}"
            raw.write_bytes(data)
            out = _to_png(raw, read_dir / "page-1.png")
            if raw != out:
                raw.unlink()
            return [out]
        out = read_dir / "page-1.png"
        _render_svg(page, out)
        return [_to_png(out, out)]
    if kind == ".pdf":
        pdftoppm = _tool("pdftoppm", "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm")
        if pdftoppm:
            subprocess.run([pdftoppm, "-r", "150", "-png", "-f", "1", "-l", str(MAX_PAGES),
                            str(page), str(read_dir / "page")], capture_output=True,
                           timeout=120, check=False)
            pages = sorted(read_dir.glob("page-*.png"))
            if pages:
                return [_to_png(p, p) for p in pages]
        return [_to_png(page, read_dir / "page-1.png")]        # sips: first page only
    return [_to_png(page, read_dir / "page-1.png")]


# ── reading ──────────────────────────────────────────────────────────────────
def parse_reply(reply: str) -> dict:
    """The JSON object in Claude's reply (a code fence around it is fine)."""
    start, end = reply.find("{"), reply.rfind("}")
    if start < 0 or end <= start:
        raise ImportFailed("Claude's reply had no JSON in it")
    try:
        data = json.loads(reply[start:end + 1])
    except ValueError as e:
        raise ImportFailed(f"Claude's reply was not valid JSON ({e})") from None
    if not isinstance(data, dict) or not isinstance(data.get("sections"), list):
        raise ImportFailed("Claude's reply had no sections")
    return data


def read_once(paths: list[Path], read_dir: Path, llm: LLM) -> dict:
    prompt = READ_PROMPT.format(paths=", ".join(str(p) for p in paths))
    return parse_reply(llm(prompt, read_dir))


_CELL_FIXES = (("♭", "b"), ("♯", "#"), ("−", "-"), ("–", "-"), ("—", "-"), ("|", " "))
_VOLTA_FIX_RE = re.compile(r"^(\d)(?:st|nd|rd|th|\)|\.)?\s+(?=\S)")


def clean_cell(cell) -> tuple[str, bool]:
    """A bar string from a read → (cell text in song format, unsure?)."""
    text = "" if cell is None else str(cell)
    for bad, good in _CELL_FIXES:
        text = text.replace(bad, good)
    text = " ".join(text.split())
    unsure = "?" in text
    text = text.replace("?", "")
    m = _VOLTA_FIX_RE.match(text)
    if m:
        text = f"{m.group(1)}. " + text[m.end():]
    elif re.fullmatch(r"\d\.?", text):
        text = text.rstrip(".") + "."
    return text.strip(), unsure


def _label(raw, taken: set[str]) -> str:
    label = re.sub(r"[^A-Za-z0-9'_\-]", "", str(raw or ""))[:16] or "A"
    candidate, n = label, 2
    while candidate in taken:
        candidate, n = f"{label}{n}", n + 1
    taken.add(candidate)
    return candidate


def _header_value(value) -> str:
    return " ".join(str(value or "").replace("\n", " ").split())


def read_to_text(read: dict, origin: str) -> tuple[str, set[str]]:
    """A read → (song text v1, addresses of bars the read marked unsure)."""
    taken: set[str] = set()
    renamed: dict[str, str] = {}
    duplicate = False
    body: list[str] = []
    unsure: set[str] = set()
    for section in read.get("sections") or []:
        if not isinstance(section, dict):
            continue
        raw_label = str(section.get("label") or "")
        label = _label(raw_label, taken)
        if raw_label in renamed:
            duplicate = True
        renamed.setdefault(raw_label, label)
        rows = []
        for li, line in enumerate(section.get("lines") or [], start=1):
            if isinstance(line, str):                 # "| Cmaj7 | Bb7 |" instead of a list
                line = [c.strip() for c in line.split("|")]
                line = line[1:] if line and line[0] == "" else line
                line = line[:-1] if line and line[-1] == "" else line
            if not isinstance(line, list) or not line:
                continue
            cells = []
            for bi, cell in enumerate(line, start=1):
                text, maybe = clean_cell(cell)
                cells.append(text)
                if maybe:
                    unsure.add(f"{label}.{len(rows) + 1}.{bi}")
            rows.append("| " + " | ".join(cells) + " |")
        if rows:
            body += ["", f"[{label}]", *rows]
    form = [renamed.get(str(lbl)) for lbl in read.get("form") or []]
    if duplicate or not all(form):
        form = []                     # ambiguous: play the written order, Tyler fixes it
    time_sig = _header_value(read.get("time")) or "4/4"
    if not re.fullmatch(r"\d{1,2}/\d{1,2}", time_sig):
        time_sig = "4/4"
    header = [f"title: {_header_value(read.get('title')) or 'Untitled'}"]
    for key in ("composer", "style", "key"):
        value = _header_value(read.get(key))
        if value:
            header.append(f"{key}: {value}")
    header.append(f"time: {time_sig}")
    if form:
        header.append("form: " + " ".join(form))
    header.append(f"source: {_header_value(origin)}")
    return "\n".join(header + body) + "\n", unsure


def _build(read: dict, origin: str) -> tuple[Song, list, set[str], str]:
    """(song, problems, unsure, text) for one read; ChartError if it cannot be a song."""
    text, unsure = read_to_text(read, origin)
    try:
        song, problems = parse_song(text)
    except ChartError:
        # One retry without the form: a form naming a missing section is the common break.
        text = "\n".join(line for line in text.splitlines() if not line.startswith("form:")) + "\n"
        song, problems = parse_song(text)
    return song, problems, unsure, text


# ── comparing two reads ──────────────────────────────────────────────────────
def _bar_key(bar) -> tuple:
    chords = []
    for slot in bar.slots:
        try:
            c = parse_chord(slot.symbol)
            chords.append((c.root_pc, c.intervals, c.bass_pc))
        except ValueError:
            chords.append(slot.symbol.lower())
    return bar.volta, tuple(chords)


def _beats_key(bar) -> tuple:
    return tuple(round(s.beats, 2) for s in bar.slots)


def _grid(song: Song) -> list[list[list]]:
    return [[list(line.bars) for line in section.lines] for section in song.sections]


def compare(primary: Song, other: Song | None, unsure: set[str]) -> list[dict]:
    """Flags for the check screen: disagreements with the other read + unsure bars."""
    flags: list[dict] = []
    grid_b = _grid(other) if other is not None else None
    for si, section in enumerate(primary.sections):
        for li, line in enumerate(section.lines):
            row_b = None
            if grid_b is not None and si < len(grid_b) and li < len(grid_b[si]):
                row_b = grid_b[si][li]
            for bi, bar in enumerate(line.bars):
                addr = f"{section.label}.{li + 1}.{bi + 1}"
                text = format_cell(bar, primary.beats_per_bar)
                flag = None
                if grid_b is not None:
                    bar_b = row_b[bi] if row_b is not None and bi < len(row_b) else None
                    if bar_b is None:
                        flag = {"message": "the second read has no bar here", "other": None}
                    elif _bar_key(bar) != _bar_key(bar_b):
                        flag = {"message": "the two reads differ",
                                "other": format_cell(bar_b, other.beats_per_bar)}
                    elif _beats_key(bar) != _beats_key(bar_b):
                        flag = {"message": "the two reads split the beats differently",
                                "other": format_cell(bar_b, other.beats_per_bar)}
                if addr in unsure:
                    flag = flag or {"message": "Claude was not sure of this bar", "other": None}
                    if "not sure" not in flag["message"]:
                        flag["message"] += " (and was not sure)"
                if flag:
                    flags.append({"addr": addr, "text": text, **flag})
            if row_b is not None and len(row_b) > len(line.bars) and line.bars:
                last = f"{section.label}.{li + 1}.{len(line.bars)}"
                if not any(f["addr"] == last for f in flags):
                    flags.append({"addr": last,
                                  "text": format_cell(line.bars[-1], primary.beats_per_bar),
                                  "message": f"the second read has {len(row_b) - len(line.bars)} "
                                             "more bar(s) in this line", "other": None})
    return flags


# ── the whole import ─────────────────────────────────────────────────────────
def _score(problems: list, unsure: set[str]) -> int:
    return len(problems) * 2 + len(unsure)


def run_import(store: SongStore, upload: Upload, *, llm: LLM | None = None,
               on_stage: OnStage | None = None, song_id: str | None = None,
               reads: int = 2) -> str:
    """Import ``upload`` as a new song (or re-read it into ``song_id``); returns the id."""
    stage = on_stage or (lambda _s, _m: None)
    llm = llm or (lambda prompt, read_dir: claude_cli(prompt, read_dir))
    started = time.monotonic()
    if not upload.data:
        raise ImportFailed("the file is empty")
    if len(upload.data) > MAX_BYTES:
        raise ImportFailed("the file is over 25 MB")
    kind = sniff(upload.data)
    if kind is None:
        raise ImportFailed(f"{upload.name or 'that file'} is not a PDF, SVG or image")

    stage("normalize", f"preparing {upload.name or 'the page'}")
    store.root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".incoming-", dir=store.root))
    try:
        page = work / f"page{kind}"
        page.write_bytes(upload.data)
        paths = prepare_reads(page, work / READ_DIR)

        stage("read", f"Claude is reading the page ({reads} independent read"
                      f"{'s' if reads != 1 else ''})")
        results: list[dict | Exception] = []
        with ThreadPoolExecutor(max_workers=reads) as pool:
            futures = [pool.submit(read_once, paths, work / READ_DIR, llm) for _ in range(reads)]
            for future in futures:
                try:
                    results.append(future.result())
                except Exception as e:      # one failed read still leaves the other
                    results.append(e)
        built = []
        for result in results:
            if isinstance(result, Exception):
                continue
            try:
                built.append((result, *_build(result, upload.origin)))
            except ChartError as e:
                results[results.index(result)] = ImportFailed(f"unusable read: {e}")
        if not built:
            errors = "; ".join(str(r) for r in results if isinstance(r, Exception))
            raise ImportFailed(errors or "Claude could not read a chart from the page")

        stage("compare", "comparing the reads")
        built.sort(key=lambda b: _score(b[2], b[3]))
        _read_a, song, _problems, unsure, text = built[0]
        other = built[1][1] if len(built) > 1 else None
        if len(built) > 1:
            unsure = unsure | built[1][3]        # either read's doubt is worth a look
        flags = compare(song, other, unsure)
        if other is not None and song.play_form != other.play_form:
            flags.append({"addr": "form", "text": " ".join(song.form),
                          "message": "the two reads disagree on the form",
                          "other": " ".join(other.form)})

        if song_id is None:
            song_id = store.new_id(song.title)
            target = store.dir(song_id)
            target.mkdir(parents=True)
        else:
            target = store.dir(song_id)
            if (target / SONG_FILE).is_file():        # one level of undo for a re-read
                shutil.copyfile(target / SONG_FILE, target / "song.prev.txt")
        store.save_page(song_id, upload.data, kind)
        if (target / READ_DIR).exists():
            shutil.rmtree(target / READ_DIR)
        shutil.move(str(work / READ_DIR), str(target / READ_DIR))
        store.write_text(song_id, text)
        store.write_import_record(song_id, {
            "v": 1, "at": datetime.now().isoformat(timespec="seconds"),
            "origin": upload.origin, "name": upload.name, "kind": kind,
            "reads": [r if isinstance(r, dict) else {"error": str(r)} for r in results],
            "flags": flags, "elapsed_s": round(time.monotonic() - started, 1),
        })
        n = len(flags)
        stage("saved", f"{song.title}: {len(written_bars(song))} bars"
                       + (f", {n} bar{'s' if n != 1 else ''} to check" if n else
                          ", both reads agree"))
        return song_id
    finally:
        shutil.rmtree(work, ignore_errors=True)


def upload_from_path(path: str | Path) -> Upload:
    p = Path(path).expanduser()
    data = p.read_bytes()
    return Upload(data, p.name, p.name)


def import_record_path(store: SongStore, song_id: str) -> Path:
    return store.dir(song_id) / IMPORT_FILE
