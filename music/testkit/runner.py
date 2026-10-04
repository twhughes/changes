"""The live terminal exam: prompt → listen → grade → note → next.

Everything the grader sees goes through the capture file first (rec.event
returns the normalized event we feed the tracker), so the session that just
happened can be replayed and re-graded byte-for-byte: live ≡ replay.
"""

from __future__ import annotations

import argparse
import queue
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from music.learn.drill import DrillEngine
from music.midio.backend import MidiIO
from music.midio.capture import Recorder
from music.midio.notes import NoteTracker
from music.testkit.examdef import Exam, load_exam
from music.testkit.report import write_session

POLL_S = 0.005
NOTE_PROMPT = "  note (Enter=none): "

_BOLD, _GREEN, _RED, _DIM, _RESET = "\033[1m", "\033[32m", "\033[31m", "\033[2m", "\033[0m"


def _paint(code: str, text: str) -> str:
    return f"{code}{text}{_RESET}" if sys.stdout.isatty() else text


class ExamRunner:
    """One exam, one session directory. Owns the poll loop and the terminal UI."""

    def __init__(self, exam: Exam, session_dir: str | Path, midi: MidiIO,
                 port_name: str, take_notes: bool = True) -> None:
        self.exam = exam
        self.dir = Path(session_dir)
        self.midi = midi
        self.port_name = port_name
        self.take_notes = take_notes
        self.started_iso = datetime.now().astimezone().isoformat()
        self.tracker = NoteTracker()
        self.engine = DrillEngine(exam.items, on_event=self._on_event)
        self.rec: Recorder | None = None
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._eof = False
        self._quit = False

    # ── terminal + marks ───────────────────────────────────────────────────
    def _on_event(self, name: str, p: dict) -> None:
        idx = p.get("idx", 0)
        if name == "prompt":
            self.rec.mark(f"item:{idx}:prompt")
            print(f"\n{idx + 1}/{p['total']}  " + _paint(_BOLD, p["prompt"]))
        elif name == "attempt":
            verdict = p["verdict"]
            self.rec.mark(f"item:{idx}:attempt:{'ok' if verdict['ok'] else 'fail'}")
            if verdict["ok"]:
                print(_paint(_GREEN, f"  ✓ {p['latency_s']:.2f}s"))
            else:
                print(_paint(_RED, f"  ✗ {verdict['summary']}"))
        elif name == "passed":
            self.rec.mark(f"item:{idx}:passed")
            self._ask_note(idx)     # before the engine advances: the note belongs to this item
        elif name == "skipped":
            self.rec.mark(f"item:{idx}:skipped")
            print(_paint(_DIM, "  ⏭ skipped"))
            self._ask_note(idx)

    # ── stdin (a reader thread; the loop consumes lines from the queue) ────
    def _read_stdin(self) -> None:
        try:
            for line in sys.stdin:
                self._lines.put(line.strip())
        except Exception:
            pass
        self._lines.put(None)

    def _next_line(self) -> str | None:
        """The next typed line, or None once stdin is closed (never blocks after EOF)."""
        if self._eof:
            return None
        line = self._lines.get()
        if line is None:
            self._eof = True
        return line

    def _handle_commands(self) -> None:
        while True:
            try:
                line = self._lines.get_nowait()
            except queue.Empty:
                return
            if line is None:              # stdin closed: no more controls
                self._eof = True
                return
            if line == "s":
                self.engine.skip(self.rec.rel(time.monotonic()))
            elif line == "q":
                self._quit = True
            # anything else typed mid-item is ignored

    # ── loop ───────────────────────────────────────────────────────────────
    def _tick(self) -> None:
        for type_, note, vel, ch, mono_t in self.midi.poll():
            self.tracker.feed(self.rec.event(type_, note, vel, ch, mono_t))
        self.engine.feed(self.rec.rel(time.monotonic()), self.tracker)
        self._handle_commands()

    def _ask_note(self, idx: int) -> None:
        """Pause the exam for a free-text note; nothing played meanwhile counts."""
        if not self.take_notes or idx >= len(self.engine.results) or self._eof:
            return
        paused_at = time.monotonic()
        held = sorted(self.tracker.held)
        print(NOTE_PROMPT, end="", flush=True)
        line = self._next_line()          # blocks; the reader thread owns stdin
        if line:
            self.engine.results[idx].note = line
        self.midi.poll()                  # keys touched while typing are discarded
        # Hide the typing pause from the timeline, then release everything the
        # capture still shows as held — so a replay's tracker clears too.
        self.rec.t0 += time.monotonic() - paused_at
        now = time.monotonic()
        for note in held:
            self.rec.event("note_off", note, 0, 0, now)
        self.tracker.clear()

    def run(self) -> Path:
        self.dir.mkdir(parents=True, exist_ok=True)
        self.rec = Recorder(self.dir / "midi.jsonl", self.port_name)
        threading.Thread(target=self._read_stdin, daemon=True).start()
        print(_paint(_BOLD, f"{self.exam.id} — {self.exam.title}")
              + _paint(_DIM, f"   ({len(self.exam.items)} items · port {self.port_name})"))
        print(_paint(_DIM, "  s+Enter skip · q+Enter end early · ctrl-c quit"))
        try:
            self.engine.start(self.rec.rel(time.monotonic()))
            while not self.engine.done and not self._quit:
                self._tick()
                time.sleep(POLL_S)
        except KeyboardInterrupt:
            print("\n" + _paint(_DIM, "  ended early (ctrl-c)"))
            self._quit = True
        self._finish()
        return self.dir

    def _finish(self) -> None:
        self.take_notes = False           # don't interrogate the items nobody played
        while not self.engine.done:       # ending early: the rest are skips
            self.engine.skip(self.rec.rel(time.monotonic()))
        duration = self.rec.rel(time.monotonic())
        self.rec.close()
        write_session(self.dir, self.exam, self.engine.results, self.started_iso,
                      duration_s=duration)
        passed = sum(1 for r in self.engine.results if r.passed)
        print(f"\n{self.dir}")
        print(_paint(_BOLD, f"  {passed}/{len(self.engine.results)} passed")
              + f" · {duration:.0f}s · report.md written")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m music.testkit run",
                                 description="Run an interactive MIDI chord exam.")
    ap.add_argument("exam", help="path to an exam YAML (CONTRACTS §2)")
    ap.add_argument("--port", help="MIDI input port name (default: first keyboard)")
    ap.add_argument("--session-dir", help="where to write the session (default: sessions/<ts>_<id>)")
    ap.add_argument("--no-notes", action="store_true", help="don't ask for a note after each item")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    exam = load_exam(args.exam)
    midi = MidiIO()
    port = args.port or midi.first_keyboard()
    if not port:
        print("no MIDI input port found — plug in a keyboard or pass --port", file=sys.stderr)
        print(f"available: {midi.input_names() or 'none'}", file=sys.stderr)
        return 2
    try:
        midi.open_input(port)
    except Exception as exc:
        print(f"could not open MIDI port {port!r}: {exc}", file=sys.stderr)
        return 2
    session_dir = args.session_dir or (
        Path("sessions") / f"{datetime.now():%Y-%m-%dT%H-%M}_{exam.id}")
    try:
        ExamRunner(exam, session_dir, midi, port, take_notes=not args.no_notes).run()
    finally:
        midi.close()
    return 0
