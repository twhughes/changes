"""Built-in decks (Anki-free), the miss-requeue policy, and the Anki Front
codec — every drillable unit round-trips through a one-line card Front:

    "G7"            → any-voicing chord        "G7 shell"   → strict shell
    "C7/E"          → inversion (bass first)   "ii–V–I in Ab" → progression
"""

from __future__ import annotations

import random
import re

from music.learn.drill import DrillItem
from music.learn.reading import item_for_pitch_front, reading_decks, reading_fronts
from music.theory.chords import parse_chord
from music.theory.match import Level
from music.theory.pitch import parse_note, pc_name
from music.theory.transpose import transpose

REQUEUE_OFFSET = 3  # a missed card comes back 3 cards later

# Progression shapes by label — the one place a label maps to chords. Fronts
# like "ii–V–I in Ab" decode through this; new shapes (Coltrane changes…)
# are one more row.
PROGRESSIONS: dict[str, tuple[str, ...]] = {
    "ii–V–I": ("Dm7", "G7", "Cmaj7"),
    "ii–V–i": ("Dm7b5", "G7", "Cm7"),            # minor: the half-diminished ii
    "I–vi–ii–V": ("Cmaj7", "Am7", "Dm7", "G7"),   # the turnaround
    "ii–♭II7–I": ("Dm7", "Db7", "Cmaj7"),          # tritone sub: D♭7 stands in for G7
    "iv–♭VII7–I": ("Fm7", "Bb7", "Cmaj7"),        # the backdoor: home from a step below
    "IV–V–I": ("F", "G", "C"),                    # off the menu (2026-10-04); still decodes
}
# Which chord names the key ("ii–V–I in Ab" = its I). Default: the last chord; a
# turnaround starts on its I and ends on the V.
TONIC: dict[str, int] = {"I–vi–ii–V": 0}

_PROG_RE = re.compile(r"^(?P<label>.+?) in (?P<key>[A-G][b#]?)$")


def _all_keys(quality: str, level: Level, prompt_fmt: str = "Play {} — any voicing") -> list[DrillItem]:
    base = parse_chord("C" + quality)
    items = []
    for n in range(12):
        c = transpose(base, n)
        items.append(DrillItem(prompt=prompt_fmt.format(c.text), chord=c, level=level))
    return items


def _all_keys_of(text: str, level: Level, prompt_fmt: str) -> list[DrillItem]:
    """Like _all_keys but from a full chord text (slash chords included)."""
    base = parse_chord(text)
    items = []
    for n in range(12):
        c = transpose(base, n)
        items.append(DrillItem(prompt=prompt_fmt.format(c.text), chord=c, level=level))
    return items


def _progression_item(label: str, semitones: int,
                      level: Level = Level.LOOSE) -> DrillItem:
    """The atomic card: play the shape's chords in order, transposed up n."""
    bases = [parse_chord(t) for t in PROGRESSIONS[label]]
    cs = tuple(transpose(b, semitones) for b in bases)
    tonic = cs[TONIC.get(label, -1)]
    key = pc_name(tonic.root_pc, tonic.root_pc in (1, 3, 6, 8, 10))
    seq = " → ".join(c.text for c in cs)
    return DrillItem(prompt=f"{label} in {key}: {seq}",
                     chord=cs[0], chords=cs, level=level)


def _progression(label: str, level: Level = Level.LOOSE) -> list[DrillItem]:
    """One atomic item per key; the prompt keys off the I (the last chord)."""
    return [_progression_item(label, n, level) for n in range(12)]


# The Practice menu (CONTRACTS.md §11 v2) — Tyler, 2026-10-04: "just triads and 7ths and
# common progressions, grouped", then "focus on the common ones, especially jazz ones" and
# "a new chord category like 'advanced'" for the jazz chords (diminished, flat five,
# augmented, sus). Only MENU decks are offered; every other built-in deck (shells,
# inversions, jazz-workout, four-five-one, reading-*) still drills by name and still decodes
# from review — it is simply not on the menu.
DECK_GROUPS: tuple[tuple[str, str], ...] = (("chords", "Chords"), ("progressions", "Progressions"))
MENU: tuple[str, ...] = ("triads", "sevenths", "advanced", "two-five-one", "minor-two-five-one",
                         "turnaround", "tritone-sub", "backdoor")
# deck → (group, title, blurb). The blurb says what the deck IS — the chords in C — under
# the title in the pane and as the sidebar tooltip.
DECK_INFO: dict[str, tuple[str, str, str]] = {
    "triads": ("chords", "Triads", "major and minor · all 12 keys"),
    "sevenths": ("chords", "Sevenths", "7, m7 and maj7 · all 12 keys"),
    "advanced": ("chords", "Advanced",
                 "m7♭5 (half-diminished), dim7, 7sus4 and 7♯5 (augmented) · all 12 keys"),
    "two-five-one": ("progressions", "ii–V–I", "in C: Dm7 → G7 → Cmaj7 · all 12 keys"),
    "minor-two-five-one": ("progressions", "Minor ii–V–i",
                           "in C minor: Dm7♭5 → G7 → Cm7 · all 12 keys"),
    "turnaround": ("progressions", "Turnaround",
                   "I–vi–ii–V, in C: Cmaj7 → Am7 → Dm7 → G7 · all 12 keys"),
    "tritone-sub": ("progressions", "Tritone sub",
                    "ii–♭II7–I, in C: Dm7 → D♭7 → Cmaj7 · all 12 keys"),
    "backdoor": ("progressions", "Backdoor",
                 "iv–♭VII7–I, in C: Fm7 → B♭7 → Cmaj7 · all 12 keys"),
}

_SHELL_FMT = "Play {} — shell (root·3·7)"
_INV_FMT = "Play {} — bass note first"


def builtin_decks() -> dict[str, list[DrillItem]]:
    return {
        "triads": _all_keys("", Level.LOOSE) + _all_keys("m", Level.LOOSE),
        "sevenths": _all_keys("7", Level.LOOSE) + _all_keys("m7", Level.LOOSE)
        + _all_keys("maj7", Level.LOOSE),
        # Shells: STRICT means no notes outside the chord; the omittable 5th
        # rule means root·3·7 alone passes. Full four-note chords pass too —
        # the discipline is "nothing extra", the habit is the shell.
        "shells": _all_keys("7", Level.STRICT, _SHELL_FMT)
        + _all_keys("m7", Level.STRICT, _SHELL_FMT)
        + _all_keys("maj7", Level.STRICT, _SHELL_FMT),
        "sevenths-strict": _all_keys("7", Level.STRICT) + _all_keys("m7", Level.STRICT),
        # Inversions: the named bass must be the lowest sounding note.
        # First inversion (3rd in the bass) and third (7th in the bass) — the
        # two that matter for voice-led ii–V–I motion.
        "inversions": _all_keys_of("C7/E", Level.INVERSION, _INV_FMT)
        + _all_keys_of("Cm7/Eb", Level.INVERSION, _INV_FMT)
        + _all_keys_of("Cmaj7/E", Level.INVERSION, _INV_FMT)
        + _all_keys_of("C7/Bb", Level.INVERSION, _INV_FMT)
        + _all_keys_of("Cm7/Bb", Level.INVERSION, _INV_FMT)
        + _all_keys_of("Cmaj7/B", Level.INVERSION, _INV_FMT),
        "jazz-workout": _all_keys("m7b5", Level.LOOSE) + _all_keys("dim7", Level.LOOSE)
        + _all_keys("mMaj7", Level.LOOSE),
        # Advanced (the menu's jazz chords): the altered 5ths and the sus 4th are required
        # (only an unaltered 5th is omittable), so a plain m7 never passes as m7♭5.
        "advanced": _all_keys("m7b5", Level.LOOSE) + _all_keys("dim7", Level.LOOSE)
        + _all_keys("7sus4", Level.LOOSE) + _all_keys("7#5", Level.LOOSE),
        # Progressions: one card = the whole cadence, played chord by chord.
        "two-five-one": _progression("ii–V–I"),
        "minor-two-five-one": _progression("ii–V–i"),
        "turnaround": _progression("I–vi–ii–V"),
        "tritone-sub": _progression("ii–♭II7–I"),
        "backdoor": _progression("iv–♭VII7–I"),
        "four-five-one": _progression("IV–V–I"),
        # Sight reading (M10): pitch-exact items shown on a staff — learn/reading.py.
        **reading_decks(),
    }


# ── the Anki Front codec ────────────────────────────────────────────────────
def seed_fronts(deck_name: str) -> list[str]:
    """One card Front per item of a built-in deck — what seeding writes to Anki.

    Raises KeyError for an unknown deck. Every Front must decode back through
    ``item_for_front`` — that round-trip is what makes Anki the scheduler
    without Anki knowing any theory.
    """
    items = builtin_decks()[deck_name]
    if deck_name.startswith("reading-"):
        return reading_fronts(deck_name)
    if any(item.chords for item in items):
        # "ii–V–I in Ab: Bbm7 → Eb7 → Abmaj7" → "ii–V–I in Ab"
        return [item.prompt.split(":")[0] for item in items]
    if deck_name == "shells":
        return [f"{item.chord.text} shell" for item in items]
    return [item.chord.text for item in items]


def item_for_front(text: str) -> DrillItem | None:
    """Decode a card Front back into a DrillItem; None if it isn't ours."""
    text = text.strip()
    pitch_item = item_for_pitch_front(text)     # "E4 treble" — a sight-reading card
    if pitch_item is not None:
        return pitch_item
    m = _PROG_RE.match(text)
    if m and m.group("label") in PROGRESSIONS:
        bases = [parse_chord(t) for t in PROGRESSIONS[m.group("label")]]
        n = (parse_note(m.group("key")) - bases[TONIC.get(m.group("label"), -1)].root_pc) % 12
        return _progression_item(m.group("label"), n)
    try:
        if text.endswith(" shell"):
            chord = parse_chord(text[: -len(" shell")].strip())
            return DrillItem(prompt=_SHELL_FMT.format(chord.text), chord=chord,
                             level=Level.STRICT)
        chord = parse_chord(text)
    except ValueError:
        return None
    if chord.bass_pc is not None:
        return DrillItem(prompt=_INV_FMT.format(chord.text), chord=chord,
                         level=Level.INVERSION)
    return DrillItem(prompt=f"Play {chord.text} — any voicing", chord=chord,
                     level=Level.LOOSE)


class DeckRun:
    """Shuffled pass through a deck; items missed on the first attempt requeue."""

    def __init__(self, items: list[DrillItem], shuffle: bool = True,
                 rng: random.Random | None = None) -> None:
        self.queue = list(items)
        if shuffle:
            (rng or random.Random()).shuffle(self.queue)

    def requeue(self, item: DrillItem) -> None:
        pos = min(REQUEUE_OFFSET, len(self.queue))
        self.queue.insert(pos, item)
