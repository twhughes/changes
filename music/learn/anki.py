"""AnkiConnect client — the optional Anki bridge (CONTRACTS.md §7).

**Vendored twin of the HQ Anki seam.** The canonical home is ``hq/ankiio.py``
(srs.cards v1 — ARCHITECTURE.md §5.3); this is a deliberate standalone copy, NOT
an import, because music/ stays self-contained per CONTRACTS.md (same policy as
the vendored ``s1.json``). Keep the JSON-RPC request shape in lockstep with the
seam's ``connect`` backend (the v6 ``{action, version, params}`` envelope,
``addNote``/``findCards``/``cardsInfo``/``answerCards`` actions). One divergence is
INTENTIONAL and must not be "fixed" toward the seam: every call here swallows
failure to ``None``/``False``/``[]`` and never raises, because the trainer must
behave *identically* when Anki isn't there (M3's rule: Anki closed → Anki is never
mentioned) — where ``hq/ankiio.py`` raises ``AnkiError``, this returns absence.

The AnkiConnect add-on (2055492159) serves JSON-RPC over HTTP on Anki's fixed
port 8765: ``POST {"action": ..., "version": 6, "params": {...}}`` →
``{"result": ..., "error": null}``.

Every call here is best-effort. Anki closed, add-on missing, add-on too old,
socket hung — all of it comes back as ``None``/``False``/``[]``, never an
exception, because the trainer must behave *identically* when Anki isn't there
(M3's rule: Anki closed → Anki is never mentioned).

``transport`` is the whole network seam: a callable ``(payload) -> response``.
Tests inject a scripted one; production gets urllib over localhost.
"""

from __future__ import annotations

import html
import json
import re
import urllib.request
from typing import Callable

from music.learn.decks import seed_fronts

ANKI_URL = "http://127.0.0.1:8765"
ANKI_API_VERSION = 6
TIMEOUT_S = 1.5           # local add-on: slow means hung, not busy
DEFAULT_DECK = "Music::PianoChords"   # Tyler's real deck (nested under Music)
NOTE_MODEL = "Basic"      # Front = chord symbol, Back = "" (the drill is the answer)
SEED_TAG = "piano-chords"

# Built-in deck → its Anki subdeck under the parent. Seeding writes here and
# themed sessions ("anki:two-five-one") filter due cards by these paths.
# sevenths-strict is deliberately absent: cram-only, redundant with shells.
SUBDECKS: dict[str, str] = {
    "triads": f"{DEFAULT_DECK}::Triads",
    "sevenths": f"{DEFAULT_DECK}::Sevenths",
    "shells": f"{DEFAULT_DECK}::Shells",
    "inversions": f"{DEFAULT_DECK}::Inversions",
    "jazz-workout": f"{DEFAULT_DECK}::Jazz",
    "two-five-one": f"{DEFAULT_DECK}::TwoFiveOne",
    "minor-two-five-one": f"{DEFAULT_DECK}::MinorTwoFiveOne",
    "turnaround": f"{DEFAULT_DECK}::Turnaround",
    "tritone-sub": f"{DEFAULT_DECK}::TritoneSub",
    "backdoor": f"{DEFAULT_DECK}::Backdoor",
    "four-five-one": f"{DEFAULT_DECK}::FourFiveOne",
    "advanced": f"{DEFAULT_DECK}::Advanced",
}

_TAG_RE = re.compile(r"<[^>]+>")


def _plain(text: str) -> str:
    """Anki fields are HTML ('<div>G7</div>', '&nbsp;') — the matcher wants 'G7'."""
    return html.unescape(_TAG_RE.sub("", text)).replace("\xa0", " ").strip()


def _urllib_transport(payload: dict) -> dict:
    request = urllib.request.Request(
        ANKI_URL, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:  # noqa: S310 (localhost)
        return json.loads(response.read().decode())


class AnkiClient:
    """Thin AnkiConnect wrapper. Never raises; failure reads as absence."""

    def __init__(self, transport: Callable[[dict], dict] | None = None) -> None:
        self.transport = transport or _urllib_transport

    def _request(self, action: str, params: dict) -> tuple[bool, object | None]:
        """(succeeded, result). Some actions succeed with a null result."""
        payload = {"action": action, "version": ANKI_API_VERSION, "params": params}
        try:
            response = self.transport(payload)
        except Exception:      # socket refused/timed out, garbage body, Anki quitting
            return False, None
        if not isinstance(response, dict) or response.get("error"):
            return False, None  # includes 'unsupported action' on older add-ons
        return True, response.get("result")

    def call(self, action: str, **params) -> object | None:
        """The result of one action, or None if anything at all went wrong."""
        return self._request(action, params)[1]

    # ── deck plumbing ──────────────────────────────────────────────────────
    def available(self) -> bool:
        return self.call("version") is not None

    def ensure_deck(self, name: str = DEFAULT_DECK) -> bool:
        """createDeck is idempotent in Anki — an existing deck returns its id."""
        return self.call("createDeck", deck=name) is not None

    def seed_deck(self, deck_name: str, chords: list[str]) -> int:
        """Add one Basic note per chord symbol; returns how many actually landed.

        Duplicates are refused per-note (that element comes back null), which is
        what makes re-seeding safe.
        """
        if not chords:
            return 0
        notes = [{"deckName": deck_name, "modelName": NOTE_MODEL,
                  "fields": {"Front": chord, "Back": ""},
                  "options": {"allowDuplicate": False}, "tags": [SEED_TAG]}
                 for chord in chords]
        result = self.call("addNotes", notes=notes)
        if not isinstance(result, list):
            return 0
        return sum(1 for note_id in result if note_id)

    def seed_from_builtin(self, builtin: str) -> int:
        """Seed a built-in deck's Fronts into its Anki subdeck (SUBDECKS).

        Raises KeyError for a deck with no subdeck (unknown, or cram-only).
        """
        subdeck = SUBDECKS[builtin]
        if not self.ensure_deck(subdeck):
            return 0
        return self.seed_deck(subdeck, seed_fronts(builtin))

    def add_cards(self, deck_name: str, cards: list[tuple[str, str]],
                  tags: tuple[str, ...] = (SEED_TAG,)) -> int:
        """Add Basic notes with a Back (song phrases); returns how many landed."""
        if not cards:
            return 0
        notes = [{"deckName": deck_name, "modelName": NOTE_MODEL,
                  "fields": {"Front": front, "Back": back},
                  "options": {"allowDuplicate": False}, "tags": list(tags)}
                 for front, back in cards]
        result = self.call("addNotes", notes=notes)
        if not isinstance(result, list):
            return 0
        return sum(1 for note_id in result if note_id)

    def notes_in_deck(self, deck_name: str) -> list[tuple[int, str, str]] | None:
        """[(note id, Front, Back)] as plain text; None when Anki cannot answer."""
        ids = self.call("findNotes", query=f'deck:"{deck_name}"')
        if not isinstance(ids, list):
            return None
        if not ids:
            return []
        infos = self.call("notesInfo", notes=list(ids))
        if not isinstance(infos, list):
            return None
        out = []
        for info in infos:
            if not isinstance(info, dict) or info.get("noteId") is None:
                continue
            fields = info.get("fields") or {}
            front = _plain(str((fields.get("Front") or {}).get("value", "")))
            back = _plain(str((fields.get("Back") or {}).get("value", "")))
            out.append((info["noteId"], front, back))
        return out

    def update_note(self, note_id: int, front: str, back: str) -> bool:
        """Rewrite a note's Front and Back (its scheduling is untouched)."""
        ok, _ = self._request("updateNoteFields",
                              {"note": {"id": note_id, "fields": {"Front": front, "Back": back}}})
        return ok

    # ── review loop ────────────────────────────────────────────────────────
    def due_cards(self, deck_name: str = DEFAULT_DECK) -> list[tuple[int, str, str]]:
        """[(card_id, Front text, card's deck)] for every drillable card.

        Due and new cards both count (a freshly seeded subdeck must drill
        without a pass through the Anki app first). The query spans the parent,
        so subdecks — and any legacy cards still sitting in the parent — ride
        along; the card's own deck name is what themed sessions filter on.
        """
        ids = self.call("findCards", query=f'deck:"{deck_name}" (is:due OR is:new)')
        if not isinstance(ids, list) or not ids:
            return []
        cards = self.call("cardsInfo", cards=list(ids))
        if not isinstance(cards, list):
            return []
        due = []
        for card in cards:
            if not isinstance(card, dict):
                continue
            card_id = card.get("cardId")
            fields = card.get("fields") or {}
            front = fields.get("Front") or {}
            text = _plain(str(front.get("value", "")))
            if card_id is None or not text:
                continue
            due.append((card_id, text, str(card.get("deckName", ""))))
        return due

    def answer(self, card_id: int, ease: int) -> bool:
        """Press an ease button on a card. False if the add-on can't (old version)."""
        result = self.call("answerCards", answers=[{"cardId": card_id, "ease": ease}])
        return bool(result[0]) if isinstance(result, list) and result else False
