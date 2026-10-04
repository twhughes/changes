// offline/trainer.js — the static page's twin of trainer/service.py (CONTRACTS.md §5, §9, §10,
// §12): the deck sessions (shuffle, SESSION_CARDS, requeue a miss 3 cards later, MAX_CARDS,
// the streak), review sessions over the built-in scheduler (top-up from the theme's deck,
// ease handed to answer()), deck sources (the songs), the held/note firehose, and every event
// payload the views read (prompt carries chord/level/staff/ref/recall; a recall card sends
// chord null in prompt, step and status). The page's runtime calls tick(now, events) the way
// the server's poll thread does. Pure: the clock, publish, shuffle and data are injected.

import { DrillEngine, NoteTracker, normalizeEvent } from "./drill.js";
import { grade } from "./grading.js";
import { hintVoicing, nameNotes, pyRound } from "./theory.js";

export const SESSION_CARDS = 30;      // a drill session is at most this many prompts...
export const MAX_CARDS = 60;          // ...plus requeued misses, hard-capped here
export const REQUEUE_OFFSET = 3;      // learn/decks.py: a missed card comes back 3 cards later
export const HELD_MIN_INTERVAL_S = 0.033;
const REVIEW_DECK = "review";
const REVIEW_PREFIX = "review:";
const ANKI_VIRTUAL_DECK = "anki-due";
const ANKI_THEME_PREFIX = "anki:";

/** Python's repr() of a plain str, for the messages the server words with !r. */
export const pyRepr = (s) => (String(s).includes("'") && !String(s).includes('"')
  ? `"${s}"` : `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);

/** Fisher–Yates (random.Random().shuffle's job); tests inject the identity. */
export function shuffled(items, random = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** trainer.service.session_summary over ItemResult dicts. */
export function sessionSummary(results) {
  // Whole milliseconds: an exact integer sum and one division, as session_summary does.
  const ms = results.filter((r) => r.passed && r.latency_s !== null).map((r) => Math.round(r.latency_s * 1000));
  return {
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    mean_latency_s: ms.length ? pyRound(ms.reduce((a, b) => a + b, 0) / (1000 * ms.length), 3) : null,
  };
}

export class Trainer {
  /**
   * builtins: {decks: {name: [item]}, decode(front) → item|null, seedFronts(name) → [front],
   *            seedable: Set<name>}
   * review:   a LocalScheduler            publish: (event) → void
   * now:      () → seconds (0.1 ms grain) shuffle: (items) → items
   * naming:   site/data app.json "naming"  gradePolicy: app.json "policies.grade"
   */
  constructor({ builtins, review, publish, now, shuffle = shuffled, naming, gradePolicy }) {
    this.builtins = builtins;
    this.review = review;
    this.publish = publish || (() => {});
    this.now = now;
    this.shuffle = shuffle;
    this.naming = naming;
    this.gradePolicy = gradePolicy;
    this.tracker = new NoteTracker();
    this.deckName = null;
    this.engine = null;
    this.streak = 0;
    this.midiPort = null;
    this._sources = [];
    this._requeueOn = true;
    this._reviewCards = new Map();      // drill item idx → the scheduler's card id
    this._heldSent = [];
    this._heldAt = -HELD_MIN_INTERVAL_S;
    this._heldDirty = false;
    this._heldNames = [];
    this._heldPcs = [];
  }

  addDeckSource(source) {
    this._sources.push(source);
  }

  _sourceDeck(name) {
    for (const source of this._sources) {
      let served = null;
      try { served = source.deck(name); } catch { served = null; }
      if (served) return served;
    }
    return null;
  }

  _decode(front) {
    const item = this.builtins.decode(front);
    if (item) return item;
    for (const source of this._sources) {
      let found = null;
      try { found = source.itemForFront(front); } catch { found = null; }
      if (found) return found;
    }
    return null;
  }

  _fill(theme) {
    if (this.builtins.seedable.has(theme)) return this.shuffle(this.builtins.decks[theme] || []);
    for (const source of this._sources) {
      let items = [];
      try { items = source.fill(theme) || []; } catch { items = []; }
      if (items.length) return this.shuffle(items);
    }
    return [];
  }

  // ── the poll cycle ────────────────────────────────────────────────────────
  /** One cycle: fold the new note events in, publish, feed the drill. events: [{on, note, vel}]. */
  tick(now, events = []) {
    for (const e of events) {
      const note = Math.max(0, Math.min(127, Math.trunc(Number(e.note) || 0)));
      const vel = Math.max(0, Math.min(127, Math.trunc(Number(e.vel ?? 100))));
      const ev = normalizeEvent(e.on ? "note_on" : "note_off", note, vel, e.t ?? now);
      this.tracker.feed(ev);
      // Unthrottled per-note firehose: what the sound drivers key off.
      this.publish({ type: "note", on: ev.type === "note_on", note: ev.note, vel: ev.vel });
    }
    this._pumpHeld(now);
    if (this.engine !== null && !this.engine.done) this.engine.feed(now, this.tracker);
  }

  /** Work left for the poll loop: a held delta to flush, or a live drill to debounce. */
  busy() {
    return this._heldDirty || (this.engine !== null && !this.engine.done);
  }

  _pumpHeld(now) {
    const held = [...this.tracker.held].sort((a, b) => a - b);
    const changed = held.length !== this._heldSent.length || held.some((n, i) => n !== this._heldSent[i]);
    if (changed) {
      this._heldSent = held;
      this._heldDirty = true;
      this._heldNames = nameNotes(held, this.naming, 2).map((r) => ({ name: r.name, exact: r.exact }));
      this._heldPcs = [...new Set(held.map((n) => n % 12))].sort((a, b) => a - b);
    }
    if (this._heldDirty && now - this._heldAt >= HELD_MIN_INTERVAL_S) {
      this._heldDirty = false;
      this._heldAt = now;
      this.publish({ type: "held", notes: [...this._heldSent], pcs: [...this._heldPcs],
        names: this._heldNames.map((n) => ({ ...n })) });
    }
  }

  // ── review ────────────────────────────────────────────────────────────────
  dueNow() {
    return this.review.due(null);
  }

  /** Review sessions first (everything due, then per theme), then the built-ins. */
  deckNames() {
    const due = this.dueNow();
    const names = Object.keys(this.builtins.decks);
    if (!due.length) return names;
    const themes = [...new Set(due.map((c) => c.theme).filter(Boolean))].sort();
    return [REVIEW_DECK, ...themes.map((t) => REVIEW_PREFIX + t), ...names];
  }

  /** "Add to review" for a built-in deck → {backend, deck, added, updated, unchanged, total}. */
  seedBuiltin(name) {
    if (!(name in this.builtins.decks)) {
      throw Object.assign(new Error("unknown deck"), { status: 404, detail: `unknown deck ${pyRepr(name)}` });
    }
    if (!this.builtins.seedable.has(name)) {
      throw Object.assign(new Error("cram-only"),
        { status: 400, detail: `${pyRepr(name)} is cram-only — it has no review deck` });
    }
    const specs = this.builtins.seedFronts(name).map((front) => ({ key: front, front, back: "" }));
    const result = this.review.add(name, specs);
    return { backend: this.review.id, deck: name, ...result };
  }

  _startReview(theme = null) {
    let due = this.dueNow();
    if (theme !== null) due = due.filter((c) => c.theme === theme);
    const items = [];
    const cards = new Map();
    for (const card of due.slice(0, SESSION_CARDS)) {
      const item = this._decode(card.front);
      if (!item) continue;              // a Front that isn't ours isn't ours to drill
      cards.set(items.length, card.card_id);
      items.push(item);
    }
    if (theme !== null && items.length && items.length < SESSION_CARDS) {
      const prompts = new Set(items.map((i) => i.prompt));
      const fill = this._fill(theme).filter((i) => !prompts.has(i.prompt));
      items.push(...fill.slice(0, SESSION_CARDS - items.length));
    }
    if (!items.length) {
      this.publish({ type: "error", message: "nothing is due for review" });
      return false;
    }
    this.deckName = theme === null ? REVIEW_DECK : REVIEW_PREFIX + theme;
    this.streak = 0;
    this._requeueOn = true;
    this._reviewCards = cards;
    this.engine = new DrillEngine(items, (n, p) => this._onEngineEvent(n, p));
    this.engine.start(this.now());
    return true;
  }

  _answerReview(idx, ease) {
    const id = this._reviewCards.get(idx);
    if (id === undefined) return null;
    return this.review.answer(id, ease) ? ease : null;
  }

  // ── commands ──────────────────────────────────────────────────────────────
  startDrill(deckName) {
    if (deckName === REVIEW_DECK || deckName === ANKI_VIRTUAL_DECK) return this._startReview();
    for (const prefix of [REVIEW_PREFIX, ANKI_THEME_PREFIX]) {
      if (deckName.startsWith(prefix)) return this._startReview(deckName.slice(prefix.length));
    }
    let requeue = true;
    let items = this.builtins.decks[deckName] || null;
    if (items === null) {
      const served = this._sourceDeck(deckName);
      if (served) [items, requeue] = served;
    }
    if (items === null) {
      this.publish({ type: "error", message: `unknown deck ${pyRepr(deckName)}` });
      return false;
    }
    if (!items.length) {
      this.publish({ type: "error", message: `deck ${pyRepr(deckName)} has no cards` });
      return false;
    }
    this.deckName = deckName;
    this.streak = 0;
    this._reviewCards = new Map();
    this._requeueOn = requeue;
    const queue = this.shuffle(items);
    this.engine = new DrillEngine(queue.slice(0, SESSION_CARDS), (n, p) => this._onEngineEvent(n, p));
    this.engine.start(this.now());
    return true;
  }

  skip() {
    if (this.engine !== null && !this.engine.done) {
      this.streak = 0;
      this.engine.skip(this.now());
    }
  }

  stopDrill() {
    const engine = this.engine;
    this.engine = null;
    if (engine === null || engine.done) return;
    const results = engine.results.map((r) => ({ prompt: r.prompt, check: r.check, attempts: r.attempts,
      passed: r.passed, skipped: r.skipped, latency_s: r.latency_s, note: r.note }));
    this.publish({ type: "done", results, deck: this.deckName, summary: sessionSummary(results), stopped: true });
  }

  status() {
    const decks = this.deckNames();
    const engine = this.engine;
    const cur = engine !== null ? engine.current : null;
    return {
      midi_port: this.midiPort,
      anki: false,
      review: { backend: this.review.id, available: this.review.available() },
      decks,
      drill: {
        active: engine !== null && !engine.done,
        deck: this.deckName,
        idx: engine !== null ? engine.idx : -1,
        total: engine !== null ? engine.items.length : 0,
        streak: this.streak,
        prompt: cur ? cur.prompt : null,
        chord: cur && !cur.isPitch && !cur.recall ? cur.chord.text : null,
        ref: cur ? cur.ref : null,
        step: cur ? engine._sub : 0,
        recall: !!(cur && cur.recall),
        level: cur ? (cur.isPitch ? "pitch" : cur.level) : null,
        staff: cur ? cur.staff() : null,
        notes: cur && !cur.isPitch && !cur.recall ? hintVoicing(cur.seq[engine._sub]) : null,
      },
    };
  }

  // ── engine → firehose ─────────────────────────────────────────────────────
  _onEngineEvent(name, payload) {
    const event = { type: name, ...payload };
    const engine = this.engine;
    if (name === "prompt" && engine !== null) {
      const item = engine.items[payload.idx];
      // Pitch items show a staff, recall items (song phrases) show neither: the chords are the answer.
      event.chord = item.isPitch || item.recall ? null : item.chord.text;
      event.level = item.isPitch ? "pitch" : item.level;
      event.staff = item.staff();
      event.ref = item.ref;
      event.recall = item.recall;
      event.notes = item.isPitch || item.recall ? null : hintVoicing(item.chord);
    } else if (name === "step" && engine !== null) {
      const item = engine.items[payload.idx];
      if (item.recall) event.chord = null;
      event.notes = item.recall ? null : hintVoicing(item.seq[payload.step]);
    } else if (name === "passed") {
      const deck = this.deckName || "";
      const reviewSession = deck.startsWith("review") || deck.startsWith("anki");
      if (payload.first_try) this.streak += 1;
      else {
        this.streak = 0;
        if (!reviewSession && this._requeueOn) this._requeue(payload.idx);
      }
      event.streak = this.streak;
      if (engine !== null) {
        const item = engine.items[payload.idx];
        const result = engine.results[payload.idx];
        const cardGrade = grade(result.attempts, payload.latency_s, item.seq.length, this.gradePolicy);
        event.grade = cardGrade;
        const ease = this._answerReview(payload.idx, cardGrade.ease);
        if (ease !== null) {
          event.review_ease = ease;
          event.backend = this.review.id;
        }
      }
    } else if (name === "done") {
      event.deck = this.deckName;
      event.summary = sessionSummary(payload.results);
    }
    this.publish(event);
  }

  _requeue(idx) {
    const engine = this.engine;
    if (engine === null || engine.items.length >= MAX_CARDS) return;
    const item = engine.items[idx];
    engine.items.splice(Math.min(idx + REQUEUE_OFFSET, engine.items.length), 0, item);
  }
}
