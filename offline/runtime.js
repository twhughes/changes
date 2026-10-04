// offline/runtime.js — the cockpit with no server (CONTRACTS.md §12). main.js boots this when
// index.html carries <meta name="music-static" content="1"> (tools/build_site.py adds it).
//
//   createRuntime(data, env)  pure composition, node-testable: the trainer twin, the songs
//                             library, the built-in scheduler, the API and the socket
//   boot()                    the browser: load site/data, put the API in front of fetch,
//                             listen to Web MIDI, run the poll loop, return the socket
//
// The socket has ws.js's shape — {on, send, close} — and speaks the cockpit's WS protocol v1
// (§5): hello, held, note, prompt, step, attempt, passed, skipped, done, error, songs, srs,
// sound, midi out; start / skip / stop / note_in in. Like the real wire, both directions are
// asynchronous and ordered, and every event is a JSON copy.

import { resolveItem } from "./drill.js";
import { createApi, installFetch } from "./api.js";
import { LocalScheduler, isoOf, memorySlot, naiveNow, storageSlot } from "./srs.js";
import { SongLibrary } from "./songs.js";
import { Trainer, shuffled } from "./trainer.js";
import { pyRound } from "./theory.js";

const KEYS = {
  srs: "music.static.srs.v1",
  dials: "music.static.dials.v1",
  runs: "music.static.runs.v1",
  sound: "music.static.sound",
};
const POLL_MS = 8;
const DATA_FILES = ["app.json", "decks.json", "songs.json"];

// ── the socket (ws.js's shape) ────────────────────────────────────────────────
export function createSocket(onCommand) {
  const subs = new Map();             // type → Set(callback)
  const outbox = [];
  let flushing = false;
  let closed = false;

  function deliver(msg) {
    for (const key of [msg.type, "*"]) {
      const set = subs.get(key);
      if (set) for (const cb of [...set]) {
        try { cb(msg); } catch (e) { console.error("view handler failed:", e); }
      }
    }
  }
  function flush() {
    flushing = false;
    while (outbox.length) deliver(outbox.shift());
  }
  return {
    on(type, cb) {
      if (!subs.has(type)) subs.set(type, new Set());
      subs.get(type).add(cb);
      return () => subs.get(type).delete(cb);
    },
    send(obj) {
      if (closed || !obj || typeof obj !== "object") return;
      const msg = JSON.parse(JSON.stringify(obj));
      queueMicrotask(() => onCommand(msg));
    },
    close() {
      closed = true;
    },
    /** The runtime's side: queue one server→client message. */
    emit(event) {
      outbox.push(JSON.parse(JSON.stringify(event)));
      if (!flushing) {
        flushing = true;
        queueMicrotask(flush);
      }
    },
  };
}

// ── the runtime ───────────────────────────────────────────────────────────────
/**
 * data: {app, decks, songs: {id: song data}} as site/data holds them.
 * env:  {storage (localStorage-like or null), now () → s, wallClock () → naive µs,
 *        shuffle (items) → items, onWork () → void (the poll loop wants to run)}
 */
export function createRuntime(data, env = {}) {
  const { app, decks } = data;
  const storage = env.storage === undefined ? null : env.storage;
  const slot = (key) => (storage ? storageSlot(storage, key) : memorySlot());
  const wallClock = env.wallClock || (() => naiveNow());
  const now = env.now || (() => 0);
  const onWork = env.onWork || (() => {});

  const review = new LocalScheduler({ slot: slot(KEYS.srs), clock: wallClock, policy: app.policies.srs,
    label: app.review.label, note: app.review.note });

  // Built-in decks: items resolved once against the file's chord table.
  const resolve = (item) => resolveItem(item, decks.chords);
  const builtinDecks = {};
  for (const [name, items] of Object.entries(decks.decks)) builtinDecks[name] = items.map(resolve);
  const fronts = new Map(Object.entries(decks.fronts));
  const decoded = new Map();
  const builtins = {
    decks: builtinDecks,
    seedable: new Set(decks.seedable),
    seedFronts: (name) => (decks.cards[name] || []).map((c) => c.front),
    decode(front) {
      const text = String(front).trim();
      if (!fronts.has(text)) return null;
      if (!decoded.has(text)) decoded.set(text, resolve(fronts.get(text)));
      return decoded.get(text);
    },
  };

  let socket = null;
  const listeners = [];
  // One firehose, like web/server.py's Hub: the songs library hears every event first (a
  // song drill's done writes its receipt), then the views.
  function publish(event) {
    for (const cb of listeners) {
      try { cb(event); } catch (e) { console.error("static runtime listener failed:", e); }
    }
    if (socket) socket.emit(event);
  }

  const songs = new SongLibrary({ songs: data.songs || {}, dialSlot: slot(KEYS.dials), runsSlot: slot(KEYS.runs),
    review, clock: () => isoOf(wallClock()), publish });
  listeners.push((event) => songs.onEvent(event));

  const trainer = new Trainer({ builtins, review, publish, now, shuffle: env.shuffle || shuffled,
    naming: app.naming, gradePolicy: app.policies.grade });
  trainer.addDeckSource(songs);

  // ── sound: the browser drivers only ──────────────────────────────────────
  const soundSlot = slot(KEYS.sound);
  const drivers = app.sound.drivers;
  const known = (id) => drivers.some((d) => d.id === id && d.available);
  let soundDriver = known(soundSlot.get()) ? soundSlot.get() : app.sound.default;

  function command(msg) {
    switch (msg.type) {
      case "start": trainer.startDrill(String(msg.deck || "")); break;
      case "skip": trainer.skip(); break;
      case "stop": trainer.stopDrill(); break;
      case "note_in": injectNote(!!msg.on, Number(msg.note) || 0, msg.vel === undefined ? 100 : Number(msg.vel)); break;
      default: break;                          // unknown messages are ignored, like the server
    }
    onWork();
  }
  socket = createSocket(command);

  /** A note from anywhere (Web MIDI, the on-screen piano, musical typing) joins the stream now. */
  function injectNote(on, note, vel = 100) {
    trainer.tick(now(), [{ on, note, vel }]);
    onWork();
  }

  const rt = {
    app, review, songs, trainer, socket,
    keys: KEYS,
    tick: (t = now(), events = []) => trainer.tick(t, events),
    injectNote,
    command,
    publish,
    /** Hear every event in publish order, after the songs library (checks, the test hook). */
    listen(cb) {
      listeners.push(cb);
      return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    hello() {
      return { type: "hello", status: trainer.status(), sound: { driver: soundDriver }, views: app.views,
        static: true };
    },
    practiceMenu() {
      const counts = review.counts();
      const groups = app.groups.map((g) => ({ ...g, decks: g.decks.map((d) => {
        const seen = counts[d.id] || {};
        return { ...d, in_review: (seen.cards || 0) > 0, due: seen.due || 0 };
      }) }));
      const songRows = songs.summaries().map((s) => {
        const seen = counts[`song:${s.id}`] || {};
        return { id: s.id, title: s.title, composer: s.composer, checked: s.checked, flags: s.flags,
          phrases: s.phrases, in_review: (seen.cards || 0) > 0, due: seen.due || 0, broken: false };
      });
      return { review: { backend: review.id, label: review.label, available: true, due: trainer.dueNow().length },
        groups, songs: songRows };
    },
    srsStatus() {
      return { backend: review.id, label: review.label, available: true,
        backends: [{ id: review.id, label: review.label, available: true, note: review.note }] };
    },
    soundStatus() {
      return { driver: soundDriver, drivers: drivers.map((d) => ({ ...d })) };
    },
    setSound(id) {
      if (!known(id)) return false;
      soundDriver = id;
      soundSlot.set(id);
      publish({ type: "sound", driver: id });
      return true;
    },
    setMidiPort(name) {
      trainer.midiPort = name || null;
      publish({ type: "midi", port: name || null, connected: !!name });
    },
  };
  rt.api = createApi(rt);
  return rt;
}

// ── the browser ───────────────────────────────────────────────────────────────
async function loadData(base) {
  const get = async (rel) => {
    const r = await fetch(new URL(rel, base).href);
    if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
    return r.json();
  };
  const [app, decks, index] = await Promise.all(DATA_FILES.map(get));
  const songs = {};
  await Promise.all(index.map(async (row) => { songs[row.id] = await get(row.file); }));
  return { app, decks, songs };
}

function browserStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = "music.static.probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;                               // private mode / blocked: work in memory
  }
}

/** Boot the page with no server; resolves to the socket main.js hands every view. */
export async function boot() {
  const dataBase = new URL("../data/", import.meta.url);
  const data = await loadData(dataBase);
  const t0 = performance.now();
  const now = () => pyRound((performance.now() - t0) / 1000, 4);

  let timer = null;
  const loop = () => {
    rt.tick(now());
    if (!rt.trainer.busy()) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onWork = () => {
    if (timer === null && rt.trainer.busy()) timer = setInterval(loop, POLL_MS);
  };
  const rt = createRuntime(data, { storage: browserStorage(), now, onWork });
  installFetch(rt.api, { samplesBase: data.app.sound.samples
    ? new URL(`../${data.app.sound.samples}`, import.meta.url).href : null });

  (await import("./midi.js")).startMidi({
    onNote: (on, note, vel) => rt.injectNote(on, note, vel),
    onPort: (name) => rt.setMidiPort(name),
  });

  // The test hook (static page only): drive the runtime the way the keys would.
  globalThis.__musicStatic = {
    runtime: rt,
    noteOn: (note, vel = 100) => rt.injectNote(true, note, vel),
    noteOff: (note) => rt.injectNote(false, note, 0),
    /** The live chord (or pitches) of the running drill, for a scripted pair of hands. */
    target() {
      const engine = rt.trainer.engine;
      const item = engine && !engine.done ? engine.current : null;
      if (!item) return null;
      return item.isPitch ? { pitches: [...item.pitches] }
        : { chord: { ...item.seq[engine._sub] }, step: engine._sub, of: item.seq.length };
    },
    status: () => rt.trainer.status(),
    due: () => rt.trainer.dueNow().length,
  };

  setTimeout(() => rt.socket.emit(rt.hello()), 0);
  return rt.socket;
}
