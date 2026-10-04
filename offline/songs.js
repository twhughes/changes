// offline/songs.js — the static page's songs library (CONTRACTS.md §9, §12): the twin of
// songs/decks.py SongDecks (the trainer's deck source: chords · phrases · play-through decks,
// phrase cards decoded from their Front), of the read side of songs/service.py (summaries,
// song JSON with its review block, the grading dial, "Add to review") and of its receipts.
//
// Every song arrives precomputed for all three dials (web/static_data.song_data); the dial a
// visitor picks and the receipts of their runs live in browser storage. Charts are read-only
// here: importing, checking and editing a page need the local app. Pure: data, storage
// slots and the wall clock are injected.

import { resolveItem } from "./drill.js";

const PREFIX = "song:";
const RUNS_SHOWN = 50;
const RUNS_KEPT = 500;

// songs/chart.py _FRONT_RE: "<Title> · <label> line <n>[ · <k>th ending] (<cue>)".
const FRONT_RE = /^(.+?) · ([A-Za-z0-9'_-]{1,16}) line (\d+)(?: · (\d+)(?:st|nd|rd|th) ending)?(?:\s*\(.*\))?\s*$/;

/** songs.chart.parse_front: a phrase Front → [title, section, line, volta|null], or null. */
export function parseFront(text) {
  const m = FRONT_RE.exec(String(text).trim());
  if (!m) return null;
  return [m[1], m[2], Number(m[3]), m[4] === undefined ? null : Number(m[4])];
}

/** songs.chart.slugify */
export function slugify(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "song";
}

const readJSON = (slot, fallback) => {
  try {
    const raw = slot.get();
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
};

export class SongLibrary {
  /**
   * songs: {id: site/data/songs/<id>.json}; dialSlot / runsSlot: storage slots ({get, set});
   * review: the scheduler (for each song's review block); clock: () → ISO wall-clock string.
   */
  constructor({ songs, dialSlot, runsSlot, review, clock, publish }) {
    this.songs = songs;
    this.ids = Object.keys(songs).sort();
    this.dialSlot = dialSlot;
    this.runsSlot = runsSlot;
    this.review = review;
    this.clock = clock;
    this.publish = publish || (() => {});
    this._items = new Map();          // `${id}|${dial}` → resolved items
    this._memoryRuns = null;
    this._memoryDials = null;
  }

  // ── the dial (per song, remembered in the browser) ─────────────────────────
  _dials() {
    return this._memoryDials || readJSON(this.dialSlot, {});
  }

  dialOf(id) {
    const song = this.songs[id];
    const chosen = this._dials()[id];
    return chosen && song.dials[chosen] ? chosen : song.grade;
  }

  setDial(id, dial) {
    const dials = { ...this._dials(), [id]: dial };
    const raw = JSON.stringify(dials);
    if (this._memoryDials || !this.dialSlot.set(raw)) this._memoryDials = dials;
  }

  view(id) {
    return this.songs[id].dials[this.dialOf(id)];
  }

  /** The dial's items, resolved once: {chords, phrases: [{section, line, volta, item}], play}. */
  items(id) {
    const dial = this.dialOf(id);
    const key = `${id}|${dial}`;
    if (!this._items.has(key)) {
      const v = this.songs[id].dials[dial];
      const r = (data) => resolveItem(data, v.chords);
      const play = {};
      for (const [label, data] of Object.entries(v.items.play)) play[label] = r(data);
      this._items.set(key, {
        chords: v.items.chords.map(r),
        phrases: v.items.phrases.map((p) => ({ section: p.section, line: p.line, volta: p.volta, item: r(p.item) })),
        play,
      });
    }
    return this._items.get(key);
  }

  // ── the deck-source seam (TrainerService.add_deck_source) ──────────────────
  /** (items, requeue misses) for a song deck name; null if it is not ours. */
  deck(name) {
    if (!name.startsWith(PREFIX)) return null;
    const parts = name.slice(PREFIX.length).split(":");
    if (parts.length < 2) return null;
    const [id, mode] = parts;
    const label = parts.length > 2 ? parts[2] : null;
    if (!this.songs[id]) return null;
    const items = this.items(id);
    if (mode === "chords" && label === null) return [items.chords, true];
    if (mode === "phrases" && label === null) return [items.phrases.map((p) => p.item), true];
    if (mode === "play" || mode === "run") {
      if (label !== null && !this.view(id).labels.includes(label)) return null;
      const item = items.play[label ?? ""];
      return [item ? [item] : [], false];
    }
    return null;
  }

  /** Decode a song phrase card ("I Got Rhythm · A line 2 · 1st ending (after F7)"). */
  itemForFront(text) {
    const parsed = parseFront(text);
    if (!parsed) return null;
    const [title, label, line, volta] = parsed;
    for (const id of this.ids) {
      const song = this.songs[id];
      if (song.title.trim().toLowerCase() !== title.trim().toLowerCase()
        && slugify(song.title) !== slugify(title)) continue;
      const candidates = this.items(id).phrases.filter((p) => p.section === label && p.line === line);
      if (!candidates.length) return null;
      const exact = candidates.filter((p) => p.volta === volta);
      return (exact[0] || candidates[0]).item;
    }
    return null;
  }

  /** Phrase cards to top up a short review:song:<id> session. */
  fill(theme) {
    if (!theme.startsWith(PREFIX)) return [];
    const id = theme.slice(PREFIX.length);
    return this.songs[id] ? this.items(id).phrases.map((p) => p.item) : [];
  }

  deckNames() {
    const names = [];
    for (const id of this.ids) {
      names.push(...["chords", "phrases", "play"].map((m) => `${PREFIX}${id}:${m}`));
      names.push(...this.view(id).labels.map((l) => `${PREFIX}${id}:play:${l}`));
    }
    return names;
  }

  // ── reading ─────────────────────────────────────────────────────────────
  _reviewBlock(id) {
    const theme = PREFIX + id;
    const counts = this.review.counts()[theme] || {};
    return { theme, backend: this.review.id, label: this.review.label, available: true,
      cards: counts.cards || 0, due: counts.due || 0 };
  }

  /** GET /api/songs — sorted by title, like SongsService.summaries(). */
  summaries() {
    const out = this.ids.map((id) => {
      const s = this.songs[id];
      const sum = this.view(id).summary;
      return { id, title: s.title, composer: s.composer, key: s.key, time: s.time, checked: s.checked,
        phrases: sum.phrases, chords: sum.chords, problems: sum.problems, flags: 0, updated: s.updated };
    });
    return out.sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1
      : a.title.toLowerCase() > b.title.toLowerCase() ? 1 : 0));
  }

  /** GET /api/songs/{id} — song JSON v1 under the song's dial, with the live review block. */
  song(id) {
    if (!this.songs[id]) return null;
    const doc = JSON.parse(JSON.stringify(this.view(id).song));
    doc.review = this._reviewBlock(id);
    return doc;
  }

  text(id) {
    return this.songs[id] ? this.songs[id].text : null;
  }

  /** PATCH {grade} — the one edit the page makes. Announces "changed" like the server; a song
   *  in review gets its cards rewritten under the new dial (SongsService._sync_review). */
  patchGrade(id, dial) {
    this.setDial(id, dial);
    const theme = PREFIX + id;
    if ((this.review.counts()[theme] || {}).cards) this.review.add(theme, this.view(id).cards);
    this.publish({ type: "songs", event: "changed", song: id });
    return this.song(id);
  }

  /** "Add to review": the song's phrase cards (under its dial) into the scheduler. */
  seed(id) {
    const theme = PREFIX + id;
    const result = this.review.add(theme, this.view(id).cards);
    this.publish({ type: "songs", event: "changed", song: id });
    return { backend: this.review.id, deck: theme, ...result };
  }

  // ── receipts (SongsService.on_event) ────────────────────────────────────────
  _runs() {
    if (this._memoryRuns) return this._memoryRuns;
    const value = readJSON(this.runsSlot, []);
    return Array.isArray(value) ? value : [];
  }

  /** GET /api/songs/{id}/runs — newest first. */
  runs(id) {
    return this._runs().filter((r) => r.song === id).reverse().slice(0, RUNS_SHOWN);
  }

  /** A firehose listener: a song drill's done becomes a receipt (published before the done). */
  onEvent(event) {
    if (event.type !== "done") return;
    const deck = String(event.deck || "");
    let name = deck;
    for (const session of ["review:", "anki:"]) {
      if (deck.startsWith(session + PREFIX)) name = deck.slice(session.length);
    }
    if (!name.startsWith(PREFIX)) return;
    const parts = name.slice(PREFIX.length).split(":");
    const id = parts[0];
    if (!this.songs[id]) return;
    let mode = parts.length > 1 ? parts[1] : "phrases";
    mode = mode === "run" ? "play" : mode;
    const receipt = { v: 1, song: id, deck, mode, finished: this.clock(), stopped: !!event.stopped,
      ...(event.summary || {}), misses: this._misses(id, mode, event.results || []) };
    const runs = [...this._runs(), receipt].slice(-RUNS_KEPT);
    if (this._memoryRuns || !this.runsSlot.set(JSON.stringify(runs))) this._memoryRuns = runs;
    this.publish({ type: "songs", event: "receipt", song: id, receipt });
  }

  _misses(id, mode, results) {
    const misses = {};
    const miss = this.view(id).miss;
    if (mode === "chords") {
      for (const r of results) {
        const wrong = (r.attempts || []).filter((a) => !a.ok).length;
        const key = miss.chords[r.prompt];
        if (wrong && key) misses[key] = (misses[key] || 0) + wrong;
      }
      return misses;
    }
    const steps = { ...miss.phrases, ...(mode === "play" ? miss.play : {}) };
    for (const r of results) {
      const addrs = steps[r.prompt];
      if (!addrs || !addrs.length) continue;
      let at = 0;
      for (const a of r.attempts || []) {
        if (a.ok) at += 1;
        else if (at < addrs.length) misses[addrs[at]] = (misses[addrs[at]] || 0) + 1;
      }
    }
    return misses;
  }
}
