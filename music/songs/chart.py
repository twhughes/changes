"""Song text v1 — the chart format, its model, and what practice derives from it.

CONTRACTS.md §9. A song is a small text file Tyler can read and fix by hand::

    title: Very Early
    time: 3/4
    form: A A B Ending

    [A]
    | Cmaj7  | Bb7 | Ebmaj7 | Ab7      |
    | E-9    | Ab7 | Dbmaj7 | 1. G7 | 2. G7#5 |

``parse_song`` reads it (fatal problems raise ``ChartError``; a chord symbol
the theory kernel cannot read is only a ``Problem`` — it stays in the file and
the drills skip it), ``format_song`` writes it back, and the functions below
derive the play order, the phrases (one per written line), the run-through
steps and the distinct chords under the song's grading dial.

Layer: learning. Imports theory only — no I/O, no clock.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from music.theory.chords import ChordSymbol, hint_voicing, parse_chord
from music.theory.simplify import DIALS, simplify

HEADER_ORDER: tuple[str, ...] = (
    "title", "composer", "style", "time", "key", "tempo", "form", "grade", "source", "checked",
)
NO_CHORD: frozenset[str] = frozenset({"N.C.", "N.C", "NC", "-"})

_HEADER_RE = re.compile(r"^([A-Za-z][\w-]*)\s*:\s*(.*)$")
_SECTION_RE = re.compile(r"^\[\s*(.*?)\s*\]$")
_LABEL_RE = re.compile(r"^[A-Za-z0-9'_\-]{1,16}$")
_VOLTA_RE = re.compile(r"^(\d)\.\s*(.*)$")
_BEATS_RE = re.compile(r"^(.+):(\d+(?:\.\d+)?)$")
_TIME_RE = re.compile(r"^(\d{1,2})/(\d{1,2})$")


class ChartError(ValueError):
    """The text is not a song; ``errors`` lists every fatal problem, line-numbered."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


@dataclass(frozen=True)
class Problem:
    addr: str        # "A.4.5", or "" for the song as a whole
    message: str


@dataclass(frozen=True)
class Slot:
    symbol: str      # as written; "" = no chord
    beats: float


@dataclass(frozen=True)
class Bar:
    slots: tuple[Slot, ...]
    volta: int | None = None
    repeat: bool = False    # written "%": slots copy the previous bar
    hold: bool = False      # written empty: the previous chord holds


@dataclass(frozen=True)
class Line:
    bars: tuple[Bar, ...]


@dataclass(frozen=True)
class Section:
    label: str
    lines: tuple[Line, ...]


@dataclass
class Song:
    title: str
    sections: tuple[Section, ...]
    composer: str = ""
    style: str = ""
    time: str = "4/4"
    key: str = ""
    tempo: int | None = None
    form: tuple[str, ...] = ()
    grade: str = "core"
    source: str = ""
    checked: str = ""
    extra: dict[str, str] = field(default_factory=dict)

    @property
    def beats_per_bar(self) -> int:
        m = _TIME_RE.match(self.time)
        return int(m.group(1)) if m else 4

    @property
    def play_form(self) -> tuple[str, ...]:
        """The form as played: the ``form`` header, or every section once."""
        return self.form or tuple(s.label for s in self.sections)

    def section(self, label: str) -> Section | None:
        return next((s for s in self.sections if s.label == label), None)


# ── parsing ──────────────────────────────────────────────────────────────────
def _num(text: str) -> float:
    value = float(text)
    return int(value) if value.is_integer() else value


def _parse_cell(cell: str, beats_per_bar: int, prev: Bar | None, addr: str,
                problems: list[Problem]) -> Bar:
    volta = None
    m = _VOLTA_RE.match(cell)
    if m:
        volta, cell = int(m.group(1)), m.group(2).strip()
    if cell == "%":
        if prev is None:
            problems.append(Problem(addr, "% with no bar before it"))
            return Bar(slots=(Slot("", beats_per_bar),), volta=volta, repeat=True)
        return Bar(slots=prev.slots, volta=volta, repeat=True)
    if cell == "":
        held = prev.slots[-1].symbol if prev is not None else ""
        return Bar(slots=(Slot(held, beats_per_bar),), volta=volta, hold=True)
    symbols: list[str] = []
    fixed: list[float | None] = []
    for token in cell.split():
        bm = _BEATS_RE.match(token)
        symbol, beats = (bm.group(1), _num(bm.group(2))) if bm else (token, None)
        symbols.append("" if symbol in NO_CHORD else symbol)
        fixed.append(beats)
    given = sum(b for b in fixed if b is not None)
    free = [i for i, b in enumerate(fixed) if b is None]
    if free:
        share = (beats_per_bar - given) / len(free)
        if share <= 0:
            problems.append(Problem(addr, f"the beats add up past {beats_per_bar}"))
            share = beats_per_bar / len(symbols)
            fixed = [None] * len(fixed)
            free = list(range(len(fixed)))
        for i in free:
            fixed[i] = _num(f"{share:.4f}")
    elif abs(given - beats_per_bar) > 1e-6:
        problems.append(Problem(addr, f"the beats add up to {_num(str(given))}, "
                                      f"a bar of {beats_per_bar}/x has {beats_per_bar}"))
    return Bar(slots=tuple(Slot(s, b) for s, b in zip(symbols, fixed)), volta=volta)


def _cells(text: str) -> list[str]:
    cells = [c.strip() for c in text.split("|")]
    if cells and cells[0] == "":
        cells = cells[1:]
    if cells and cells[-1] == "":
        cells = cells[:-1]
    return cells


def parse_song(text: str) -> tuple[Song, list[Problem]]:
    """Song text v1 → (Song, problems). Raises ChartError when it is not a song."""
    errors: list[str] = []
    problems: list[Problem] = []
    header: dict[str, str] = {}
    sections: list[tuple[str, list[list[str]]]] = []      # (label, raw cell lines)
    started = False
    for n, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _SECTION_RE.match(line)
        if m:
            label = m.group(1)
            if not _LABEL_RE.match(label):
                errors.append(f"line {n}: section label {label!r} — use letters/digits, no spaces")
            elif any(lbl == label for lbl, _ in sections):
                errors.append(f"line {n}: section [{label}] appears twice — rename one (A2, B2…)")
            sections.append((label, []))
            started = True
            continue
        hm = _HEADER_RE.match(line)
        # A known key is a header even when its value holds a "|" (a URL can);
        # "Cm:2 | G7" is a bar line that only looks like one.
        if hm and not started and (hm.group(1).lower() in HEADER_ORDER or "|" not in line):
            key = hm.group(1).lower()
            if key in header:
                errors.append(f"line {n}: {key!r} is set twice")
            header[key] = hm.group(2).strip()
            continue
        if "|" in line:
            if not sections:
                sections.append(("A", []))            # a chart with no rehearsal marks
            sections[-1][1].append(_cells(line))
            started = True
            continue
        if hm:
            errors.append(f"line {n}: header lines ({hm.group(1)}: …) go above the first section")
        else:
            errors.append(f"line {n}: cannot read {line[:40]!r} — bars need | between them")

    title = header.pop("title", "").strip()
    if not title:
        errors.append("the song needs a title: line")
    time = header.pop("time", "4/4") or "4/4"
    if not _TIME_RE.match(time):
        problems.append(Problem("", f"time {time!r} is not like 4/4 — using 4/4"))
        time = "4/4"
    beats_per_bar = int(_TIME_RE.match(time).group(1))
    grade = header.pop("grade", "core") or "core"
    if grade not in DIALS:
        problems.append(Problem("", f"grade {grade!r} is not one of {', '.join(DIALS)} — using core"))
        grade = "core"
    tempo_text = header.pop("tempo", "")
    tempo = None
    if tempo_text:
        try:
            tempo = int(float(tempo_text))
        except ValueError:
            problems.append(Problem("", f"tempo {tempo_text!r} is not a number"))
    form = tuple(t for t in re.split(r"[\s,]+", header.pop("form", "")) if t)
    labels = {label for label, _ in sections}
    for label in form:
        if label not in labels:
            errors.append(f"form names [{label}], which is not in the chart")
    if not any(rows for _, rows in sections):
        errors.append("the song has no bars")
    if errors:
        raise ChartError(errors)

    built: list[Section] = []
    prev: Bar | None = None
    for label, rows in sections:
        lines: list[Line] = []
        for li, cells in enumerate(rows, start=1):
            bars: list[Bar] = []
            for bi, cell in enumerate(cells, start=1):
                addr = f"{label}.{li}.{bi}"
                bar = _parse_cell(cell, beats_per_bar, prev, addr, problems)
                for slot in bar.slots:
                    if slot.symbol and not bar.repeat and not bar.hold:
                        try:
                            parse_chord(slot.symbol)
                        except ValueError as e:
                            problems.append(Problem(addr, str(e)))
                bars.append(bar)
                prev = bar
            lines.append(Line(tuple(bars)))
        built.append(Section(label, tuple(lines)))

    for label, _rows in sections:
        if form and label not in form:
            problems.append(Problem("", f"[{label}] is not in the form, so it is never played"))
    song = Song(
        title=title, sections=tuple(built), composer=header.pop("composer", ""),
        style=header.pop("style", ""), time=time, key=header.pop("key", ""), tempo=tempo,
        form=form, grade=grade, source=header.pop("source", ""),
        checked=header.pop("checked", ""), extra=dict(header),
    )
    return song, problems


# ── formatting ───────────────────────────────────────────────────────────────
def _beats_text(beats: float) -> str:
    return str(_num(f"{beats:.4f}"))


def format_cell(bar: Bar, beats_per_bar: int) -> str:
    """One bar as the text format writes it: ``1. G7`` · ``D-7:2 E-7:1`` · ``%`` · ``N.C.``."""
    prefix = f"{bar.volta}. " if bar.volta else ""
    if bar.repeat:
        return prefix + "%"
    if bar.hold:
        return prefix.strip()
    even = all(abs(s.beats - beats_per_bar / len(bar.slots)) < 1e-3 for s in bar.slots)
    tokens = []
    for slot in bar.slots:
        token = slot.symbol or "N.C."
        if not even:
            token += ":" + _beats_text(slot.beats)
        tokens.append(token)
    return prefix + " ".join(tokens)


def format_song(song: Song) -> str:
    """Song → song text v1. Cells line up by column within each section."""
    values = {
        "title": song.title, "composer": song.composer, "style": song.style, "time": song.time,
        "key": song.key, "tempo": "" if song.tempo is None else str(song.tempo),
        "form": " ".join(song.form), "grade": song.grade, "source": song.source,
        "checked": song.checked,
    }
    out = [f"{key}: {values[key]}" for key in HEADER_ORDER
           if values[key] or key in ("title", "time", "grade")]
    out += [f"{key}: {value}" for key, value in song.extra.items()]
    for section in song.sections:
        out.append("")
        out.append(f"[{section.label}]")
        rows = [[format_cell(bar, song.beats_per_bar) for bar in line.bars] for line in section.lines]
        widths: dict[int, int] = {}
        for row in rows:
            for i, cell in enumerate(row):
                widths[i] = max(widths.get(i, 0), len(cell))
        for row in rows:
            padded = [cell.ljust(widths[i]) for i, cell in enumerate(row)]
            out.append(("| " + " | ".join(padded) + " |").rstrip())
    return "\n".join(out) + "\n"


def replace_cell(song: Song, addr: str, cell: str) -> Song:
    """A copy of ``song`` with one written bar's cell replaced (the text is re-read).

    Raises KeyError for an unknown address and ChartError if the new text breaks
    the song — the caller re-parses the formatted result anyway.
    """
    label, line_no, bar_no = _split_addr(addr)
    section = song.section(label)
    if section is None or not 1 <= line_no <= len(section.lines):
        raise KeyError(addr)
    line = section.lines[line_no - 1]
    if not 1 <= bar_no <= len(line.bars):
        raise KeyError(addr)
    probe, _ = parse_song(f"title: x\ntime: {song.time}\n[X]\n| {cell.strip() or ' '} |\n")
    new_bar = probe.sections[0].lines[0].bars[0] if cell.strip() else Bar(
        slots=line.bars[bar_no - 1].slots, hold=True)
    bars = list(line.bars)
    bars[bar_no - 1] = new_bar
    lines = list(section.lines)
    lines[line_no - 1] = Line(tuple(bars))
    sections = tuple(Section(s.label, tuple(lines)) if s.label == label else s
                     for s in song.sections)
    return Song(**{**song.__dict__, "sections": sections})


def _split_addr(addr: str) -> tuple[str, int, int]:
    try:
        label, line_no, bar_no = addr.rsplit(".", 2)
        return label, int(line_no), int(bar_no)
    except ValueError:
        raise KeyError(addr) from None


# ── what practice derives from it ────────────────────────────────────────────
@dataclass(frozen=True)
class PlayBar:
    n: int                 # 1-based position in play order
    addr: str
    section: str
    passno: int            # which time through this section (1-based)
    bar: Bar


@dataclass(frozen=True)
class Step:
    play: ChordSymbol      # the dial's target
    symbol: str            # as written
    addr: str              # first written slot this step covers
    slot: int
    n: int = 0             # play-order bar (runs only)


@dataclass(frozen=True)
class Phrase:
    id: str                # "A2", or "A4.1" when a line's endings differ
    section: str
    line: int
    volta: int | None
    name: str              # "A line 2", "A line 4 · 1st ending"
    steps: tuple[Step, ...]
    cue: ChordSymbol | None
    addrs: tuple[str, ...]


def ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _volta_for(section: Section, passno: int) -> int | None:
    voltas = sorted({b.volta for line in section.lines for b in line.bars if b.volta})
    if not voltas:
        return None
    return passno if passno in voltas else voltas[-1]


def written_bars(song: Song) -> list[tuple[str, Bar]]:
    """Every written bar with its address, in written order."""
    return [(f"{s.label}.{li}.{bi}", bar)
            for s in song.sections
            for li, line in enumerate(s.lines, start=1)
            for bi, bar in enumerate(line.bars, start=1)]


def play_bars(song: Song) -> list[PlayBar]:
    """The bars in the order they are played: the form, with each pass's ending."""
    out: list[PlayBar] = []
    passes: dict[str, int] = {}
    for label in song.play_form:
        section = song.section(label)
        if section is None:
            continue
        passes[label] = passes.get(label, 0) + 1
        volta = _volta_for(section, passes[label])
        for li, line in enumerate(section.lines, start=1):
            for bi, bar in enumerate(line.bars, start=1):
                if bar.volta is None or bar.volta == volta:
                    out.append(PlayBar(len(out) + 1, f"{label}.{li}.{bi}", label,
                                       passes[label], bar))
    return out


def target(symbol: str, dial: str) -> ChordSymbol | None:
    """What a written symbol asks you to play under ``dial`` (None: rest or unreadable)."""
    if not symbol:
        return None
    try:
        return simplify(parse_chord(symbol), dial)
    except ValueError:
        return None


def _same(a: ChordSymbol, b: ChordSymbol) -> bool:
    return a.root_pc == b.root_pc and a.intervals == b.intervals


def _steps(bars: list[tuple[str, Bar, int]], dial: str) -> list[Step]:
    """Flatten (addr, bar, n) into steps; rests skipped, repeats of one chord merged."""
    steps: list[Step] = []
    for addr, bar, n in bars:
        for i, slot in enumerate(bar.slots):
            chord = target(slot.symbol, dial)
            if chord is None:
                continue
            if steps and _same(steps[-1].play, chord):
                continue
            steps.append(Step(chord, slot.symbol, addr, i, n))
    return steps


def run_steps(song: Song, label: str | None = None) -> list[Step]:
    """The whole form in play order, or one section's first pass on its own."""
    if label is None:
        return _steps([(pb.addr, pb.bar, pb.n) for pb in play_bars(song)], song.grade)
    first = [pb for pb in play_bars(song) if pb.section == label and pb.passno == 1]
    if first:
        return _steps([(pb.addr, pb.bar, pb.n) for pb in first], song.grade)
    section = song.section(label)
    if section is None:
        return []
    volta = _volta_for(section, 1)
    return _steps([(f"{label}.{li}.{bi}", bar, 0)
                   for li, line in enumerate(section.lines, start=1)
                   for bi, bar in enumerate(line.bars, start=1)
                   if bar.volta is None or bar.volta == volta], song.grade)


def _cue(song: Song, first_addr: str, volta: int | None) -> ChordSymbol | None:
    """The chord played just before ``first_addr`` is first reached (on ``volta``'s pass)."""
    bars = play_bars(song)
    for i, pb in enumerate(bars):
        if pb.addr != first_addr:
            continue
        section = song.section(pb.section)
        if volta is not None and _volta_for(section, pb.passno) != volta:
            continue
        for prev in reversed(bars[:i]):
            for slot in reversed(prev.bar.slots):
                chord = target(slot.symbol, song.grade)
                if chord is not None:
                    return chord
        return None
    return None


def phrases(song: Song) -> list[Phrase]:
    """One phrase per written line; a line whose endings differ splits per ending."""
    out: list[Phrase] = []
    for section in song.sections:
        for li, line in enumerate(section.lines, start=1):
            addressed = [(f"{section.label}.{li}.{bi}", bar)
                         for bi, bar in enumerate(line.bars, start=1)]
            voltas = sorted({bar.volta for _, bar in addressed if bar.volta})
            variants: list[tuple[int | None, list[Step], tuple[str, ...]]] = []
            for volta in voltas or [None]:
                chosen = [(addr, bar, 0) for addr, bar in addressed
                          if bar.volta is None or bar.volta == volta]
                variants.append((volta, _steps(chosen, song.grade),
                                 tuple(addr for addr, _, _ in chosen)))
            texts = {tuple(s.play.text for s in steps) for _, steps, _ in variants}
            if len(variants) > 1 and len(texts) == 1:
                variants = [(None, variants[0][1], variants[0][2])]
            for volta, steps, addrs in variants:
                if not steps:
                    continue
                pid = f"{section.label}{li}" + (f".{volta}" if volta else "")
                name = f"{section.label} line {li}" + (f" · {ordinal(volta)} ending" if volta else "")
                cue = _cue(song, addrs[0], volta)
                out.append(Phrase(pid, section.label, li, volta, name, tuple(steps), cue, addrs))
    return out


def distinct_chords(song: Song) -> list[tuple[ChordSymbol, list[str]]]:
    """The dial targets in first-appearance order, each with its written spellings."""
    out: list[tuple[ChordSymbol, list[str]]] = []
    for _addr, bar in written_bars(song):
        for slot in bar.slots:
            chord = target(slot.symbol, song.grade)
            if chord is None:
                continue
            for known, symbols in out:
                if _same(known, chord):
                    if slot.symbol not in symbols:
                        symbols.append(slot.symbol)
                    break
            else:
                out.append((chord, [slot.symbol]))
    return out


# ── presentation helpers ─────────────────────────────────────────────────────
_FLAT_RE = re.compile(r"(?<=[A-G])b|b(?=\d)")


def pretty(text: str) -> str:
    """'Bb7(#11)' → 'B♭7(♯11)' — for Anki cards and prompts, never for parsing."""
    return _FLAT_RE.sub("♭", text).replace("#", "♯")


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "song"


def voicing(chord: ChordSymbol) -> list[int]:
    """The key hint for a chart chord — theory's one hint voicing (the trainer lights the same)."""
    return hint_voicing(chord)


def step_dict(step: Step, with_n: bool = False) -> dict:
    d = {"play": step.play.text, "symbol": step.symbol, "addr": step.addr, "slot": step.slot,
         "notes": voicing(step.play)}
    if with_n:
        d["n"] = step.n
    return d


def song_dict(song: Song, problems: list[Problem]) -> dict:
    """The chart half of song JSON v1 (the store adds id, page, flags, decks …)."""
    sections = []
    for section in song.sections:
        lines = []
        for li, line in enumerate(section.lines, start=1):
            bars = []
            for bi, bar in enumerate(line.bars, start=1):
                slots = []
                for slot in bar.slots:
                    chord = target(slot.symbol, song.grade)
                    ok = True
                    if slot.symbol:
                        try:
                            parse_chord(slot.symbol)
                        except ValueError:
                            ok = False
                    slots.append({"symbol": slot.symbol, "beats": slot.beats,
                                  "play": chord.text if chord else None, "ok": ok})
                bars.append({"addr": f"{section.label}.{li}.{bi}", "volta": bar.volta,
                             "repeat": bar.repeat, "text": format_cell(bar, song.beats_per_bar),
                             "slots": slots})
            lines.append({"n": li, "bars": bars})
        sections.append({"label": section.label, "lines": lines})
    phrase_list = []
    for p in phrases(song):
        phrase_list.append({
            "id": p.id, "section": p.section, "line": p.line, "volta": p.volta, "name": p.name,
            "front": phrase_front(song, p), "back": phrase_back(p),
            "cue": p.cue.text if p.cue else None,
            "steps": [step_dict(s) for s in p.steps],
        })
    runs = {"all": [step_dict(s, True) for s in run_steps(song)]}
    for section in song.sections:
        runs[section.label] = [step_dict(s, True) for s in run_steps(song, section.label)]
    return {
        "title": song.title, "composer": song.composer, "style": song.style,
        "time": song.time, "beats_per_bar": song.beats_per_bar, "key": song.key,
        "tempo": song.tempo, "form": list(song.play_form), "grade": song.grade,
        "checked": song.checked, "source": song.source,
        "sections": sections,
        "play": [{"n": pb.n, "addr": pb.addr, "section": pb.section, "pass": pb.passno}
                 for pb in play_bars(song)],
        "phrases": phrase_list,
        "chords": [{"play": c.text, "symbols": s, "notes": voicing(c)}
                   for c, s in distinct_chords(song)],
        "runs": runs,
        "problems": [{"addr": p.addr, "message": p.message} for p in problems],
    }


# ── the Anki face of a phrase ────────────────────────────────────────────────
_FRONT_RE = re.compile(r"^(?P<title>.+?) · (?P<label>[A-Za-z0-9'_\-]{1,16}) line (?P<line>\d+)"
                       r"(?: · (?P<volta>\d+)(?:st|nd|rd|th) ending)?(?:\s*\(.*\))?\s*$")


def phrase_front(song: Song, phrase: Phrase) -> str:
    """'Very Early · A line 2 (after A♭7)' — the cue is decoration, the rest is the key."""
    cue = f"after {pretty(phrase.cue.text)}" if phrase.cue else "start"
    return f"{song.title} · {phrase.name} ({cue})"


def phrase_back(phrase: Phrase) -> str:
    return " · ".join(pretty(s.play.text) for s in phrase.steps)


def parse_front(text: str) -> tuple[str, str, int, int | None] | None:
    """A phrase Front → (title, section, line, volta); None if it is not one."""
    m = _FRONT_RE.match(text.strip())
    if not m:
        return None
    volta = int(m.group("volta")) if m.group("volta") else None
    return m.group("title"), m.group("label"), int(m.group("line")), volta
