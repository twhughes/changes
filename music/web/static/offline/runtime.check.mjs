// Headless check of the static page's runtime — `node offline/runtime.check.mjs [site-dir]`.
//
// Runs offline/runtime.js over the data a real build wrote (tools/build_site.py; with no
// argument it builds into a temp dir): the API answers the views' /api/ calls, the socket
// speaks the WS protocol (start → prompt → attempt → step/passed → done, receipts first),
// "Add to review" fills the built-in scheduler, review sessions answer it, the dial and the
// receipts persist across a reload, blocked storage still works, and what needs the local
// app says so. Then the REAL views (practice.js → trainer.js / songs.js) mount over
// dom-stub.mjs on that runtime with ctx.static: no import form, no Check page, a stepper
// that starts at "Add to review", and drills that run.
// Exit 0 = every assertion held; exit 1 prints the first failure.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installDom, walk, byClass, one, button, settle, failFast } from "../dom-stub.mjs";
import { createRuntime } from "./runtime.js";
import { installFetch } from "./api.js";
import { parseIso } from "./srs.js";

failFast("runtime.check.mjs");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
let groups = 0;
const group = (name, fn) => fn().then(() => { groups += 1; }, (e) => { throw new Error(`${name}: ${e.message}`); });

function siteDir() {
  if (process.argv[2]) return process.argv[2];
  const venv = path.join(REPO, ".venv", "bin", "python");
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "music-site-")), "site");
  const r = spawnSync(fs.existsSync(venv) ? venv : "python3", [path.join(REPO, "tools", "build_site.py"), "--out", out],
    { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`the build failed:\n${r.stdout}${r.stderr}`);
  return out;
}

const SITE = siteDir();
const read = (rel) => JSON.parse(fs.readFileSync(path.join(SITE, "data", rel), "utf8"));
const app = read("app.json");
const decks = read("decks.json");
const songs = {};
for (const row of read("songs.json")) songs[row.id] = read(row.file);
const DATA = { app, decks, songs };

const dom = installDom();
const clock = { t: 0, wall: parseIso("2026-10-04T08:00:00") };
const env = (storage) => ({ storage, now: () => clock.t, wallClock: () => clock.wall, shuffle: (x) => [...x] });

/** A runtime plus a log of everything its socket delivered. */
function boot(storage = globalThis.localStorage) {
  const rt = createRuntime(DATA, env(storage));
  const log = [];
  rt.socket.on("*", (m) => log.push(m));
  const get = (url) => rt.api.handle("GET", url);
  const post = (url, body) => rt.api.handle("POST", url, body);
  return { rt, log, get, post, of: (type) => log.filter((m) => m.type === type) };
}

/** Hold the chord's notes, wait out the debounce, let go — the way hands would, on the fake clock. */
async function play(b, notes, { wait = 0.4 } = {}) {
  clock.t = Math.round((clock.t + 0.5) * 1e4) / 1e4;
  for (const n of notes) b.rt.socket.send({ type: "note_in", on: true, note: n, vel: 90 });
  await settle();
  clock.t = Math.round((clock.t + wait) * 1e4) / 1e4;
  b.rt.tick();
  for (const n of notes) b.rt.socket.send({ type: "note_in", on: false, note: n, vel: 0 });
  await settle();
  clock.t = Math.round((clock.t + 0.05) * 1e4) / 1e4;
  b.rt.tick();
  await settle();
}

/** A close voicing of the live chord: required pitch classes over C3/C4. */
function voicing(b) {
  const engine = b.rt.trainer.engine;
  const item = engine.current;
  if (item.isPitch) return [...item.pitches];
  const chord = item.seq[engine._sub];
  return [36 + chord.bass, ...chord.req.map((pc) => 60 + pc)];
}

// ── A. the API and the socket ─────────────────────────────────────────────────
await group("views and menu", async () => {
  const b = boot();
  assert.deepEqual(b.get("/api/views").body.map((v) => v.id), ["practice"]);
  const menu = b.get("/api/practice").body;
  assert.deepEqual(menu.groups.map((g) => g.id), ["chords", "progressions"]);
  assert.equal(menu.review.due, 0);
  assert.equal(menu.review.label, "Built-in");
  assert.deepEqual(menu.songs.map((s) => s.id), ["i-got-rhythm", "jazz-blues-in-f"]);
  const triads = menu.groups[0].decks.find((d) => d.id === "triads");
  assert.equal(triads.cards, 24);
  assert.equal(triads.seedable, true);
  assert.equal(b.get("/api/srs").body.backends.length, 1, "the 🧠 menu offers Built-in only");
  assert.equal(b.get("/api/sound").body.driver, app.sound.default);
});

await group("a deck drill over the socket", async () => {
  const b = boot();
  b.rt.socket.send({ type: "start", deck: "triads" });
  await settle();
  const prompt = b.of("prompt")[0];
  assert.equal(prompt.chord, "C");
  assert.equal(prompt.total, 24);
  assert.equal(prompt.recall, false);
  await play(b, [48, 64, 67, 72]);
  const attempt = b.of("attempt")[0];
  assert.equal(attempt.verdict.ok, true);
  assert.match(attempt.verdict.summary, /^C ✓/);
  const passed = b.of("passed")[0];
  assert.equal(passed.streak, 1);
  assert.equal(passed.grade.accuracy.tier, "clean");
  assert.equal(passed.review_ease, undefined, "a deck card is not a review card");
  assert.ok(b.of("note").length >= 8, "every key reaches the sound drivers");
  assert.ok(b.of("held").some((m) => m.names.length && m.names[0].name === "C"), "held carries names");
  await play(b, [61, 65]);                        // wrong: C# F against Db? (prompt 2 is Db)
  b.rt.socket.send({ type: "stop" });
  await settle();
  const done = b.of("done")[0];
  assert.equal(done.stopped, true);
  assert.equal(done.deck, "triads");
  assert.equal(done.summary.passed, 1);
});

await group("add to review, then review it", async () => {
  const b = boot();
  const seeded = b.post("/api/trainer/seed", { builtin: "triads" });
  assert.equal(seeded.status, 200);
  assert.deepEqual([seeded.body.added, seeded.body.total, seeded.body.backend], [24, 24, "local"]);
  assert.equal(b.post("/api/trainer/seed", { builtin: "triads" }).body.unchanged, 24);
  assert.equal(b.post("/api/trainer/seed", { builtin: "nope" }).status, 404);
  const menu = b.get("/api/practice").body;
  assert.equal(menu.review.due, 24);
  assert.equal(menu.groups[0].decks.find((d) => d.id === "triads").in_review, true);
  assert.equal(b.get("/api/trainer/decks").body[0], "review");
  b.rt.socket.send({ type: "start", deck: "review" });
  await settle();
  assert.equal(b.of("prompt")[0].chord, "C");
  await play(b, voicing(b));
  const passed = b.of("passed")[0];
  assert.ok(passed.review_ease >= 1 && passed.backend === "local", "a review pass answers the scheduler");
  assert.equal(b.get("/api/practice").body.review.due, 23);
  b.rt.socket.send({ type: "stop" });
  await settle();
});

await group("songs: the dial, review, a play-through and its receipt", async () => {
  const b = boot();
  const list = b.get("/api/songs").body;
  assert.deepEqual(list.map((s) => s.title), ["I Got Rhythm", "Jazz Blues in F"]);
  const doc = b.get("/api/songs/i-got-rhythm").body;
  assert.equal(doc.grade, "core");
  assert.equal(doc.page, null);
  assert.deepEqual(doc.review, { theme: "song:i-got-rhythm", backend: "local", label: "Built-in",
    available: true, cards: 0, due: 0 });
  assert.equal(doc.decks.play, "song:i-got-rhythm:play");
  const patched = b.rt.api.handle("PATCH", "/api/songs/i-got-rhythm", { grade: "triads" });
  assert.equal(patched.body.grade, "triads");
  assert.equal(patched.body.chords.length, 11);
  await settle();
  assert.ok(b.of("songs").some((m) => m.event === "changed"), "a dial change announces itself");
  assert.equal(b.rt.api.handle("PATCH", "/api/songs/i-got-rhythm", { checked: true }).status, 422);
  const seeded = b.post("/api/songs/i-got-rhythm/seed").body;
  assert.deepEqual([seeded.added, seeded.deck], [5, "song:i-got-rhythm"]);
  assert.equal(b.get("/api/songs/i-got-rhythm").body.review.cards, 5);

  b.rt.socket.send({ type: "start", deck: "song:i-got-rhythm:play:B" });
  await settle();
  const prompt = b.of("prompt").at(-1);
  assert.equal(prompt.chord, "D");                // triads dial: D7 → D
  assert.equal(prompt.ref, "song:i-got-rhythm:play:B");
  await play(b, [62, 63, 69]);                    // a wrong chord on the first bar
  for (let i = 0; i < 4; i++) await play(b, voicing(b));
  const kinds = b.log.map((m) => m.type);
  assert.ok(kinds.lastIndexOf("songs") < kinds.lastIndexOf("done"), "the receipt arrives before the done");
  const receipt = b.of("songs").filter((m) => m.event === "receipt").at(-1).receipt;
  assert.equal(receipt.mode, "play");
  assert.deepEqual(receipt.misses, { "B.1.1": 1 });
  assert.equal(b.get("/api/songs/i-got-rhythm/runs").body.length, 1);
});

await group("a reload keeps the review, the dial, the receipts, the sound", async () => {
  const b = boot();
  assert.equal(b.post("/api/sound/driver", { driver: "samples" }).status, 200);
  assert.equal(b.post("/api/sound/driver", { driver: "fluid" }).status, 404);
  const again = boot();                           // same localStorage: a reload
  const menu = again.get("/api/practice").body;
  assert.equal(menu.review.due, 23 + 5, "23 triads + 5 phrase cards are still due");
  assert.equal(again.get("/api/songs/i-got-rhythm").body.grade, "triads");
  assert.equal(again.get("/api/songs/i-got-rhythm/runs").body.length, 1);
  assert.equal(again.get("/api/sound").body.driver, "samples");
  assert.equal(again.rt.hello().sound.driver, "samples");
});

await group("blocked storage still works, in memory", async () => {
  const blocked = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); } };
  const b = boot(blocked);
  assert.equal(b.get("/api/practice").body.review.due, 0);
  assert.equal(b.post("/api/trainer/seed", { builtin: "two-five-one" }).body.added, 12);
  assert.equal(b.get("/api/practice").body.review.due, 12);
  b.rt.api.handle("PATCH", "/api/songs/jazz-blues-in-f", { grade: "written" });
  assert.equal(b.get("/api/songs/jazz-blues-in-f").body.grade, "written");
});

await group("what needs the local app says so", async () => {
  const b = boot();
  for (const [method, url, body] of [["POST", "/api/songs/import", { url: "https://x" }],
    ["PUT", "/api/songs/i-got-rhythm/text", { text: "" }], ["PUT", "/api/songs/i-got-rhythm/bar/A.1.1", { text: "C" }],
    ["POST", "/api/songs/i-got-rhythm/reread"], ["DELETE", "/api/songs/i-got-rhythm"],
    ["POST", "/api/srs/backend", { backend: "anki" }], ["GET", "/api/player/bundles"], ["GET", "/api/lessons"]]) {
    const r = b.rt.api.handle(method, url, body);
    assert.ok(r.status >= 400, `${method} ${url} → ${r.status}`);
    assert.match(String(r.body.detail), /local app/, `${method} ${url}: ${r.body.detail}`);
  }
  assert.deepEqual(b.get("/api/songs/imports").body, []);
  b.rt.socket.send({ type: "lesson_start", lesson: "triads" });   // ignored, like any unknown type
  await settle();
  assert.equal(b.of("error").length, 0);
});

await group("Web MIDI: the keyboard's notes, its name on the chip, an S-1 left out", async () => {
  const { startMidi } = await import("./midi.js");
  const listeners = {};
  const inputs = new Map([
    ["a", { name: "S-1", state: "connected", onmidimessage: null }],
    ["b", { name: "Keystation 49 MK3", state: "connected", onmidimessage: null }],
  ]);
  const access = { inputs, addEventListener: (t, f) => { listeners[t] = f; } };
  const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { requestMIDIAccess: async () => access } });
  const ports = [];
  const notes = [];
  startMidi({ onNote: (on, note, vel) => notes.push([on, note, vel]), onPort: (n) => ports.push(n) });
  await settle();
  assert.deepEqual(ports, ["Keystation 49 MK3"]);
  assert.equal(inputs.get("a").onmidimessage, null, "the S-1 is not the keyboard");
  const key = inputs.get("b").onmidimessage;
  for (const data of [[0x90, 60, 100], [0x91, 64, 80], [0x90, 60, 0], [0x80, 64, 40], [0xb0, 64, 127]]) key({ data });
  assert.deepEqual(notes, [[true, 60, 100], [true, 64, 80], [false, 60, 0], [false, 64, 40]]);
  inputs.get("b").state = "disconnected";
  listeners.statechange();
  assert.equal(ports.at(-1), null, "unplugged → no keyboard");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  startMidi({ onNote() {}, onPort: (n) => ports.push(`safari:${n}`) });
  assert.equal(ports.at(-1), "safari:null", "no Web MIDI → no keyboard");
  if (real) Object.defineProperty(globalThis, "navigator", real);
  else delete globalThis.navigator;
});

// ── B. the real views on the static runtime ───────────────────────────────────
await group("the Practice tab, the song pane and the trainer pane, static", async () => {
  const b = boot();
  installFetch(b.rt.api, { realFetch: async () => { throw new Error("no network in the check"); } });
  const ctx = { ws: b.rt.socket, on: b.rt.socket.on, send: b.rt.socket.send, static: true };
  const practice = await import("../views/practice.js");
  const host = dom.makeEl("main");
  dom.idMap.clear();
  const off = practice.mount(host, ctx);
  await settle();
  await new Promise((r) => setTimeout(r, 30));
  await settle();
  const keys = () => byClass(host, "pr-item").map((n) => n.getAttribute("data-key"));
  const item = (key) => walk(host).find((n) => n.getAttribute && n.getAttribute("data-key") === key);
  // The menu: Review, the eight menu decks, then the Songs group (open by default):
  // + Add song, then every song A–Z.
  const decksAndReview = ["play", "review", "deck:triads", "deck:sevenths", "deck:advanced",
    "deck:two-five-one", "deck:minor-two-five-one", "deck:turnaround", "deck:tritone-sub",
    "deck:backdoor"];
  assert.deepEqual(keys(), [...decksAndReview, "add", "song:i-got-rhythm", "song:jazz-blues-in-f"]);
  const fold = item("songs-group");
  assert.equal(fold.getAttribute("aria-expanded"), "true");
  fold.click();                                             // folded: the songs and + Add song go
  assert.deepEqual(keys(), decksAndReview);
  item("songs-group").click();
  assert.deepEqual(keys(), [...decksAndReview, "add", "song:i-got-rhythm", "song:jazz-blues-in-f"]);

  item("add").click();
  await settle();
  assert.match(one(host, "sg-local").textContent, /Importing a Real Book page needs the local app/);
  assert.equal(byClass(host, "sg-url").length, 0, "no import form on the page");
  assert.equal(walk(host).filter((n) => n.getAttribute && n.getAttribute("data-song")).length, 0,
    "the add page lists no songs: the sidebar is the list");

  item("song:jazz-blues-in-f").click();
  await settle();
  const check = button(host, "Check page");
  assert.ok(check && check.hidden, "Check page is hidden on the static page");
  const steps = one(host, "sg-steps").textContent;
  assert.ok(!/Check the page/.test(steps), steps);
  assert.match(steps, /①Add to review/);
  button(host, "Play through").click();
  button(host, "Start").click();
  await settle();
  assert.equal(one(host, "sg-big").textContent, "F7");
  await play(b, voicing(b));
  await settle();
  assert.equal(one(host, "sg-big").textContent, "B♭7", "the card follows the play-through");
  button(host, "Stop").click();
  await settle();

  walk(host).find((n) => n.getAttribute && n.getAttribute("data-key") === "deck:sevenths").click();
  await settle();
  await new Promise((r) => setTimeout(r, 30));
  button(host, "Start").click();
  await settle();
  assert.equal(walk(host).find((n) => n.getAttribute && n.getAttribute("id") === "chord").textContent, "C7");
  await play(b, voicing(b));
  await settle();
  assert.match(walk(host).find((n) => n.getAttribute && n.getAttribute("id") === "grade").textContent, /speed/);
  off();
});

console.log(`runtime.check.mjs: ok — ${groups} groups over ${path.basename(SITE)}/data `
  + `(${Object.keys(songs).length} songs, ${Object.keys(decks.decks).length} decks)`);
process.exit(0);
