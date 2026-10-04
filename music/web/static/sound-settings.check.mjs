// Headless check for the S-1 twin's settings (sound/settings.js) — `node sound-settings.check.mjs`.
//
// The header comes from the real index.html, over dom-stub.mjs. The sound is the real loader
// (sound/index.js) and the real twin driver (sound/twin.js): a fake Web Audio runs the REAL vendored
// processor (sound/twin/worklet.js), so a knob turned in the panel is checked where it lands, in the
// twin's voices and effects. It checks: the ⚙ shows only while the S-1 twin is the chosen sound; the
// panel's sections and controls come from schema.json in front-panel order, CONTROLLER and the rest
// left out; each tooltip is the description; a change posts the CC to the twin, plays at once, is saved
// and gives the keys back to musical typing; a later twin (a switch, a reload) starts with the saved
// changes, also ones made while the twin was loading; Reset returns to the patch; ✕, Esc and the ⚙
// close it; it works without storage; a failed load says so and tries again.
// Exit 0 = every assertion held; exit 1 prints the first failure.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDom, walk, byClass, one, button, tick, fakeCtx, failFast } from "./dom-stub.mjs";

failFast("sound-settings.check.mjs");
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };   // plain values only, never stub nodes

const dom = installDom();
const { store, winListeners, fireWin } = dom;
const schema = JSON.parse(readFileSync(new URL("./sound/twin/schema.json", import.meta.url), "utf8"));
const allParams = [...schema.sections.flatMap((s) => s.params), ...schema.menu, ...schema.midi];
const param = (cc) => allParams.find((p) => p.cc === cc);
const quiet = [];
console.warn = (...a) => quiet.push(a.join(" "));   // the E-piano has no sample set here: it runs silent

// ── the fake Web Audio: the real worklet processor behind a main-thread stand-in ────────
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {} }; } };
let Processor = null;
globalThis.registerProcessor = (name, cls) => { if (name === "s1-twin") Processor = cls; };
await import("./sound/twin/worklet.js");
const nodes = [];
const fakeNode = (name) => ({ name, connect(dst) { return dst; }, disconnect() {} });
globalThis.AudioWorkletNode = class {
  constructor(ac, name, options) {
    this.posted = [];
    this.proc = new Processor({ processorOptions: options.processorOptions });
    const self = this;
    this.port = { postMessage(m) { self.posted.push(m); self.proc.port.onmessage({ data: structuredClone(m) }); } };
    nodes.push(this);
  }
  connect(dst) { return dst; }
  disconnect() {}
};
let gate = null;                                     // set: the next twin's worklet load waits for it
function fakeContext() {
  return {
    sampleRate: 48000, state: "running", destination: fakeNode("speakers"),
    audioWorklet: { addModule: async () => { if (gate) await gate; } },
    createAnalyser: () => ({ ...fakeNode("analyser"), fftSize: 2048, getFloatTimeDomainData() {} }),
    createGain: () => ({ ...fakeNode("gain"), gain: { value: 1 } }),
    resume: async () => {}, close: async () => {},
  };
}
window.AudioContext = function AudioContext() { return fakeContext(); };
let schemaDown = false;                              // set: schema.json answers 404
globalThis.fetch = async (url) => {
  const u = new URL(String(url), "http://localhost:8768/");
  const down = schemaDown && u.pathname.endsWith("/schema.json");
  if (u.protocol !== "file:" || down) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(u, "utf8")) };
};
// The twin's tail wait (2.5 s after dispose) is held; short waits (the stub's ticks) run.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => (ms >= 1000 ? 0 : realSetTimeout(fn, ms, ...a));

async function until(cond, what) {
  for (let i = 0; i < 500; i++) { if (cond()) return; await tick(); }
  throw new Error(`timed out: ${what}`);
}

// ── the header, from index.html ─────────────────────────────────────────────────────
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
document.body.innerHTML = html.match(/<header[\s\S]*?<\/header>/)[0];
const gear = document.getElementById("twin-btn");
const soundBar = document.getElementById("sound");
ok(gear !== null && gear.tagName === "BUTTON" && gear.hidden === true, "index.html has the ⚙ button, hidden until the twin plays");
const order = soundBar.children.map((n) => n.getAttribute("id") || (n.querySelector("select") || {}).id || n.tagName);
eq(order.slice(0, 2), ["sound-sel", "twin-btn"], "the ⚙ sits right after the 🔈 menu");
ok(/S-1 twin/.test(gear.getAttribute("title") || ""), "its tooltip says what it adjusts");

// ── 1. the ⚙ shows only while the S-1 twin is the chosen sound ──────────────────────────
const { mountSound, loadDriver } = await import("./sound/index.js");
const { mountTwinSettings, pickControls } = await import("./sound/settings.js");
const twinMod = await loadDriver("twin");
const { ctx, fire } = fakeCtx();
const sound = mountSound(ctx);
const ui = mountTwinSettings(sound, gear);
ok(ui !== null && gear.hidden, "mounted: nothing chosen yet, no ⚙");
fire({ type: "hello", sound: { driver: "samples" } });
await until(() => sound.current() === "samples", "the E-piano");
for (let i = 0; i < 20; i++) await tick();
ok(gear.hidden, "the E-piano: no ⚙ (its driver has no settings)");
const heard = [];
const unhear = sound.onChange((id) => heard.push([id, sound.driver() !== null]));
fire({ type: "sound", driver: "twin" });
ok(!gear.hidden, "the S-1 twin chosen: the ⚙ shows at once, while the twin still loads");
await until(() => sound.driver() && typeof sound.driver().set === "function", "the twin's driver");
eq(heard, [["twin", false], ["twin", true]], "the loader tells its listeners: the sound chosen, then its driver live");
unhear();
const twinNode = () => nodes.at(-1);
ok(!gear.hidden && typeof sound.driver().values === "function", "the twin is live: the ⚙ stays");
fire({ type: "sound", driver: "off" });
ok(gear.hidden, "Off: no ⚙");
fire({ type: "sound", driver: "twin" });
await until(() => sound.driver(), "the twin again");
ok(!gear.hidden, "the twin again: the ⚙ again");

// ── 2. a failed load says so, and the next open tries again ──────────────────────────
schemaDown = true;
gear.focus();
gear.click();
const panel = one(document.body, "ts-panel");
ok(panel !== null && !panel.hidden && ui.isOpen(), "the ⚙ opens the panel");
ok(gear.classList.contains("on") && gear.getAttribute("aria-expanded") === "true", "the ⚙ shows it is open");
ok(document.activeElement !== gear, "the ⚙ gives the keys back to musical typing");
await until(() => one(panel, "ts-error") !== null, "the load error");
ok(/did not load/.test(one(panel, "ts-error").textContent), "a schema that will not load: the panel says so");
gear.click();
ok(panel.hidden && !ui.isOpen() && !gear.classList.contains("on"), "the ⚙ closes it");
schemaDown = false;
gear.click();
await until(() => byClass(panel, "ts-row").length > 0, "the controls");
ok(one(panel, "ts-error") === null, "the next open loads the controls");

// ── 3. sections and controls, from schema.json ────────────────────────────────────────
const sections = byClass(panel, "ts-sec");
eq(sections.map((s) => s.children[0].textContent), ["LFO", "OSC", "FILTER", "AMP", "ENV", "EFX"],
  "the sound sections, in S-1 front-panel order");
const names = (sec) => byClass(sec, "ts-name").map((n) => n.textContent);
eq(sections.map(names), [
  ["Rate", "Waveform"],
  ["Range", "LFO Depth", "Square Level", "Saw Level", "Sub Level", "Noise Level", "Pulse Width"],
  ["Frequency", "Resonance", "LFO Depth", "Env Depth", "Key Follow"],
  ["Env Mode"],
  ["Attack", "Decay", "Sustain", "Release"],
  ["Delay Level", "Delay Time", "Reverb Level", "Reverb Time", "Chorus"],
], "each section's controls in the schema's order; the shift functions that shape the sound; Chorus from the menu");
const rows = byClass(panel, "ts-row");
const ccs = rows.map((r) => Number(r.getAttribute("data-cc")));
const row = (cc) => rows.find((r) => r.getAttribute("data-cc") === String(cc)) || null;
const controller = schema.sections.find((s) => s.name === "CONTROLLER").params.map((p) => p.cc);
ok(controller.every((cc) => !ccs.includes(cc)) && !/Polyphony|Portamento|Voice/.test(panel.textContent),
  "CONTROLLER is not shown (Polyphony stays Poly)");
ok(schema.midi.every((p) => !ccs.includes(p.cc)) && [17, 18, 27, 105].every((cc) => !ccs.includes(cc)),
  "no MIDI controls, and from the menu only Chorus");
ok(!/Draw|Chop|Noise Mode|Fine Tune|Sub Oct|Trigger Mode|PWM Source|Sync/.test(panel.textContent),
  "no control the browser twin cannot play, and none of the obscure shift functions");
const { supportOf, loadCurves } = await import("./sound/twin/audio.js");
const curves = await loadCurves("bundled");
ok(ccs.every((cc) => supportOf(cc, curves) !== null), "every control shown changes what the twin plays");
const sound6 = schema.sections.filter((s) => ["LFO", "OSC", "FILTER", "AMP", "ENV", "EFX"].includes(s.name));
ok(sound6.flatMap((s) => s.params).filter((p) => p.access === "panel" && supportOf(p.cc, curves) !== null)
  .every((p) => ccs.includes(p.cc)), "every front-panel control the twin plays is there");
ok(rows.every((r) => r.title && r.title === param(Number(r.getAttribute("data-cc"))).description),
  "each tooltip is the schema's description");
const slider = (cc) => walk(row(cc)).find((n) => n.tagName === "INPUT") || null;
const shown = (cc) => one(row(cc), "ts-val").textContent;
const continuous = ccs.filter((cc) => param(cc).type === "continuous");
ok(continuous.length === 20 && continuous.every((cc) => slider(cc) !== null && slider(cc).type === "range"
  && Number(slider(cc).min) === param(cc).min && Number(slider(cc).max) === param(cc).max),
  "a continuous control is a slider over the schema's range");
ok(slider(74).value === "70" && shown(74) === "70", "with its value: Frequency at the patch's 70");
ok(slider(3).value === "60" && shown(3) === "60", "a control the patch leaves alone shows the S-1 default (Rate 60)");
const segs = (cc) => walk(row(cc)).filter((n) => n.tagName === "BUTTON");
const pressed = (cc) => segs(cc).filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);
eq(segs(14).map((b) => b.textContent), ["64'", "32'", "16'", "8'", "4'", "2'"], "Range: a row of its labels");
eq(pressed(14), ["16'"], "16' pressed (the patch)");
eq(segs(28).map((b) => b.textContent), ["Gate", "Envelope"], "Env Mode: Gate | Envelope");
eq(pressed(28), ["Envelope"], "Envelope pressed (the patch)");
const menu = (cc) => walk(row(cc)).find((n) => n.tagName === "SELECT") || null;
eq(menu(12).children.map((o) => o.textContent), Object.values(param(12).labels), "Waveform: a menu of its labels");
eq(menu(93).children.map((o) => o.textContent), ["Off", "Type 1", "Type 2", "Type 3", "Type 4"], "Chorus: a menu of its labels");
ok(menu(12).value === "2" && menu(93).value === "2", "Triangle (the S-1 default) and chorus type 2 (the patch)");
ok(byClass(panel, "ts-follow")[0].textContent === "Open in S-1 twin ↗", "the head offers the S-1 twin's own page");
const resetBtn = button(panel, "Reset");
ok(resetBtn !== null && resetBtn.disabled && byClass(panel, "changed").length === 0, "nothing changed yet: Reset is off");

// ── 4. a change plays at once, is saved, and hands the keys back ────────────────────────
const saved = () => JSON.parse(store.get(twinMod.STORE_KEY) || "{}");
let node = twinNode();
const input = slider(74);
input.focus();
input.value = "100";
input.oninput({ target: input });
eq(node.posted.at(-1), { type: "cc", cc: 74, value: 100 }, "a slider posts its CC to the twin");
ok(node.proc.engine.cc.get(74) === 100 && sound.driver().values()[74] === 100, "the twin plays it at once");
ok(shown(74) === "100" && row(74).classList.contains("changed") && !resetBtn.disabled,
  "the value shows; the control is marked changed; Reset is on");
eq(saved(), { 74: 100 }, "saved in this browser as a change to the patch");
ok(document.activeElement === input, "while it moves, the slider keeps the keys");
input.onchange({ target: input });
ok(document.activeElement !== input, "after the change, the keys go back to musical typing");
const eight = segs(14).find((b) => b.textContent === "8'");
eight.focus();
eight.click();
eq(node.posted.at(-1), { type: "cc", cc: 14, value: 3 }, "a row of buttons posts its CC (Range 8')");
eq(pressed(14), ["8'"], "and 8' shows pressed");
ok(document.activeElement !== eight, "the button gives the keys back");
const chorus = menu(93);
chorus.focus();
chorus.value = "4";
chorus.onchange({ target: chorus });
eq(node.posted.at(-1), { type: "cc", cc: 93, value: 4 }, "a menu posts its CC (Chorus type 4)");
ok(node.proc.fx.cc[93] === 4 && document.activeElement !== chorus, "the effects take it; the menu gives the keys back");
eq(saved(), { 14: 3, 74: 100, 93: 4 }, "every change is saved");
segs(14).find((b) => b.textContent === "16'").click();
eq(saved(), { 74: 100, 93: 4 }, "back at the patch's value, a control is no change");
ok(!row(14).classList.contains("changed"), "and is not marked");

// ── 5. a later twin starts with the saved changes ───────────────────────────────────────
fire({ type: "sound", driver: "samples" });
ok(panel.hidden && !ui.isOpen() && gear.hidden, "a switch away from the twin closes the panel and hides the ⚙");
fire({ type: "sound", driver: "twin" });
await until(() => sound.driver() && twinNode() !== node, "a new twin");
node = twinNode();
ok(node.proc.engine.cc.get(74) === 100 && node.proc.fx.cc[93] === 4, "back on the twin: the changes play");
eq(Object.fromEntries(Object.entries(node.posted.find((m) => m.type === "ccs").values).filter(([cc]) => ["74", "93", "71"].includes(cc))),
  { 71: 12, 74: 100, 93: 4 }, "they arrive with the patch, in the twin's first settings message");
const reload = await twinMod.create(fakeContext(), fakeNode("out"));
ok(twinNode().proc.engine.cc.get(74) === 100 && reload.values()[93] === 4, "after a reload too: a new twin reads them");
reload.dispose();
gear.click();
await until(() => !panel.hidden, "the panel again");
ok(slider(74).value === "100" && menu(93).value === "4" && !resetBtn.disabled, "the panel shows what the twin plays");

// ── 6. Reset returns to the patch ────────────────────────────────────────────────────────
resetBtn.click();
const resets = node.posted.slice(-2);
eq(resets.map((m) => [m.cc, m.value]).sort((a, b) => a[0] - b[0]), [[74, 70], [93, 2]], "Reset posts the patch's values");
ok(node.proc.engine.cc.get(74) === 70 && node.proc.fx.cc[93] === 2, "the twin plays the patch again");
ok(!store.has(twinMod.STORE_KEY), "the saved changes are gone");
ok(resetBtn.disabled && byClass(panel, "changed").length === 0 && slider(74).value === "70" && menu(93).value === "2",
  "the panel shows the patch; Reset is off");

// ── 6b. the panel shows what the twin plays, also when another tab saved other changes ────────
store.set(twinMod.STORE_KEY, JSON.stringify({ 74: 33 }));         // another tab's Reset and turn
button(panel, "✕").click();
gear.click();
ok(slider(74).value === "70" && node.proc.engine.cc.get(74) === 70, "reopened: what this twin plays (70)");
fire({ type: "hello", sound: { driver: "twin" } });               // the socket came back: a new twin
await until(() => sound.driver() && twinNode() !== node, "the new twin");
node = twinNode();
ok(node.proc.engine.cc.get(74) === 33 && slider(74).value === "33" && shown(74) === "33",
  "a new twin starts with the saved 33, and the open panel follows it");
resetBtn.click();
ok(node.proc.engine.cc.get(74) === 70 && !store.has(twinMod.STORE_KEY), "Reset: the patch again");

// ── 7. ✕, Esc and the ⚙ close it ──────────────────────────────────────────────────────────
const keydowns = () => (winListeners.keydown ? winListeners.keydown.size : 0);
const openKeys = keydowns();
button(panel, "✕").click();
ok(panel.hidden && !ui.isOpen() && gear.getAttribute("aria-expanded") === "false", "✕ closes it");
ok(keydowns() === openKeys - 1, "closed: its Esc listener is gone");
gear.click();
await until(() => !panel.hidden, "open");
let prevented = false;
fireWin("keydown", { key: "Escape", defaultPrevented: true, preventDefault() {} });
ok(!panel.hidden, "an Esc a field already took (a bar being edited) leaves it open");
fireWin("keydown", { key: "a", defaultPrevented: false, preventDefault() { prevented = true; } });
ok(!panel.hidden && !prevented, "other keys pass by (musical typing plays on)");
fireWin("keydown", { key: "Escape", defaultPrevented: false, preventDefault() { prevented = true; } });
ok(panel.hidden && prevented && keydowns() === openKeys - 1, "Esc closes it");

// ── 8. a change made while the twin loads reaches it ──────────────────────────────────────
let release;
gate = new Promise((r) => { release = r; });
fire({ type: "sound", driver: "off" });
fire({ type: "sound", driver: "twin" });
const before = nodes.length;
gear.click();
await until(() => !panel.hidden && sound.driver() === null, "the panel, the twin still loading");
const res = slider(71);
res.value = "40";
res.oninput({ target: res });
ok(nodes.length === before && saved()[71] === 40, "no twin yet: the change is saved");
release();
gate = null;
await until(() => sound.driver() && nodes.length === before + 1, "the twin");
ok(twinNode().proc.engine.cc.get(71) === 40, "the twin starts with it");
ok(slider(71).value === "40" && shown(71) === "40", "the open panel still shows it");
resetBtn.click();
ok(twinNode().proc.engine.cc.get(71) === 12 && !store.has(twinMod.STORE_KEY), "Reset: the patch again");

// ── 9. without storage it still plays, and keeps the changes for the visit ───────────────────
const kept = globalThis.localStorage;
globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); },
  removeItem() { throw new Error("blocked"); } };
const cut = slider(74);
cut.value = "90";
cut.oninput({ target: cut });
ok(twinNode().proc.engine.cc.get(74) === 90, "no storage: a change still plays");
fire({ type: "sound", driver: "samples" });
fire({ type: "sound", driver: "twin" });
await until(() => sound.driver() && sound.driver().values()[74] !== undefined && nodes.length === before + 2, "a new twin");
ok(twinNode().proc.engine.cc.get(74) === 90, "and a new twin this visit starts with it");
gear.click();
await until(() => !panel.hidden, "open");
ok(slider(74).value === "90" && !resetBtn.disabled, "the panel shows it");
resetBtn.click();
ok(twinNode().proc.engine.cc.get(74) === 70 && resetBtn.disabled, "Reset works without storage too");
delete globalThis.localStorage;
eq(twinMod.savedChanges(), {}, "no localStorage at all: the visit's changes ({} after Reset)");
globalThis.localStorage = kept;

// ── 10. the rule itself, on a made-up schema ──────────────────────────────────────────────
const p = (cc, access, section) => ({ cc, name: `cc${cc}`, section, access, type: "continuous", min: 0, max: 127, default: 0, labels: {} });
const madeUp = {
  sections: [
    { name: "EFX", params: [p(92, "panel", "EFX"), p(90, "shift", "EFX"), p(108, "shift", "EFX")] },
    { name: "CONTROLLER", params: [p(80, "panel", "CONTROLLER")] },
    { name: "LFO", params: [p(3, "panel", "LFO"), p(102, "panel", "LFO")] },
  ],
  menu: [p(93, "menu", "EFX"), p(17, "menu", "LFO")],
};
eq(pickControls(madeUp, (cc) => cc !== 102).map((s) => [s.name, s.params.map((x) => x.cc)]),
  [["LFO", [3]], ["EFX", [92, 90, 93]]],
  "front-panel order whatever the schema's; panel controls, kept shift functions, Chorus; no CONTROLLER; nothing silent");

// ── 11. it stays inside the window ────────────────────────────────────────────────────────
const css = document.getElementById("twin-settings-css").textContent;
ok(/\.ts-panel \{[^}]*position: fixed[^}]*max-height: calc\(100vh[^}]*overflow: auto/.test(css),
  "the panel floats over the page and scrolls inside itself, never the page");

// ── 12. Open in S-1 twin: that page's knobs play here (hq/synth core/opener-sync.js) ─────────
{
  const followBtn = byClass(panel, "ts-follow")[0];
  const twinWin = { closed: false, focused: 0, focus() { this.focused += 1; }, location: { href: "" } };
  const opens = [];
  window.open = (url, name) => { opens.push([url, name]); return twinWin; };
  followBtn.onclick();
  eq(opens, [["", "s1-twin"]], "a window of its own, opened in the click (no pop-up blocker trips)");
  await until(() => twinWin.location.href !== "", "the twin page's address");
  eq(twinWin.location.href, "https://tylerwhughes.com/s1-twin/#sync=music",
    "the published page (no synth app on this machine), told to sync");
  followBtn.onclick();
  ok(opens.length === 1 && twinWin.focused === 1, "a second click brings that window forward");

  const msg = (data, extra = {}) => fireWin("message",
    { source: twinWin, origin: "https://tylerwhughes.com", data: { v: 1, ...data }, ...extra });
  const before = twinNode().posted.length;
  fireWin("message", { source: {}, origin: "https://tylerwhughes.com", data: { v: 1, type: "s1-twin:param", cc: 74, value: 5 } });
  msg({ type: "s1-twin:param", cc: 74, value: 5 }, { origin: "https://tylerwhughes.com.evil.example" });
  msg({ type: "s1-twin:play", cc: 74, value: 5 });
  await tick(); await tick();
  eq(twinNode().posted.length, before, "another window, another site or another message: ignored");

  msg({ type: "s1-twin:values", values: { 74: 33, 20: 0, 80: 0, 999: 1 } });
  await until(() => twinNode().proc.engine.cc.get(74) === 33, "the page's sound");
  ok(twinNode().proc.engine.cc.get(20) === 0, "every sound control of that page plays here");
  ok(twinNode().proc.engine.cc.get(80) !== 0, "but never its Polyphony (CONTROLLER): chords stay chords");
  ok(saved()[74] === 33 && saved()[20] === 0 && !("80" in saved()), "saved like a change made on this panel");
  ok(followBtn.textContent === "● Following the S-1 twin" && followBtn.classList.contains("on"),
    "the head says it follows");

  msg({ type: "s1-twin:param", cc: 71, value: 99 });
  await until(() => twinNode().proc.engine.cc.get(71) === 99, "a turn there");
  ok(shown(71) === "99", "each turn there plays here, and the open panel shows it");
  msg({ type: "s1-twin:param", cc: 71, value: 300 });
  await tick(); await tick();
  ok(twinNode().proc.engine.cc.get(71) === 99, "a value outside 0..127 is ignored");

  twinWin.closed = true;
  dom.pumpIntervals();
  ok(followBtn.textContent === "Open in S-1 twin ↗" && !followBtn.classList.contains("on"),
    "closing that page stops following");
  msg({ type: "s1-twin:param", cc: 71, value: 10 });
  await tick(); await tick();
  ok(twinNode().proc.engine.cc.get(71) === 99 && twinNode().proc.engine.cc.get(74) === 33,
    "its messages no longer count, and the sound stays as it was left");
}

console.log(`sound-settings.check.mjs: ok — ${checks} checks`);
process.exit(0);
