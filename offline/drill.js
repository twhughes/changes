// offline/drill.js — the static page's twin of midio/notes.py (NoteTracker), midio/events.py
// (MidiEvent.normalize) and learn/drill.py (DrillEngine), CONTRACTS.md §12.
//
// The engine is a time-driven state machine: callers push (t, tracker) in via feed(); it
// never reads a clock. Between items it waits for hands-off before arming, so a passing
// chord left held does not grade the next prompt. Debounce, arming, progressions, misses,
// first_try and every payload match the Python, proved by the parity vectors. Pure.

import { match, matchPitches, pyRound } from "./theory.js";

const DEFAULT_DEBOUNCE_S = 0.3;
const sortNum = (a, b) => a - b;

/** MidiEvent.normalize: note_on at velocity 0 is a note_off; t on the 0.1 ms grain. */
export function normalizeEvent(type, note, vel, t) {
  const kind = type === "note_on" && vel === 0 ? "note_off" : type;
  return { t: pyRound(t, 4), type: kind, note, vel };
}

export class NoteTracker {
  constructor() {
    this.held = new Set();
    this.lastChange = 0.0;
  }

  feed(ev) {
    const before = this.held.size;
    const had = this.held.has(ev.note);
    if (ev.type === "note_on") this.held.add(ev.note);
    else if (ev.type === "note_off") this.held.delete(ev.note);
    if (this.held.size !== before || this.held.has(ev.note) !== had) this.lastChange = ev.t;
  }

  /** The held set (sorted), iff non-empty and unchanged for at least debounceS; else null. */
  stableHeld(now, debounceS) {
    if (this.held.size && now - this.lastChange >= debounceS) return [...this.held].sort(sortNum);
    return null;
  }

  clear() {
    this.held.clear();
  }
}

/**
 * A data item (site/data, web/static_data.item_payload) → a live DrillItem.
 * `chords` is the file's chord table: text → {pcs, req, bass}.
 */
export function resolveItem(data, chords) {
  const chordOf = (text) => {
    const row = chords[text];
    if (!row) throw new Error(`no chord ${JSON.stringify(text)} in the data`);
    return { text, pcs: row.pcs, req: row.req, bass: row.bass };
  };
  const chord = chordOf(data.chord);
  const list = (data.chords || []).map(chordOf);
  const pitches = (data.pitches || []).map(Number);
  const item = {
    prompt: data.prompt,
    chord,
    chords: list,
    level: data.level || "loose",
    debounceS: data.debounce_s ?? DEFAULT_DEBOUNCE_S,
    pitches,
    octaveExact: data.octave_exact ?? true,
    clef: data.clef || "treble",
    recall: !!data.recall,
    ref: data.ref ?? null,
    get seq() { return this.chords.length ? this.chords : [this.chord]; },
    get isPitch() { return this.pitches.length > 0; },
    staff() { return this.pitches.length ? { clef: this.clef, pitches: [...this.pitches], key: "C" } : null; },
  };
  return item;
}

function resultDict(r) {
  return {
    prompt: r.prompt, check: r.check, attempts: r.attempts, passed: r.passed,
    skipped: r.skipped, latency_s: r.latency_s, note: r.note,
  };
}

/** on_event(name, payload) fires: prompt, attempt, step, passed, skipped, done. */
export class DrillEngine {
  constructor(items, onEvent) {
    this.items = items;
    this.onEvent = onEvent;
    this.idx = -1;
    this.results = [];
    this.done = false;
    this._armed = false;
    this._itemStart = 0.0;
    this._sub = 0;                     // progression step within the item
    this._lastGraded = null;
  }

  get current() {
    return this.idx >= 0 && this.idx < this.items.length ? this.items[this.idx] : null;
  }

  start(t) {
    this._advance(t);
  }

  _advance(t) {
    this.idx += 1;
    if (this.idx >= this.items.length) {
      this.done = true;
      this.onEvent("done", { results: this.results.map(resultDict) });
      return;
    }
    const item = this.items[this.idx];
    const check = item.isPitch
      ? { pitches: [...item.pitches], level: "pitch", octave_exact: item.octaveExact }
      : { chord: item.seq.map((c) => c.text).join(" → "), level: item.level };
    this.results.push({ prompt: item.prompt, check, attempts: [], passed: false, skipped: false,
      latency_s: null, note: null });
    this._itemStart = t;
    this._armed = false;
    this._sub = 0;
    this._lastGraded = null;
    this.onEvent("prompt", { idx: this.idx, prompt: item.prompt, total: this.items.length });
  }

  skip(t) {
    if (this.done || this.current === null) return;
    this.results[this.idx].skipped = true;
    this.onEvent("skipped", { idx: this.idx });
    this._advance(t);
  }

  feed(t, tracker) {
    if (this.done || this.current === null) return;
    // A chord left held from before this prompt does not grade it: wait until the hands
    // come off OR the held set changes after the item started.
    if (!this._armed) {
      if (tracker.held.size && tracker.lastChange < this._itemStart) return;
      this._armed = true;
    }
    const item = this.items[this.idx];
    const stable = tracker.stableHeld(t, item.debounceS);
    if (stable === null) return;
    const key = `${stable.join(",")}@${tracker.lastChange}`;
    if (key === this._lastGraded) return;
    this._lastGraded = key;

    const seq = item.seq;
    const verdict = item.isPitch
      ? matchPitches(stable, item.pitches, item.octaveExact)
      : match(stable, seq[this._sub], item.level);
    const latency = tracker.lastChange - this._itemStart;
    const attempt = { ok: verdict.ok, missing: verdict.missing, extra: verdict.extra,
      bass_ok: verdict.bass_ok, played: [...stable], latency_s: pyRound(latency, 3),
      summary: verdict.summary };
    const result = this.results[this.idx];
    result.attempts.push(attempt);
    this.onEvent("attempt", { idx: this.idx, verdict, latency_s: attempt.latency_s });
    if (!verdict.ok) return;
    if (!item.isPitch && this._sub + 1 < seq.length) {          // progression: next chord
      this._sub += 1;
      this.onEvent("step", { idx: this.idx, step: this._sub, of: seq.length, chord: seq[this._sub].text });
      return;
    }
    result.passed = true;
    result.latency_s = attempt.latency_s;
    // first_try = a clean run: every graded attempt (each progression step is one) was right.
    const first = result.attempts.every((a) => a.ok);
    this.onEvent("passed", { idx: this.idx, latency_s: result.latency_s, first_try: first });
    this._advance(t);
  }
}
