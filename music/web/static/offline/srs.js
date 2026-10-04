// offline/srs.js — the static page's twin of srs/local.py: the built-in SM-2 scheduler
// (CONTRACTS.md §10, §12). Same card records, same ids (sha1(theme \0 key)[:12]), same
// learning steps and intervals; the numbers come from srs/local.py SRS_POLICY, exported into
// site/data/app.json ("policies.srs"). The Python stores cards.json; the page stores the same
// {"v": 1, "cards": [...]} document in localStorage through a small storage adapter, and it
// keeps working (in memory) when storage is blocked.
//
// Time is Python's: naive local datetimes, ISO strings to the second, compared as strings.
// A time here is integer microseconds since 1970 read as a naive wall clock (UTC fields), so
// adding a timedelta never meets a DST jump — exactly like datetime + timedelta. Pure.

import { pyRound } from "./theory.js";

const STATE_ORDER = { learning: 0, review: 1, new: 2 };
const US_PER_DAY = 86400e6;

// ── naive time ──────────────────────────────────────────────────────────────
const pad = (n, w = 2) => String(n).padStart(w, "0");

/** µs (naive) → "2026-10-04T08:00:00" — datetime.isoformat(timespec="seconds") truncates. */
export function isoOf(us) {
  const d = new Date(Math.floor(us / 1000));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** "2026-10-04T08:00:00" → µs (naive). */
export function parseIso(text) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?$/.exec(String(text));
  if (!m) throw new Error(`not a naive ISO time: ${text}`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return ms * 1000 + (m[7] ? Number(m[7].padEnd(6, "0")) : 0);
}

/** The browser's wall clock as a naive time (what datetime.now() returns). */
export function naiveNow(date = new Date()) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(),
    date.getMinutes(), date.getSeconds(), date.getMilliseconds()) * 1000;
}

/** timedelta(days=d) in µs, as CPython builds it: whole days, then the fraction, ties to even. */
export function daysUs(days) {
  const whole = Math.trunc(days);
  const frac = days - whole;
  const scaled = US_PER_DAY * frac;
  const wholeUs = Math.trunc(scaled);
  const left = scaled - wholeUs;
  let sum = whole * US_PER_DAY + wholeUs;
  let r = Math.round(left);
  if (Math.abs(r - left) === 0.5) {
    const odd = Math.abs(sum) % 2 === 1 ? 1 : 0;
    r = 2 * Math.round((left + odd) * 0.5) - odd;
  }
  sum += r;
  return sum;
}

export const minutesUs = (m) => m * 60e6;

// ── card ids: sha1(theme \0 key) → first 12 hex ─────────────────────────────
function sha1Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const words = new Uint32Array((((len + 8) >> 6) + 1) * 16);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  const bits = len * 8;
  words[words.length - 1] = bits >>> 0;
  words[words.length - 2] = Math.floor(bits / 2 ** 32);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < words.length; off += 16) {
    for (let i = 0; i < 16; i++) w[i] = words[off + i];
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}

export const cardId = (theme, key) => sha1Hex(`${theme}\u0000${key}`).slice(0, 12);

// ── storage ─────────────────────────────────────────────────────────────────
/** A localStorage-backed slot: get() → string|null, set(text). Never throws. */
export function storageSlot(storage, key) {
  return {
    get() {
      try { return storage ? storage.getItem(key) : null; } catch { return null; }
    },
    set(text) {
      try { if (storage) storage.setItem(key, text); return true; } catch { return false; }
    },
  };
}

/** An in-memory slot (tests, and the fallback when storage is blocked). */
export function memorySlot(initial = null) {
  let value = initial;
  return { get: () => value, set: (text) => { value = text; return true; } };
}

// ── the scheduler ───────────────────────────────────────────────────────────
export class LocalScheduler {
  /**
   * slot: {get, set} holding '{"v":1,"cards":[...]}'; clock: () → naive µs; policy: SRS_POLICY.
   * id/label/note come from site/data/app.json "review" (srs/local.py LocalScheduler).
   */
  constructor({ slot, clock, policy, label = "Built-in", note = "" }) {
    this.slot = slot;
    this.clock = clock;
    this.policy = policy;
    this.id = "local";
    this.label = label;
    this.note = note;
    this._cards = null;
    this._raw = undefined;
    this._memory = null;            // what we hold when the slot refuses writes
  }

  _load() {
    const raw = this._memory !== null ? this._memory : this.slot.get();
    if (this._cards === null || raw !== this._raw) {
      let cards = [];
      try {
        const data = raw ? JSON.parse(raw) : null;
        cards = Array.isArray(data && data.cards) ? data.cards : [];
      } catch {
        cards = [];
      }
      this._cards = cards;
      this._raw = raw;
    }
    return this._cards;
  }

  _save() {
    const raw = JSON.stringify({ v: 1, cards: this._cards });
    if (this._memory === null && this.slot.set(raw)) this._raw = this.slot.get();
    else this._memory = this._raw = raw;      // storage blocked: keep working in memory
  }

  available() {
    return true;
  }

  /** Due + new cards, oldest first: [{card_id, front, theme}]. theme null = every theme. */
  due(theme = null) {
    const now = isoOf(this.clock());
    const cards = this._load().filter((c) => c.due <= now && (theme === null || c.theme === theme));
    const order = new Map(cards.map((c, i) => [c.id, i]));
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const rows = [...cards].sort((a, b) =>
      ((STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3))
      || cmp(a.state !== "new" ? a.due : "", b.state !== "new" ? b.due : "")
      || (order.get(a.id) - order.get(b.id)));
    return rows.map((c) => ({ card_id: c.id, front: c.front, theme: c.theme }));
  }

  /** specs [{key, front, back}] → {added, updated, unchanged, total}; existing keys keep their schedule. */
  add(theme, specs) {
    let added = 0, updated = 0, unchanged = 0;
    const now = isoOf(this.clock());
    const cards = this._load();
    const byId = new Map(cards.map((c) => [c.id, c]));
    for (const spec of specs) {
      const id = cardId(theme, spec.key);
      const card = byId.get(id);
      if (!card) {
        const fresh = { id, theme, key: spec.key, front: spec.front, back: spec.back ?? "",
          state: "new", due: now, interval: 0.0, ease: this.policy.start_ease, reps: 0, lapses: 0,
          added: now, last: null };
        cards.push(fresh);
        byId.set(id, fresh);
        added += 1;
      } else if (card.front !== spec.front || card.back !== (spec.back ?? "")) {
        card.front = spec.front;
        card.back = spec.back ?? "";
        updated += 1;
      } else {
        unchanged += 1;
      }
    }
    if (added || updated) this._save();
    return { added, updated, unchanged, total: specs.length };
  }

  answer(id, ease) {
    const p = this.policy;
    const now = this.clock();
    const card = this._load().find((c) => c.id === id);
    if (!card || ![1, 2, 3, 4].includes(ease)) return false;
    card.ease = Math.max(p.min_ease, card.ease + p.ease_delta[String(ease)]);
    let wait;
    if (card.state === "new" || card.state === "learning") {
      if (ease === 1) {
        card.state = "learning";
        wait = minutesUs(p.again_minutes);
      } else if (ease === 2) {
        card.state = "learning";
        wait = minutesUs(p.hard_new_minutes);
      } else {
        const days = ease === 3 ? p.graduate_days : p.easy_days;
        card.state = "review";
        card.interval = days;
        wait = daysUs(days);
      }
    } else if (ease === 1) {
      card.lapses += 1;
      card.state = "learning";
      card.interval = 0.0;
      wait = minutesUs(p.relearn_minutes);
    } else {
      let interval = Math.max(card.interval, 1.0);
      if (ease === 2) interval *= p.hard_factor;
      else if (ease === 3) interval = Math.max(interval + 1, interval * card.ease);
      else interval = interval * card.ease * p.easy_bonus;
      card.interval = Math.min(p.max_days, pyRound(interval, 2));
      wait = daysUs(card.interval);
    }
    card.reps += 1;
    card.due = isoOf(now + wait);
    card.last = isoOf(now);
    this._save();
    return true;
  }

  /** {theme: {cards, due}} */
  counts() {
    const now = isoOf(this.clock());
    const out = {};
    for (const c of this._load()) {
      const row = out[c.theme] || (out[c.theme] = { cards: 0, due: 0 });
      row.cards += 1;
      if (c.due <= now) row.due += 1;
    }
    return out;
  }

  card(id) {
    const c = this._load().find((x) => x.id === id);
    return c ? { ...c } : null;
  }

  /** Every card record (parity checks and the test hook). */
  cards() {
    return this._load().map((c) => ({ ...c }));
  }
}
