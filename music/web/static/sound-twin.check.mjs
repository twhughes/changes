// Headless check for the S-1 twin sound driver (sound/twin.js) — `node sound-twin.check.mjs`.
//
// Node has no Web Audio, so a small fake stands in for the AudioContext, and its AudioWorkletNode runs
// the REAL vendored processor (sound/twin/worklet.js, the twin's own DSP). That lets this check the
// driver contract end to end: create(ac, out) returns {noteOn, noteOff, allOff, dispose} plus the
// optional settings members {set, values}; the twin plays into `out` (not the speakers) on 8 voices
// with the soft keys patch; an 8-note chord sounds whole and stays out of the limiter; the 9th key
// steals; set() turns one control live; dispose() lets the tails ring, then ends the processor; a
// twin that cannot start runs silent; this browser's saved changes apply on create; nothing is
// fetched from a server. Last, the loader (sound/index.js) lists the twin and drops a twin that
// finishes starting after a switch.
// Exit 0 = every assertion held; exit 1 prints the first failure.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let checks = 0;
// Node 25 has a localStorage of its own that warns when touched: this one is a plain map.
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

// ── the fake Web Audio: the worklet scope, then the main-thread side ────────────────
const SR = 48000, B = 128;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {} }; } };
let Processor = null;
globalThis.registerProcessor = (name, cls) => { if (name === "s1-twin") Processor = cls; };
await import("./sound/twin/worklet.js");
ok(typeof Processor === "function", "the vendored worklet registers s1-twin");

const nodes = [];
const fakeNode = (name) => ({ name, connections: [], connect(dst, out = 0) { this.connections.push([dst, out]); return dst; },
  disconnect() { this.connections = []; } });
globalThis.AudioWorkletNode = class {
  constructor(ac, name, options) {
    this.name = name;
    this.options = options;
    this.posted = [];
    this.connections = [];
    this.proc = new Processor({ processorOptions: options.processorOptions });
    const self = this;
    this.port = { postMessage(m) { self.posted.push(m); self.proc.port.onmessage({ data: structuredClone(m) }); } };
    nodes.push(this);
  }
  connect(dst, out = 0) { this.connections.push([dst, out]); return dst; }
  disconnect() { this.connections = []; }
};
const fetched = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  fetched.push(u.href);
  if (u.protocol !== "file:") return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(u, "utf8")) };
};
function fakeContext({ failWorklet = false } = {}) {
  const added = [];
  return {
    added, sampleRate: SR, state: "running", destination: fakeNode("speakers"),
    audioWorklet: { addModule: async (u) => { if (failWorklet) throw new Error("no AudioWorklet here"); added.push(String(u)); } },
    createAnalyser: () => ({ ...fakeNode("analyser"), fftSize: 2048, getFloatTimeDomainData() {} }),
    createGain: () => ({ ...fakeNode("gain"), gain: { value: 1 } }),
    resume: async () => {}, close: async () => {},
  };
}
// timers by hand, so dispose()'s tail wait is checked without waiting
const timers = [];
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
const runTimers = () => { while (timers.length) timers.shift().fn(); };

/** Run the processor for `seconds`; returns each output stage as one Float32Array. */
function render(proc, seconds) {
  const blocks = Math.round((seconds * SR) / B);
  const stages = Array.from({ length: 5 }, () => new Float32Array(blocks * B));
  for (let k = 0; k < blocks; k++) {
    const outs = Array.from({ length: 5 }, () => [new Float32Array(B)]);
    proc.process([], outs);
    for (let s = 0; s < 5; s++) stages[s].set(outs[s][0], k * B);
  }
  return stages;
}
const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const sounding = (eng) => eng.voices.filter((v) => v.active && !v.released).map((v) => v.key).sort((a, b) => a - b);

// ── 1. the module and the contract ───────────────────────────────────────────────
const twinMod = await import("./sound/twin.js");
ok(typeof twinMod.create === "function", "sound/twin.js exports create(ac, out)");
ok(twinMod.VOICES === 8, "the driver asks for 8 voices");
ok(twinMod.PATCH[80] === 2, "the patch is in Poly mode (every key its own voice)");
ok(Object.entries(twinMod.PATCH).every(([cc, v]) => Number.isInteger(Number(cc)) && Number.isInteger(v) && v >= 0 && v <= 127),
  "the patch is S-1 CC numbers with values 0..127");

const ac = fakeContext();
const out = fakeNode("driver gain");
const driver = await twinMod.create(ac, out);
eq(Object.keys(driver).sort(), ["allOff", "dispose", "noteOff", "noteOn", "set", "values"],
  "create() returns the driver contract, with the optional settings members");
ok(Object.values(driver).every((f) => typeof f === "function"), "every contract member is a function");
const node = nodes.at(-1), proc = node.proc;
ok(node.name === "s1-twin" && ac.added.length === 1 && ac.added[0].endsWith("/sound/twin/worklet.js"),
  "the twin's worklet loads from the vendored copy");
ok(node.options.processorOptions.voices === 8 && proc.engine.voices.length === 8, "the processor runs 8 voices");
eq(node.connections.filter(([dst]) => dst === out).map(([, k]) => k), [4], "the 'out' stage plays into the driver's out node");
ok(!node.connections.some(([dst]) => dst === ac.destination), "and not straight to the speakers");
ok(proc.engine.cc.get(74) === 70 && proc.engine.P.poly === 2 && proc.fx.cc[93] === 2 && proc.fx.cc[91] === 30,
  "the soft keys patch reached the voices and the effects");
ok(fetched.length > 0 && fetched.every((u) => u.startsWith("file:") && u.endsWith("/sound/twin/curves.json")),
  "the only fetch is the bundled curves (no server, no /api)");

// ── 2. an 8-note chord sounds whole, and stays out of the limiter ───────────────────
const CHORD = [41, 48, 52, 55, 60, 64, 67, 71];   // a two-hand voicing: F2 C3 E3 G3 | C4 E4 G4 B4
for (const n of CHORD) driver.noteOn(n, 90);
const [, , held, , master] = render(proc, 1.0);
eq(sounding(proc.engine), CHORD, "8 keys: 8 voices sound");
ok(master.every(Number.isFinite) && rms(master) > 0.05, `the chord is audible (out RMS ${rms(master).toFixed(3)})`);
const hot = master.filter((v) => Math.abs(v) > 0.7).length / master.length;
ok(peak(master) < 0.95 && hot < 0.01,
  `the chord stays out of the limiter (peak ${peak(master).toFixed(2)}, ${(100 * hot).toFixed(2)}% of samples over its knee)`);
driver.noteOn(74, 90);
eq(sounding(proc.engine), [...CHORD.slice(1), 74], "a 9th key takes the oldest voice");
driver.noteOff(74);
for (const n of CHORD) driver.noteOff(n);
ok(sounding(proc.engine).length === 0, "noteOff releases every key");
const [, , tail] = render(proc, 3.0);
const fall = rms(tail.subarray(tail.length - 4800)) / rms(held);
ok(fall < 1e-3, `the release dies away (60 dB down within 3 s: ${(20 * Math.log10(fall)).toFixed(0)} dB)`);

driver.noteOn(60, 100);
driver.noteOn(64, 100);
driver.allOff();
ok(sounding(proc.engine).length === 0 && node.posted.at(-1).type === "alloff", "allOff releases everything");

// ── 2b. settings: set(cc, value) turns one control live, values() says what is set ─────────
eq(driver.values(), Object.fromEntries(Object.entries(twinMod.PATCH)), "values() is the patch before a change");
driver.set(74, 100);
eq(node.posted.at(-1), { type: "cc", cc: 74, value: 100 }, "set(cc, value) posts the CC to the twin");
ok(proc.engine.cc.get(74) === 100 && driver.values()[74] === 100, "the voices take it, and values() says so");
driver.set(91, 300);
ok(proc.fx.cc[91] === 127 && driver.values()[91] === 127, "a value past the S-1's range stops at 127");
driver.set(74, 70);
driver.set(91, 30);
ok(proc.engine.cc.get(74) === 70 && proc.fx.cc[91] === 30, "and back to the patch");

// ── 3. dispose: the tails ring, then the processor ends ─────────────────────────────
driver.noteOn(60, 100);
driver.dispose();
const posted = node.posted.length;
driver.noteOn(62, 100);
driver.noteOff(60);
driver.allOff();
driver.set(74, 10);
driver.dispose();
ok(node.posted.length === posted, "after dispose() the driver sends nothing");
eq(node.posted.at(-1), { type: "alloff" }, "dispose() releases the notes first");
ok(timers.length === 1 && timers[0].ms === twinMod.TAIL_MS && node.connections.length > 0, "and keeps the graph while the tails ring");
runTimers();
await Promise.resolve();
eq(node.posted.at(-1), { type: "stop" }, "then closes: the processor is told to stop");
ok(node.connections.length === 0, "and the node is disconnected");
ok(proc.process([], Array.from({ length: 5 }, () => [new Float32Array(B)])) === false, "a stopped processor lets the browser retire it");

// ── 4. a twin that cannot start runs silent instead of throwing ─────────────────────
const warned = [];
const warn = console.warn;
console.warn = (...a) => warned.push(a.join(" "));
const silent = await twinMod.create(fakeContext({ failWorklet: true }), out);
console.warn = warn;
eq(Object.keys(silent).sort(), ["allOff", "dispose", "noteOff", "noteOn"], "a failed start still keeps the contract");
silent.noteOn(60, 100); silent.noteOff(60); silent.allOff(); silent.dispose();
ok(warned.length === 1 && /twin/.test(warned[0]), "and says why on the console");

// ── 4b. this browser's changes (the S-1 settings panel saves them) apply on every create ────
store.set(twinMod.STORE_KEY, JSON.stringify({ 74: 100, 93: 4, 999: 1, "-1": 5, 20: "loud", 21: 12.5, 92: 300, 91: -3 }));
eq(twinMod.savedChanges(), { 74: 100, 93: 4 }, "savedChanges() keeps only CCs 0..127 with values 0..127");
const changed = await twinMod.create(fakeContext(), out);
const cproc = nodes.at(-1).proc;
ok(cproc.engine.cc.get(74) === 100 && cproc.fx.cc[93] === 4 && cproc.engine.cc.get(20) === 48,
  "a new twin starts with the patch and this browser's changes over it");
ok(changed.values()[74] === 100 && !(999 in changed.values()), "values() says so; junk stays out");
twinMod.saveChanges({});
ok(!store.has(twinMod.STORE_KEY), "saveChanges({}) forgets them");
store.set(twinMod.STORE_KEY, "{not json");
eq(twinMod.savedChanges(), {}, "junk in storage reads as no changes");
store.set(twinMod.STORE_KEY, "[70, 12]");
eq(twinMod.savedChanges(), {}, "and so does a list");
store.delete(twinMod.STORE_KEY);

// ── 5. the loader: lists the twin, and drops one that starts after a switch ─────────
const indexSrc = readFileSync(new URL("./sound/index.js", import.meta.url), "utf8");
ok(/BROWSER_DRIVERS = new Set\(\[[^\]]*"twin"[^\]]*\]\)/.test(indexSrc), "sound/index.js mounts the twin as a browser driver");
// The page's AudioContext holds the twin's worklet load until the check lets it go, so the switch
// below lands while create() is still running (after the module import, before the node exists).
let workletAsked, letWorkletGo;
const asked = new Promise((r) => { workletAsked = r; });
const gate = new Promise((r) => { letWorkletGo = r; });
globalThis.window = { addEventListener() {}, AudioContext: function AudioContext() {
  const c = fakeContext();
  c.audioWorklet.addModule = async (u) => { c.added.push(String(u)); workletAsked(); await gate; };
  return c;
} };
const { mountSound } = await import("./sound/index.js");
const handlers = new Map();
const ctx = { on: (type, fn) => handlers.set(type, fn) };
const sound = mountSound(ctx);
const before = nodes.length;
const loading = handlers.get("sound")({ driver: "twin" });
await asked;                                            // the twin is starting: its worklet is loading
handlers.get("sound")({ driver: "off" });               // ...and the menu moves to "off"
letWorkletGo();
await loading;
ok(sound.current() === "off" && nodes.length === before + 1, "a twin that finishes starting after a switch is not kept");
const orphan = nodes.at(-1);
handlers.get("note")({ on: true, note: 60, vel: 100 });
ok(!orphan.posted.some((m) => m.type === "on"), "notes do not reach it");
runTimers();
await Promise.resolve();
eq(orphan.posted.at(-1), { type: "stop" }, "it is disposed: its processor ends");
await handlers.get("hello")({ sound: { driver: "twin" } });
const live = nodes.at(-1);
handlers.get("note")({ on: true, note: 60, vel: 100 });
handlers.get("note")({ on: false, note: 60, vel: 0 });
eq(live.posted.slice(-2).map((m) => m.type), ["on", "off"], "the chosen twin gets the note firehose");

// ── 6. a MIDI note while the browser holds the sound back says how to start it ──────────
const appended = [];
globalThis.document = { body: { append: (el) => appended.push(el) },
  createElement: (tag) => ({ tagName: tag, style: {}, hidden: false, className: "", textContent: "" }) };
let heldCtx = null;
globalThis.window = { addEventListener() {}, AudioContext: function AudioContext() {
  heldCtx = { ...fakeContext(), state: "suspended" };
  return heldCtx;
} };
const handlers2 = new Map();
mountSound({ on: (type, fn) => handlers2.set(type, fn) });
await handlers2.get("hello")({ sound: { driver: "twin" } });
handlers2.get("note")({ on: false, note: 60, vel: 0 });
eq(appended.length, 0, "a note-off says nothing");
handlers2.get("note")({ on: true, note: 60, vel: 100 });
const shown = appended[0];
ok(shown && !shown.hidden && /Click anywhere to turn on sound/.test(shown.textContent),
  "a note while the sound is held back: 'Click anywhere to turn on sound'");
heldCtx.state = "running";
heldCtx.onstatechange();
ok(shown.hidden, "…and it goes the moment sound starts");
handlers2.get("note")({ on: true, note: 62, vel: 100 });
ok(shown.hidden && appended.length === 1, "a running context never shows it again");

console.log(`sound-twin.check.mjs: ok — ${checks} checks`);
