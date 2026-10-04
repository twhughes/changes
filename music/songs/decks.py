"""Song decks — the trainer's deck source for the songs library (CONTRACTS.md §9).

The trainer knows nothing about songs: ``web/server.py`` registers a
``SongDecks`` with ``TrainerService.add_deck_source``, and from then on the
trainer can start ``song:<id>:chords|phrases|run[:<label>]`` decks and decode
song phrase cards out of Anki like its own.

Three practice modes, all graded loose on the song's dial targets:

* **chords**  — the distinct targets, shuffled, one card each (hands).
* **phrases** — one card per written line, the chords hidden (recall), cued by
  the chord before it (head; the part the review scheduler keeps, §10).
* **play**    — Play through: the whole form, or one section, in song order with
  the chords shown — flashcards in song order (flow). ``run`` is its old name.
"""

from __future__ import annotations

from music.learn.anki import DEFAULT_DECK
from music.learn.drill import DrillItem
from music.songs.chart import (
    ChartError,
    Phrase,
    Song,
    distinct_chords,
    parse_front,
    phrase_back,
    phrase_front,
    phrases,
    pretty,
    run_steps,
    slugify,
)
from music.songs.store import SongStore
from music.srs import CardSpec
from music.theory.match import Level

PREFIX = "song:"
MODES: tuple[str, ...] = ("chords", "phrases", "play")
PLAY_MODES: frozenset[str] = frozenset({"play", "run"})    # "run" = the v1 name


def deck_name(song_id: str, mode: str, label: str | None = None) -> str:
    return f"{PREFIX}{song_id}:{mode}" + (f":{label}" if label else "")


def theme(song_id: str) -> str:
    """The Anki theme key: the trainer offers ``anki:song:<id>``."""
    return f"{PREFIX}{song_id}"


def anki_subdeck(title: str) -> str:
    """``Music::PianoChords::Songs::Very Early`` — "::" inside a title would nest it."""
    safe = title.replace("::", " - ").replace('"', "'").strip() or "Untitled"
    return f"{DEFAULT_DECK}::Songs::{safe}"


def deck_names_for(song_id: str, song: Song) -> dict:
    """The ``decks`` block of song JSON v1."""
    return {
        "chords": deck_name(song_id, "chords"),
        "phrases": deck_name(song_id, "phrases"),
        "play": deck_name(song_id, "play"),
        "sections": {s.label: deck_name(song_id, "play", s.label) for s in song.sections},
    }


# ── items ────────────────────────────────────────────────────────────────────
def chord_items(song_id: str, song: Song) -> list[DrillItem]:
    items = []
    for chord, _symbols in distinct_chords(song):
        items.append(DrillItem(prompt=f"Play {pretty(chord.text)} — any voicing", chord=chord,
                               level=Level.LOOSE, ref=f"{PREFIX}{song_id}:chord:{chord.text}"))
    return items


def phrase_item(song_id: str, song: Song, phrase: Phrase) -> DrillItem:
    cue = f"after {pretty(phrase.cue.text)}" if phrase.cue else "from the top"
    count = len(phrase.steps)
    chords = tuple(s.play for s in phrase.steps)
    return DrillItem(
        prompt=f"{song.title} · {phrase.name} — {cue} · {count} chord{'s' if count != 1 else ''}",
        chord=chords[0], chords=chords, level=Level.LOOSE, recall=True,
        ref=f"{PREFIX}{song_id}:phrase:{phrase.id}",
    )


def phrase_items(song_id: str, song: Song) -> list[DrillItem]:
    return [phrase_item(song_id, song, p) for p in phrases(song)]


def play_item(song_id: str, song: Song, label: str | None = None) -> DrillItem | None:
    """Play through: the song's chords in order, shown — one card, never requeued."""
    steps = run_steps(song, label)
    if not steps:
        return None
    chords = tuple(s.play for s in steps)
    where = f"{song.title} · {label}" if label else song.title
    return DrillItem(prompt=f"{where} — play through · {len(chords)} chords",
                     chord=chords[0], chords=chords, level=Level.LOOSE,
                     ref=f"{PREFIX}{song_id}:play" + (f":{label}" if label else ""))


class SongDecks:
    """The deck source (duck-typed; see TrainerService.add_deck_source)."""

    def __init__(self, store: SongStore) -> None:
        self.store = store

    def _songs(self) -> list[tuple[str, Song]]:
        out = []
        for song_id in self.store.ids():
            try:
                song, _ = self.store.load(song_id)
            except (KeyError, ChartError, OSError):
                continue                    # a broken file must not hide the others
            out.append((song_id, song))
        return out

    def _song(self, song_id: str) -> Song | None:
        try:
            return self.store.load(song_id)[0]
        except (KeyError, ChartError, OSError):
            return None

    # ── the seam ──────────────────────────────────────────────────────────
    def deck_names(self) -> list[str]:
        names = []
        for song_id, song in self._songs():
            names += [deck_name(song_id, mode) for mode in MODES]
            names += [deck_name(song_id, "play", s.label) for s in song.sections]
        return names

    def deck(self, name: str) -> tuple[list[DrillItem], bool] | None:
        """(items, requeue misses) for a song deck name; None if it is not ours."""
        if not name.startswith(PREFIX):
            return None
        parts = name[len(PREFIX):].split(":")
        if len(parts) < 2:
            return None
        song_id, mode, label = parts[0], parts[1], (parts[2] if len(parts) > 2 else None)
        song = self._song(song_id)
        if song is None:
            return None
        if mode == "chords" and label is None:
            return chord_items(song_id, song), True
        if mode == "phrases" and label is None:
            return phrase_items(song_id, song), True
        if mode in PLAY_MODES:
            if label is not None and song.section(label) is None:
                return None
            item = play_item(song_id, song, label)
            return ([item] if item else []), False
        return None

    def item_for_front(self, text: str) -> DrillItem | None:
        """Decode a song phrase card ("Very Early · A line 2 (after A♭7)")."""
        parsed = parse_front(text)
        if parsed is None:
            return None
        title, label, line, volta = parsed
        for song_id, song in self._songs():
            if song.title.strip().lower() != title.strip().lower() and \
                    slugify(song.title) != slugify(title):
                continue
            candidates = [p for p in phrases(song) if p.section == label and p.line == line]
            if not candidates:
                return None
            exact = [p for p in candidates if p.volta == volta]
            chosen = exact[0] if exact else candidates[0]
            return phrase_item(song_id, song, chosen)
        return None

    def anki_themes(self) -> dict[str, str]:
        return {theme(song_id): anki_subdeck(song.title) for song_id, song in self._songs()}

    def fill(self, theme_name: str) -> list[DrillItem]:
        """Phrase cards to top up a short ``anki:song:<id>`` session."""
        if not theme_name.startswith(PREFIX):
            return []
        song = self._song(theme_name[len(PREFIX):])
        return phrase_items(theme_name[len(PREFIX):], song) if song is not None else []


# ── review cards (CONTRACTS.md §10) ─────────────────────────────────────────
def phrase_key(front: str) -> str:
    """A phrase card's identity: title + line + ending. The cue may change; this does not."""
    parsed = parse_front(front)
    if parsed is None:
        return front
    title, label, line, volta = parsed
    return f"{title.strip().lower()}|{label}|{line}|{volta or ''}"


def phrase_specs(song: Song) -> list[CardSpec]:
    """The song's phrase cards for the review scheduler (Fronts decode via SongDecks)."""
    specs = []
    for phrase in phrases(song):
        front = phrase_front(song, phrase)
        specs.append(CardSpec(phrase_key(front), front, phrase_back(phrase)))
    return specs
