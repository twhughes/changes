// Headless check for views/practice.js (and the 🧠 menu, srs.js) — `node practice.check.mjs`.
//
// The Practice tab is a sidebar — Play, then the tree from GET /api/practice
// (CONTRACTS.md §11) — and a right pane that mounts views/play.js, views/trainer.js or
// views/songs.js. This mounts it over dom-stub.mjs with a fixture menu and a fake
// server, then checks the tree — every element earning its place: Play first (the
// landing when nothing is remembered), Review and the deck groups, then Songs, a group that
// folds (▾/▸, remembered) listing every song A–Z and "+ Add song" last; the only
// numbers are cards due — the panes it mounts, that a running drill picks its owner
// (on mount and when one starts elsewhere), that walking away from a live drill
// stops it, the event-driven refresh, a page dropped on a deck pane, the static page,
// and the 🧠 menu.
// Exit 0 = every assertion held; exit 1 prints the first failure.

import assert from "node:assert/strict";
import { installDom, walk, byClass, one, button, evt, settle, fakeCtx, failFast } from "./dom-stub.mjs";

failFast("practice.check.mjs");
const dom = installDom();
const { makeEl, store, winListeners } = dom;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fixtures ──────────────────────────────────────────────────────────────
const song = (id, title, composer, key, due, inReview = true, checked = "2026-10-01") =>
  ({ id, title, composer, key, checked, flags: 0, phrases: 8, in_review: inReview, due, broken: false });
const SONGS = [
  song("autumn-leaves", "Autumn Leaves", "Joseph Kosma", "G-", 2),
  song("blue-bossa", "Blue Bossa", "Kenny Dorham", "C-", 0),
  song("cherokee", "Cherokee", "Ray Noble", "Bb", 5),
  song("donna-lee", "Donna Lee", "Charlie Parker", "Ab", 0),
  song("giant-steps", "Giant Steps", "John Coltrane", "B", 1),
  song("misty", "Misty", "Erroll Garner", "Eb", 0),
  song("nardis", "Nardis", "Miles Davis", "E-", 0),
  song("oleo", "Oleo", "Sonny Rollins", "Bb", 3),
  song("solar", "Solar", "Miles Davis", "C-", 0),
  song("very-early", "Very Early", "Bill Evans", "C", 0, false, ""),
  song("all-the-things", "all the things you are", "Jerome Kern", "Ab", 0, false),
  { ...song("zz-broken", "Zz Broken", "", "", 0, false, ""), broken: true },
];
const MENU = {
  review: { backend: "local", label: "Built-in", available: true, due: 12 },
  groups: [
    { id: "chords", title: "Chords", decks: [
      { id: "triads", title: "Triads", blurb: "major + minor, all 12 keys", cards: 24,
        in_review: true, due: 3, seedable: true },
      { id: "sevenths", title: "Sevenths", blurb: "maj7 · 7 · m7 · m7♭5, all 12 keys", cards: 48,
        in_review: false, due: 0, seedable: true }] },
    { id: "progressions", title: "Progressions", decks: [
      { id: "two-five-one", title: "ii–V–I", blurb: "in all twelve keys", cards: 12, in_review: true, due: 0,
        seedable: true },
      { id: "minor-two-five-one", title: "minor ii–V–i", blurb: "in all twelve keys", cards: 12,
        in_review: false, due: 0, seedable: false }] },
    { id: "reading", title: "Sight reading", decks: [] },
  ],
  songs: SONGS,
};
const BARS = [["A.1.1", "Cmaj7"], ["A.1.2", "Bb7"], ["A.1.3", "Ebmaj7"], ["A.1.4", "Ab7"]];
const step = ([addr, play], n) => ({ play, symbol: play, addr, slot: 0, n, notes: [48, 64, 67, 71] });
const songJSON = (id, title) => ({
  id, title, composer: "", style: "", time: "3/4",
  beats_per_bar: 3, key: "C", tempo: null, form: ["A"], grade: "core", checked: "", page: null, reads: 0,
  sections: [{ label: "A", lines: [{ n: 1, bars: BARS.map(([addr, sym]) => ({ addr, volta: null, repeat: false,
    text: sym, slots: [{ symbol: sym, beats: 3, play: sym, ok: true }] })) }] }],
  play: BARS.map(([addr], i) => ({ n: i + 1, addr, section: "A", pass: 1 })),
  phrases: [{ id: "A1", section: "A", line: 1, volta: null, name: "A line 1", front: "", back: "", cue: null,
    steps: BARS.map((b) => { const { n, ...s } = step(b, 0); return s; }) }],
  chords: BARS.map(([, play]) => ({ play, symbols: [play], notes: [48, 64, 67, 71] })),
  runs: { all: BARS.map((b, i) => step(b, i + 1)), A: BARS.map((b, i) => step(b, i + 1)) },
  decks: { chords: `song:${id}:chords`, phrases: `song:${id}:phrases`, play: `song:${id}:play`,
    sections: { A: `song:${id}:play:A` } },
  review: { theme: `song:${id}`, backend: "local", label: "Built-in", available: true, cards: 0, due: 0 },
  problems: [], flags: [], updated: "2026-10-03T17:02:11",
});
const IDLE = { active: false, deck: null, idx: -1, total: 0, streak: 0, prompt: null, chord: null, ref: null,
  recall: false, step: 0 };

const server = {
  menu: MENU,
  status: { drill: IDLE },
  srs: { backend: "local", label: "Built-in", available: true, backends: [
    { id: "local", label: "Built-in", available: true, note: "" },
    { id: "anki", label: "Anki", available: false, note: "Anki is closed" }] },
  jobs: 0,
};
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  const path = String(url).split("?")[0];
  calls.push({ method, path, body: opts.body, headers: opts.headers || {} });
  const reply = (status, payload) => {
    const wire = JSON.stringify(payload);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(wire) };
  };
  if (path === "/api/practice") return reply(200, server.menu);
  if (path === "/api/trainer/status") return reply(200, server.status);
  if (path === "/api/trainer/decks") return reply(200, ["triads", "sevenths"]);
  if (path === "/api/srs" && method === "GET") return reply(200, server.srs);
  if (path === "/api/srs/backend" && method === "POST") {
    const { backend } = JSON.parse(opts.body);
    if (!server.srs.backends.some((b) => b.id === backend)) return reply(400, { detail: `unknown backend ${backend}` });
    server.srs = { ...server.srs, backend, label: backend === "anki" ? "Anki" : "Built-in",
      backends: server.srs.backends.map((b) => ({ ...b, available: true, note: "" })) };
    return reply(200, server.srs);
  }
  if (path === "/api/trainer/seed") {
    return reply(200, { backend: "local", deck: "sevenths", added: 48, updated: 0, unchanged: 0, total: 48 });
  }
  if (path === "/api/songs") {
    return reply(200, SONGS.map(({ id, title, composer, key, checked }) => ({ id, title, composer, key, checked })));
  }
  if (path === "/api/songs/imports") return reply(200, []);
  if (path === "/api/songs/import") {
    return reply(200, { job: `j${++server.jobs}`, stage: "queued", message: "waiting", song: null, error: null,
      origin: "page", elapsed_s: 0, done: false });
  }
  const m = /^\/api\/songs\/([^/]+)(\/runs)?$/.exec(path);
  if (m && method === "GET") {
    const s = SONGS.find((x) => x.id === m[1]);
    if (!s) return reply(404, { detail: "no such song" });
    if (s.broken && !m[2]) return reply(422, { detail: "line 3: unknown chord 'Q7'", errors: [] });
    return reply(200, m[2] ? [] : songJSON(s.id, s.title));
  }
  return reply(404, { detail: "no route" });
};
const menuFetches = () => calls.filter((c) => c.path === "/api/practice").length;

const { ctx, sent, fire, live, lastSent } = fakeCtx();

// ── 0. ownerOf: which sidebar item a running deck belongs to ──────────────
const view = await import("./views/practice.js");
assert.equal(view.id, "practice");
assert.equal(view.title, "Practice");
assert.equal(view.ownerOf("song:very-early:play:B"), "song:very-early");
assert.equal(view.ownerOf("song:very-early:phrases"), "song:very-early");
assert.equal(view.ownerOf("review"), "review");
assert.equal(view.ownerOf("review:sevenths"), "review");
assert.equal(view.ownerOf("anki-due"), "review", "the old Anki names are Review too");
assert.equal(view.ownerOf("anki:triads"), "review");
assert.equal(view.ownerOf("triads"), "deck:triads");
assert.equal(view.ownerOf(null), null);

// ── 1. the sidebar: every element earns its place ─────────────────────────
const host = makeEl("main");
document.body.append(host);
const unmount = view.mount(host, ctx);
assert.equal(typeof unmount, "function");
await settle();
assert.ok(host.classList.contains("pr-host"), "the tab takes the wide frame");
const side = one(host, "pr-side");
const pane = one(host, "pr-pane");
const items = () => byClass(side, "pr-item");
const itemFor = (key) => items().find((b) => b.getAttribute("data-key") === key) || null;
const dueOf = (key) => { const d = one(itemFor(key), "pr-due"); return d ? d.textContent : null; };
const lit = () => items().filter((b) => b.classList.contains("on")).map((b) => b.getAttribute("data-key"));
const fold = () => one(side, "pr-fold");
const ALL_AZ = ["song:all-the-things", "song:autumn-leaves", "song:blue-bossa", "song:cherokee", "song:donna-lee",
  "song:giant-steps", "song:misty", "song:nardis", "song:oleo", "song:solar", "song:very-early", "song:zz-broken"];
assert.deepEqual(items().map((b) => b.getAttribute("data-key")), [
  "play", "review",
  "deck:triads", "deck:sevenths", "deck:two-five-one", "deck:minor-two-five-one",
  "add", ...ALL_AZ,
], "Play → Review → the decks → + Add song → every song A–Z (in review or not, broken too)");
assert.deepEqual(byClass(side, "pr-group").map((g) => g.textContent), ["Chords", "Progressions", "▾Songs"],
  "Songs is a group like Chords and Progressions, with a chevron; an empty group is not shown");
assert.equal(fold().getAttribute("aria-expanded"), "true", "open by default");
assert.equal(fold().textContent, "▾Songs", "no number on the header: Review already counts what is due");
assert.ok(itemFor("song:solar") && itemFor("song:very-early"), "no cap, no 'learning' filter");
assert.ok(itemFor("song:cherokee").classList.contains("pr-indent"), "songs sit indented under their header");
assert.equal(dueOf("review"), "12", "Review shows what is due");
assert.equal(itemFor("review").textContent, "Review12", "…and nothing else (the 🧠 menu names the backend)");
assert.equal(itemFor("deck:triads").textContent, "Triads3", "one line per deck, a badge only when due");
assert.equal(itemFor("deck:triads").title, "major + minor, all 12 keys", "the blurb is the tooltip");
assert.equal(dueOf("deck:sevenths"), null);
assert.equal(dueOf("song:cherokee"), "5", "a song shows its due cards…");
assert.equal(itemFor("song:blue-bossa").textContent, "Blue Bossa", "…and nothing when none are due");
assert.equal(itemFor("add").textContent, "+ Add song", "+ Add song heads the group: never a long scroll away");
assert.doesNotMatch(side.textContent, /Built-in|draft|flag|Kosma|checked|All songs|\(\d+\)/,
  "no backend name, no draft · flags · composer lines, no counts");
assert.equal(itemFor("play").textContent, "Play", "Play: one word, no number");
assert.ok(itemFor("play").classList.contains("pr-play") && itemFor("review").classList.contains("pr-review"),
  "Play and Review are the two bold items on top");
assert.match(document.getElementById("practice-css").textContent,
  /\.pr-play \.pr-item-title, \.pr-review \.pr-item-title \{ font-weight: 600; \}/, "…bold, both");
assert.match(itemFor("play").title, /just play/, "its tooltip says what it is");
assert.deepEqual(lit(), ["play"], "nothing remembered → Play");
const paneTitle = () => { const t = pane.querySelector("#t-title"); return t ? t.textContent : null; };
assert.ok(one(pane, "pl") !== null && paneTitle() === null, "the Play pane: no trainer, no Start");
assert.equal(byClass(pane, "pl-hint")[0].textContent,
  "Play your MIDI keyboard, click the keys, or turn on 🎹 Musical typing", "it says how to play");
fire({ type: "held", notes: [57, 60, 64, 67], pcs: [0, 4, 7, 9], names: [{ name: "Am7", exact: true }] });
const playName = one(pane, "pl-name");
assert.equal(playName.textContent, "Am7", "a held chord is named, live");
assert.equal(store.get("music.practice.last"), "play", "Play is remembered like any item");
itemFor("review").click();
await settle();
fire({ type: "held", notes: [60, 64, 67], pcs: [0, 4, 7], names: [{ name: "C", exact: true }] });
assert.equal(playName.textContent, "Am7", "the Play pane is gone, and no longer listens");
assert.deepEqual(lit(), ["review"]);
assert.equal(paneTitle(), "Review", "the Review pane is the trainer, titled");
assert.equal(pane.querySelector("#t-blurb").hidden, true, "no blurb under Review: its idle line says it all");
assert.equal(pane.querySelector("#deck").hidden, true, "no deck picker in the pane");
assert.equal(pane.querySelector("#chord").textContent, "12 cards due — press Start");
pane.querySelector("#start").click();
assert.deepEqual(lastSent(), { type: "start", deck: "review" }, "Start reviews everything due");
fire({ type: "done", deck: "review", summary: { passed: 0, total: 0, mean_latency_s: null }, results: [] });

// ── 2. a deck mounts the trainer with that deck preselected ───────────────
itemFor("deck:triads").click();
await settle();
assert.deepEqual(lit(), ["deck:triads"]);
assert.equal(store.get("music.practice.last"), "deck:triads", "the choice is remembered");
assert.equal(paneTitle(), "Triads");
assert.equal(pane.querySelector("#t-blurb").textContent, "major + minor, all 12 keys", "what Start will drill — no counts");
assert.equal(pane.querySelector("#seed").hidden, true, "already in review: nothing to add");
itemFor("deck:minor-two-five-one").click();
await settle();
assert.equal(pane.querySelector("#seed").hidden, true, "a deck that cannot be seeded offers no Add to review");
itemFor("deck:sevenths").click();
await settle();
assert.equal(pane.querySelector("#seed").hidden, false, "seedable and not in review: Add to review");
let fetchesBefore = menuFetches();
pane.querySelector("#seed").click();
await settle();
assert.deepEqual(JSON.parse(calls.filter((c) => c.path === "/api/trainer/seed").pop().body), { builtin: "sevenths" });
await wait(300);
assert.equal(menuFetches(), fetchesBefore + 1, "Add to review refreshes the due counts");
itemFor("deck:triads").click();
await settle();
pane.querySelector("#start").click();
assert.deepEqual(lastSent(), { type: "start", deck: "triads" }, "Start drills the selected deck");
server.status = { drill: { ...IDLE, active: true, deck: "triads", idx: 0, total: 8, prompt: "Play C", chord: "C" } };
fire({ type: "prompt", idx: 0, total: 8, prompt: "Play C", chord: "C", ref: null, recall: false, staff: null });
await settle();
assert.equal(pane.querySelector("#chord").textContent, "C", "the pane draws its own drill");
assert.deepEqual(lit(), ["deck:triads"], "its own drill never moves the selection");

// ── 3. walking away from a live drill stops it; a song mounts the song pane ─
let sentBefore = sent.length;
itemFor("song:cherokee").click();
await settle();
assert.deepEqual(sent[sentBefore], { type: "stop" }, "leaving a live drill stops it first");
server.status = { drill: IDLE };
fire({ type: "done", deck: "triads", stopped: true, summary: { passed: 0, total: 8, mean_latency_s: null }, results: [] });
let songPane = one(pane, "sg-song");
assert.ok(songPane && songPane.hidden === false, "a song mounts the song pane, opened on that song");
assert.equal(one(songPane, "sg-title").textContent, "Cherokee");
assert.ok(button(songPane, "← Songs") === null, "the sidebar is the way back");
assert.equal(host.classList.contains("sg-host"), false, "the song pane does not resize the tab");
assert.ok(pane.querySelector("#t-title") === null, "the trainer pane is gone");
assert.deepEqual(lit(), ["song:cherokee"]);

// ── 4. the Songs header folds the list away (remembered); folded over the open song, it lights ─
sentBefore = sent.length;
fold().click();
assert.equal(sent.length, sentBefore, "folding is not a selection: nothing stops, nothing remounts");
assert.equal(fold().getAttribute("aria-expanded"), "false");
assert.equal(fold().textContent, "▸Songs");
assert.ok(itemFor("song:cherokee") === null && itemFor("add") === null, "folded: no songs, no + Add song");
assert.ok(fold().classList.contains("on"), "the open song is folded away: the header lights in its place");
assert.equal(one(pane, "sg-title").textContent, "Cherokee", "the pane is untouched");
assert.equal(store.get("music.practice.songsOpen"), "0", "the fold is remembered in this browser");
fold().click();
assert.equal(store.get("music.practice.songsOpen"), "1");
assert.equal(fold().classList.contains("on"), false, "open again: the song itself is lit");
assert.deepEqual(lit(), ["song:cherokee"]);
itemFor("song:very-early").click();
await settle();
assert.equal(one(pane, "sg-title").textContent, "Very Early", "a song not in review opens the same way");
assert.deepEqual(lit(), ["song:very-early"]);
itemFor("song:zz-broken").click();
await settle();
assert.match(one(pane, "sg-fail").textContent, /does not parse/, "a broken song says why…");
assert.deepEqual(lit(), ["song:zz-broken"], "…and the sidebar stays on it");

// ── 5. + Add song: an import page; a finished import's Check it → opens the group ─
itemFor("add").click();
await settle();
const addPage = one(pane, "sg-lib");
assert.equal(addPage.hidden, false);
assert.ok(document.activeElement === one(pane, "sg-url"), "+ Add song: ready to paste a link");
assert.equal(byClass(pane, "sg-search").length + byClass(pane, "sg-row").length, 0,
  "no song list and no search box: the sidebar is the list");
assert.deepEqual(lit(), ["add"]);
fold().click();
assert.ok(fold().classList.contains("on"), "folded over + Add song: the header lights too");
fire({ type: "songs", event: "import", job: "j7", stage: "read", message: "reading", song: null, error: null,
  origin: "early.pdf", elapsed_s: 4, done: false });
fire({ type: "songs", event: "import", job: "j7", stage: "saved", message: "saved", song: "very-early",
  error: null, origin: "early.pdf", elapsed_s: 9, done: true });
button(pane, "Check it →").click();
await settle();
assert.equal(one(pane, "sg-check").hidden, false, "the pane moved itself to the check screen…");
assert.equal(fold().getAttribute("aria-expanded"), "true", "…the program's pick opens the group…");
assert.deepEqual(lit(), ["song:very-early"], "…and the sidebar follows it to the song");
assert.equal(store.get("music.practice.last"), "song:very-early");

// ── 6. a drill started elsewhere selects its owner, and is never stopped for it ─
server.status = { drill: { ...IDLE, active: true, deck: "sevenths", idx: 0, total: 8, streak: 0,
  prompt: "Play E♭m7", chord: "Ebm7" } };
sentBefore = sent.length;
fire({ type: "prompt", idx: 0, total: 8, prompt: "Play E♭m7", chord: "Ebm7", ref: null, recall: false });
await settle();
assert.deepEqual(lit(), ["deck:sevenths"], "the running deck's item is selected");
assert.equal(paneTitle(), "Sevenths");
assert.equal(pane.querySelector("#chord").textContent, "E♭m7", "…and its pane resumes the drill (with a real flat)");
assert.equal(sent.length, sentBefore, "following a drill never stops it");

// ── 7. the sidebar refreshes on songs / done / passed / srs, debounced ─────
fetchesBefore = menuFetches();
fire({ type: "songs", event: "changed", song: "very-early" });
fire({ type: "passed", idx: 0, latency_s: 1, first_try: true, streak: 1 });
fire({ type: "srs", backend: "local" });
await wait(300);
assert.equal(menuFetches(), fetchesBefore + 1, "a burst of events is one refresh");
fire({ type: "songs", event: "receipt", song: "very-early", receipt: { misses: {} } });
await wait(300);
assert.equal(menuFetches(), fetchesBefore + 2);
fire({ type: "songs", event: "import", job: "j8", stage: "read" });
await wait(300);
assert.equal(menuFetches(), fetchesBefore + 2, "an import's progress is not a menu change");

// ── 8. a page dropped on a deck pane goes to + Add song (never navigates away) ─
const png = new File([new Uint8Array([137, 80, 78, 71])], "early.png", { type: "image/png" });
const over = evt({ target: pane, dataTransfer: { types: ["Files"], dropEffect: "none" } });
for (const f of winListeners.dragover) f(over);
assert.ok(over.prevented, "a deck pane still accepts the drop");
const drop = evt({ target: pane, dataTransfer: { files: [png], types: ["Files"], getData: () => "" } });
for (const f of winListeners.drop) f(drop);
assert.ok(drop.prevented);
await settle();
assert.deepEqual(lit(), ["add"], "the drop opens + Add song");
assert.deepEqual(sent[sent.length - 1], { type: "stop" }, "the live sevenths drill was left, so it stopped");
assert.equal(calls.filter((c) => c.path === "/api/songs/import").pop().body, png, "…and imports the page");

unmount();
assert.equal(live(), 0, "unmount removes every subscription, the pane's included");
assert.equal(dom.domListeners(), 0, "…and every window/document listener");
assert.equal(host.classList.contains("pr-host"), false, "…and gives the shell its frame back");

// ── 9. on mount, an active drill picks its owner; otherwise the last choice ─
async function mountWith(drill, last, c = ctx) {
  server.status = { drill };
  if (last) store.set("music.practice.last", last);
  const h2 = makeEl("main");
  const off = view.mount(h2, c);
  await settle();
  const key = byClass(h2, "pr-item").find((b) => b.classList.contains("on")).getAttribute("data-key");
  return { h2, off, key };
}
let m = await mountWith({ ...IDLE, active: true, deck: "song:oleo:play", idx: 0, total: 1, prompt: "x",
  chord: "Cmaj7", ref: "song:oleo:play", step: 2 }, "deck:triads");
assert.equal(m.key, "song:oleo", "a song drill reopens its song");
assert.equal(one(m.h2, "sg-big").textContent, "E♭maj7", "…and the song pane resumes it mid-card");
m.off();
m = await mountWith({ ...IDLE, active: true, deck: "review:sevenths", idx: 1, total: 4, prompt: "y", chord: "Dm7" });
assert.equal(m.key, "review", "review:<theme> belongs to Review");
assert.equal(m.h2.querySelector("#chord").textContent, "Dm7");
m.off();
m = await mountWith(IDLE, "deck:two-five-one");
assert.equal(m.key, "deck:two-five-one", "no drill: the remembered choice");
m.off();
m = await mountWith(IDLE, "song:gone-song");
assert.equal(m.key, "play", "a remembered song that no longer exists falls back to Play");
m.off();
m = await mountWith(IDLE, "songs");
assert.equal(m.key, "play", "the old 'songs' page is gone: a remembered one lands on Play");
m.off();
m = await mountWith(IDLE, "play");
assert.equal(m.key, "play", "a remembered Play restores");
m.off();
m = await mountWith(IDLE, "review");
assert.equal(m.key, "review", "a remembered Review restores");
m.off();
store.delete("music.practice.last");
m = await mountWith(IDLE, null);
assert.equal(m.key, "play", "a first visit lands on Play");
m.off();
const keptStorage = globalThis.localStorage;
globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); },
  removeItem() { throw new Error("blocked"); } };
m = await mountWith(IDLE, null);
assert.equal(m.key, "play", "storage blocked: Play");
m.off();
globalThis.localStorage = keptStorage;
m = await mountWith({ ...IDLE, active: true, deck: "triads", idx: 0, total: 8, prompt: "Play C", chord: "C" }, null);
assert.equal(m.key, "deck:triads", "a running drill still beats the landing");
m.off();
store.set("music.practice.songsOpen", "0");
m = await mountWith(IDLE, "song:misty");
assert.equal(m.key, "song:misty", "a remembered song reopens…");
assert.equal(one(m.h2, "pr-fold").getAttribute("aria-expanded"), "true", "…and opens its folded group");
m.off();
store.set("music.practice.songsOpen", "0");
m = await mountWith(IDLE, "song:zz-broken");
assert.equal(m.key, "song:zz-broken", "even a song that cannot open…");
assert.equal(one(m.h2, "pr-fold").getAttribute("aria-expanded"), "true", "…is shown, its group opened");
m.off();
server.menu = { ...MENU, review: { backend: "anki", label: "Anki", available: false, due: 0 } };
m = await mountWith(IDLE, "review");
assert.equal(m.h2.querySelector("#chord").textContent, "Anki is closed — open it, or pick Built-in in 🧠",
  "a closed backend says what to do, in the pane — not a subtitle in the sidebar");
m.off();
server.menu = MENU;
assert.equal(live(), 0);

// ── 10. the static page: one view, the same sidebar ───────────────────────
server.menu = { ...MENU, songs: SONGS.slice(0, 2).map((x) => ({ ...x, in_review: false, due: 0 })) };
m = await mountWith(IDLE, "add", { ...ctx, static: true });
assert.deepEqual(byClass(m.h2, "pr-item").map((b) => b.getAttribute("data-key")).slice(-3),
  ["add", "song:autumn-leaves", "song:blue-bossa"], "+ Add song, then the demo songs");
const staticAdd = one(m.h2, "sg-lib");
assert.equal(staticAdd.hidden, false, "+ Add song on the static page…");
assert.match(staticAdd.textContent, /Importing a Real Book page needs the local app/, "…says so in one calm line");
assert.equal(byClass(staticAdd, "sg-url").length, 0, "no import form");
m.off();
server.menu = MENU;
assert.equal(live(), 0);

// ── 11. the 🧠 menu: Built-in by default, Anki optional, one WS to keep it true ─
const { mountSrs } = await import("./srs.js");
const sel = makeEl("select");
mountSrs(ctx, sel);
await settle();
// Short labels keep the header select narrow; the reason rides as the option's tooltip.
assert.deepEqual(sel.children.map((o) => o.textContent), ["Built-in", "Anki (closed)"]);
assert.equal(sel.children[1].title, "Anki is closed", "the reason is the tooltip");
assert.deepEqual(sel.children.map((o) => o.disabled), [false, true], "an unavailable backend is disabled");
assert.equal(sel.value, "local");
sel.value = "anki";
await sel.onchange();
await settle();
assert.deepEqual(JSON.parse(calls.filter((c) => c.path === "/api/srs/backend").pop().body), { backend: "anki" });
assert.equal(sel.value, "anki", "the switch took");
fire({ type: "srs", backend: "local" });
assert.equal(sel.value, "local", "another tab's switch shows up here");

console.log("practice.check.mjs: ok — 12 groups, %d requests, %d messages sent", calls.length, sent.length);
