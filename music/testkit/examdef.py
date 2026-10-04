"""Exam definition — YAML v1 (CONTRACTS.md §2).

An exam is a list of DrillItems plus defaults; every chord is parsed and every
level validated at load time, so a bad exam fails before the keyboard is touched.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from music.learn.drill import DrillItem
from music.theory.chords import parse_chord
from music.theory.match import Level

EXAM_VERSION = 1
DEFAULT_LEVEL = "loose"
DEFAULT_DEBOUNCE_MS = 300

_LEVELS = tuple(lv.value for lv in Level)


@dataclass(frozen=True)
class Exam:
    id: str
    title: str
    defaults: dict
    items: list[DrillItem]
    source: Path | None = field(default=None, compare=False)  # for exam_sha in session.json

    @property
    def sha(self) -> str:
        return exam_sha(self.source) if self.source else ""


def exam_sha(path: str | Path) -> str:
    """sha256 of the exam file's bytes, first 16 hex (pinned into session.json)."""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]


def load_exam(path: str | Path) -> Exam:
    """Parse + validate an exam YAML. Raises ValueError with the offending item."""
    path = Path(path)
    try:
        raw = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        raise ValueError(f"{path}: not valid YAML — {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: top level must be a mapping (id/title/defaults/items)")

    exam_id = raw.get("id")
    if not exam_id or not isinstance(exam_id, str):
        raise ValueError(f"{path}: missing required string field 'id'")
    title = raw.get("title") or exam_id

    defaults = raw.get("defaults") or {}
    if not isinstance(defaults, dict):
        raise ValueError(f"{path}: 'defaults' must be a mapping, got {type(defaults).__name__}")
    d_level = _level(defaults.get("level", DEFAULT_LEVEL), f"{path}: defaults")
    d_debounce = _debounce(defaults.get("debounce_ms", DEFAULT_DEBOUNCE_MS), f"{path}: defaults")

    raw_items = raw.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError(f"{path}: 'items' must be a non-empty list")

    items: list[DrillItem] = []
    for i, entry in enumerate(raw_items):
        where = f"{path}: item {i + 1}"
        if not isinstance(entry, dict):
            raise ValueError(f"{where}: must be a mapping with 'prompt' and 'check'")
        check = entry.get("check")
        if not isinstance(check, dict) or "chord" not in check:
            raise ValueError(f"{where}: 'check' must be a mapping containing 'chord'")
        chord_text = check["chord"]
        try:
            chord = parse_chord(str(chord_text))
        except ValueError as exc:
            raise ValueError(f"{where}: bad chord {chord_text!r} — {exc}") from exc
        level = _level(check.get("level", d_level.value), where)
        debounce_ms = _debounce(check.get("debounce_ms", d_debounce), where)
        prompt = entry.get("prompt") or f"Play {chord.text}"
        items.append(DrillItem(prompt=str(prompt), chord=chord, level=level,
                               debounce_s=debounce_ms / 1000.0))

    return Exam(id=exam_id, title=str(title),
                defaults={"level": d_level.value, "debounce_ms": d_debounce},
                items=items, source=path)


def _level(value, where: str) -> Level:
    try:
        return Level(str(value))
    except ValueError as exc:
        raise ValueError(
            f"{where}: unknown level {value!r} — expected one of {', '.join(_LEVELS)}"
        ) from exc


def _debounce(value, where: str) -> int:
    try:
        ms = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{where}: debounce_ms must be an integer, got {value!r}") from exc
    if ms < 0:
        raise ValueError(f"{where}: debounce_ms must be >= 0, got {ms}")
    return ms
