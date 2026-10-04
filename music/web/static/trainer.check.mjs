// Headless smoke test for views/trainer.js — `node trainer.check.mjs`.
//
// Sight-reading decks (M10) send `staff: {clef, pitches, key}` on the prompt
// instead of a chord name, and the view must paint engraved notes in the same
// slot without disturbing the chord path. This mounts the Trainer over the
// lessons.check.mjs DOM stub and a fake ctx, replays both kinds of prompt, and
// asserts on what landed in the #chord slot.
// Exit 0 = every assertion held; exit 1 prints the first failure.

import assert from "node:assert/strict";

// ── DOM stub ──────────────────────────────────────────────────────────────
const byId = new Map();

function makeEl(tag) {
  const node = {
    tagName: String(tag).toLowerCase(), children: [], style: {}, attrs: {},
    className: "", value: "", type: "", hidden: false, disabled: false,
    onclick: null, _html: "", _text: "",
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
      toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
      contains(c) { return this.set.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") byId.set(String(v), this); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener() {}, removeEventListener() {}, remove() {}, focus() {}, blur() {},
    setPointerCapture() {},
    getBoundingClientRect() { return { top: 0, height: 1 }; },
    click() { if (this.onclick) this.onclick({ preventDefault() {} }); },
    append(...kids) { for (const k of kids) if (k && typeof k === "object") this.children.push(k); },
    replaceChildren(...kids) { this.children = []; this.append(...kids); },
    match(sel) {
      return sel.startsWith(".") ? this.className.split(" ").includes(sel.slice(1))
        : this.tagName === sel;
    },
    querySelector(sel) {
      return sel.startsWith("#") ? byId.get(sel.slice(1)) || null
        : this.children.find((c) => c.match(sel)) || null;
    },
    querySelectorAll(sel) { return this.children.filter((c) => c.match(sel)); },
  };
  // textContent and innerHTML clear each other, as they do in a real element —
  // that is exactly the swap the staff slot performs.
  Object.defineProperty(node, "textContent", {
    get() { return node._text; },
    set(v) { node._text = String(v); node._html = ""; node.children = []; },
  });
  Object.defineProperty(node, "innerHTML", {
    get() { return node._html; },
    set(v) {
      node._html = String(v);
      node._text = "";
      node.children = [];
      // Every tag that carries an id becomes a node with its real tag and attributes
      // (title, hidden, …), flat under its parent — enough for the view's lookups.
      for (const m of node._html.matchAll(/<(\w+)\b([^>]*\bid="[^"]+"[^>]*)>/g)) {
        const child = makeEl(m[1]);
        for (const a of m[2].matchAll(/([\w:-]+)="([^"]*)"/g)) child.setAttribute(a[1], a[2]);
        if (/(^|\s)hidden(\s|$)/.test(m[2])) child.hidden = true;
        node.children.push(child);
      }
    },
  });
  return node;
}

globalThis.document = {
  createElement: makeEl,
  createElementNS: (_ns, tag) => makeEl(tag),
  getElementById: (id) => byId.get(id) || null,
  elementFromPoint: () => null,
  head: { append() {} },
};

// "Show keys" is remembered per browser: a Map stands in for localStorage.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// ── fetch stub ────────────────────────────────────────────────────────────
const DECKS = ["triads", "shells", "reading-treble"];
const calls = [];
let seedStatus = 200;
let statusDrill = { active: false, deck: null, streak: 0, prompt: null, staff: null };
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  calls.push({ path, method: opts.method || "GET", body: opts.body });
  if (path.endsWith("/api/trainer/decks")) {
    return { ok: true, status: 200, json: async () => DECKS };
  }
  if (path.endsWith("/api/trainer/status")) {
    return { ok: true, status: 200, json: async () => ({ drill: statusDrill }) };
  }
  if (path.endsWith("/api/srs")) {
    return { ok: true, status: 200, json: async () => ({ backend: "local", label: "Built-in", available: true,
      backends: [{ id: "local", label: "Built-in", available: true, note: "" },
        { id: "anki", label: "Anki", available: false, note: "Anki is closed" }] }) };
  }
  if (path.endsWith("/api/trainer/seed")) {
    if (seedStatus === 503) return { ok: false, status: 503, json: async () => ({ detail: "Anki is closed" }) };
    return { ok: true, status: 200, json: async () => ({ backend: "local", deck: "triads", added: 24,
      updated: 0, unchanged: 0, total: 24 }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

// ── fake ctx ──────────────────────────────────────────────────────────────
const handlers = new Map();
const sent = [];
const ctx = {
  on(type, cb) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(cb);
    return () => handlers.get(type).delete(cb);
  },
  send(obj) { sent.push(obj); },
};
const fire = (msg) => { for (const cb of [...(handlers.get(msg.type) || [])]) cb(msg); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const $ = (id) => byId.get(id);

// ── mount ─────────────────────────────────────────────────────────────────
const view = await import("./views/trainer.js");
assert.equal(view.id, "trainer");
assert.equal(view.title, "Trainer");

const root = makeEl("main");
const unmount = view.mount(root, ctx);
assert.equal(typeof unmount, "function", "mount must return an unmount fn");
await tick();
await tick();

// 1. the deck picker loaded and nothing is running yet.
assert.equal($("deck").children.length, 3, "one option per deck");
assert.equal($("start").disabled, false);
assert.equal($("skip").disabled, true);

// 2. a chord prompt still writes text, and no SVG.
fire({ type: "prompt", idx: 0, total: 8, prompt: "Play Dm7", chord: "Dm7", staff: null });
assert.equal($("chord").textContent, "Dm7");
assert.equal($("chord").innerHTML, "", "a chord prompt paints no staff");
assert.equal($("chord").className, "chord");
assert.equal($("prompt").textContent, "Play Dm7");
assert.equal($("progress").style.width, "0.0%", "progress is a bar on the card's edge, no numbers");
assert.equal(byId.get("streak"), undefined, "no streak counter: it asks nothing of Tyler");
assert.equal(byId.get("latency"), undefined, "no last-latency counter either (the grade line has the speed)");
assert.equal($("skip").disabled, false, "a prompt puts the view in the running state");

// 3. a sight-reading prompt paints the staff in the same slot.
fire({ type: "prompt", idx: 1, total: 8, prompt: "Play the note on the staff",
       chord: null, staff: { clef: "treble", pitches: [64], key: "C" } });
assert.match($("chord").innerHTML, /<svg/, "a staff prompt renders an SVG");
assert.match($("chord").innerHTML, /class="staff"/, "and it is staffSVG's output");
assert.match($("chord").innerHTML, /class="note"/, "with a notehead on it");
assert.equal($("chord").textContent, "", "the chord name is gone while a staff shows");
assert.equal($("chord").className, "chord staff");
assert.equal($("prompt").textContent, "Play the note on the staff",
  "the prompt line is unchanged by staff mode");

// 4. bass clef and a two-note dyad go through the same path.
fire({ type: "prompt", idx: 2, total: 8, prompt: "Play the interval",
       chord: null, staff: { clef: "bass", pitches: [41, 45], key: "F" } });
assert.match($("chord").innerHTML, /<svg/);
assert.equal($("chord").innerHTML.match(/class="note"/g).length, 2, "both notes are drawn");

// 5. the verdict path is untouched by staff items.
fire({ type: "attempt", verdict: { ok: false, summary: "E4 ✗ (D4) — missing E4",
       per_note: [[62, "extra"]] } });
assert.equal($("verdict").textContent, "E4 ✗ (D4) — missing E4");
assert.equal($("verdict").className, "verdict no");
assert.match($("chord").innerHTML, /<svg/, "an attempt leaves the staff standing");

// 6. going back to a chord deck drops the staff again.
fire({ type: "prompt", idx: 3, total: 8, prompt: "Play G7", chord: "G7", staff: null });
assert.equal($("chord").textContent, "G7");
assert.equal($("chord").innerHTML, "");

// 7. a client that missed the live prompt resumes the staff from hello.
fire({ type: "hello", status: { drill: { active: true, idx: 4, total: 8, streak: 2,
       prompt: "Play the note on the staff", chord: null,
       staff: { clef: "treble", pitches: [67], key: "G" } } } });
assert.match($("chord").innerHTML, /<svg/, "hello resumes a pitch item as a staff");
assert.equal($("progress").style.width, "50.0%");

// 8. done clears the slot back to text.
fire({ type: "done", deck: "reading-treble", summary: { passed: 7, total: 8, mean_latency_s: 1.4 } });
assert.equal($("chord").textContent, "session over");
assert.equal($("chord").innerHTML, "");
assert.equal($("start").disabled, false, "done releases the controls");

unmount();
const live = [...handlers.values()].reduce((n, set) => n + set.size, 0);
assert.equal(live, 0, "unmount removes every subscription");

// 9. embedded in the Practice pane: one fixed deck, its title instead of the
//    picker, only its own drill drawn, "Add to review" naming the backend.
statusDrill = { active: true, deck: "shells", idx: 1, total: 8, streak: 2, prompt: "Play Ebm7 shell",
  chord: "Ebm7", staff: null };
const pane = makeEl("div");
const unmountPane = view.mount(pane, ctx, { embedded: true, deck: "triads", title: "Triads",
  blurb: "major + minor, all 12 keys", idle: "Press Start" });
await tick();
await tick();
assert.equal($("deck").hidden, true, "embedded: no deck picker");
assert.equal($("t-head").hidden, false);
assert.equal($("t-title").textContent, "Triads");
assert.equal($("t-blurb").textContent, "major + minor, all 12 keys");
assert.equal($("chord").textContent, "Press Start", "another deck's running drill is not resumed here");
assert.equal($("start").disabled, false);
statusDrill = { active: false, deck: null, streak: 0, prompt: null, staff: null };
assert.equal(calls.some((c) => c.path.endsWith("/api/trainer/decks")), true, "(the standalone mount listed decks)");
const deckCalls = calls.filter((c) => c.path.endsWith("/api/trainer/decks")).length;
fire({ type: "prompt", idx: 0, total: 8, prompt: "Play Dm7", chord: "Dm7", staff: null });
assert.equal($("chord").textContent, "Press Start", "a drill this pane did not start is not drawn");
$("start").click();
assert.deepEqual(sent[sent.length - 1], { type: "start", deck: "triads" }, "Start drills the pane's deck");
fire({ type: "prompt", idx: 0, total: 8, prompt: "Play C", chord: "C", staff: null });
assert.equal($("chord").textContent, "C", "its own drill is drawn");
fire({ type: "passed", idx: 0, latency_s: 1.2, first_try: true, streak: 1, review_ease: 3, backend: "local",
  grade: { ease: 3, label: "Good", accuracy: { tier: "clean", wrong: 0, notes_off: 0 },
    speed: { tier: "ok", latency_s: 1.2 } } });
assert.match($("grade").innerHTML, /Good/, "a pass shows its grade");
assert.doesNotMatch($("grade").innerHTML, /review ✓/, "no bookkeeping tick: the grade is the outcome");
assert.match($("seed").title, /Built-in/, "the button names the backend it writes to");
$("seed").click();
await tick();
await tick();
const seedCall = calls.filter((c) => c.path.endsWith("/api/trainer/seed")).pop();
assert.deepEqual(JSON.parse(seedCall.body), { builtin: "triads" });
assert.equal($("verdict").textContent, "triads → review (Built-in): 24 added");
seedStatus = 503;
$("seed").click();
await tick();
await tick();
assert.equal($("verdict").textContent, "Anki is closed — open it, or pick Built-in in the 🧠 menu");
fire({ type: "done", deck: "triads", summary: { passed: 8, total: 8, mean_latency_s: 1.1 } });
assert.match($("summary").innerHTML, /<h3>Triads<\/h3>/, "the summary names the deck by its title");
fire({ type: "prompt", idx: 0, total: 5, prompt: "Play G7", chord: "G7", staff: null });
assert.equal($("chord").textContent, "session over", "after done, a later drill is someone else's");
assert.equal(calls.filter((c) => c.path.endsWith("/api/trainer/decks")).length, deckCalls,
  "embedded never lists decks");
unmountPane();

// 9b. a Start that fails ("no cards due") leaves the pane idle: a later drill is not its own.
const idlePane = makeEl("div");
const unmountIdle = view.mount(idlePane, ctx, { embedded: true, deck: "review", title: "Review", idle: "Nothing due" });
await tick();
await tick();
$("start").click();
fire({ type: "error", message: "no cards due" });
assert.equal($("verdict").textContent, "no cards due");
fire({ type: "prompt", idx: 0, total: 3, prompt: "Play A7", chord: "A7", staff: null });
assert.equal($("chord").textContent, "Nothing due", "after a failed start, another drill is not drawn here");
unmountIdle();

// 10. a Review pane resumes a review drill already running, and has nothing to add.
statusDrill = { active: true, deck: "review:shells", idx: 2, total: 6, streak: 1,
  prompt: "Play E♭m7 shell", chord: "Ebm7", staff: null };
const reviewPane = makeEl("div");
const unmountReview = view.mount(reviewPane, ctx, { embedded: true, deck: "review", title: "Review" });
await tick();
await tick();
assert.equal($("chord").textContent, "E♭m7", "review:<theme> belongs to the Review pane");
assert.equal($("chord").getAttribute("data-raw"), "Ebm7", "the raw name stays readable");
assert.equal($("progress").style.width, "33.3%");
assert.equal($("seed").hidden, true, "a review session has nothing to add");
unmountReview();

// 11. a deck already in review has nothing left to add; Review shows no empty blurb line.
statusDrill = { active: false, deck: null, streak: 0, prompt: null, staff: null };
const inPane = makeEl("div");
const unmountIn = view.mount(inPane, ctx, { embedded: true, deck: "triads", title: "Triads", blurb: "major + minor",
  inReview: true });
await tick();
await tick();
assert.equal($("seed").hidden, true, "already in review: no Add to review");
unmountIn();
const revPane = makeEl("div");
const unmountRev = view.mount(revPane, ctx, { embedded: true, deck: "review", title: "Review" });
await tick();
assert.equal($("t-blurb").hidden, true, "no blurb, no empty line");
unmountRev();

// 12. Show keys: off by default, remembered; lights prompt.notes and step.notes; a card
//     with no voicing (a phrase in Review: notes null) hides the switch; done clears it.
const HINT_FILLS = new Set(["#f0d48c", "#8d6c22"]);       // keyboard.js's soft gold, white / black key
const lit = () => {
  const svg = $("piano").children[0];
  return svg.children.filter((n) => HINT_FILLS.has(n.getAttribute("fill"))).length;
};
const realStore = globalThis.localStorage;
globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
const blocked = view.mount(makeEl("div"), ctx, { embedded: true, deck: "triads", title: "Triads" });
await tick();
assert.equal($("keys").checked, false, "storage blocked: off, and no crash");
$("keys").checked = true;
$("keys").onchange();                              // must not throw either
blocked();
globalThis.localStorage = realStore;
const keysPane = makeEl("div");
let unmountKeys = view.mount(keysPane, ctx, { embedded: true, deck: "triads", title: "Triads" });
await tick();
await tick();
assert.equal($("keys-lbl").hidden, false, "the switch sits beside Start / Skip / Stop");
assert.equal($("keys-lbl").getAttribute("title"), "light the chord's keys on the piano — a hint; any voicing passes");
assert.equal($("keys").checked, false, "off by default");
$("start").click();
fire({ type: "prompt", idx: 0, total: 4, prompt: "Play C", chord: "C", staff: null, notes: [48, 64, 67] });
assert.equal(lit(), 0, "off: no hint");
$("keys").checked = true;
$("keys").onchange();
assert.equal(lit(), 3, "on: the card's voicing lights");
assert.equal(store.get("music.trainer.showKeys"), "1", "remembered in this browser");
fire({ type: "prompt", idx: 1, total: 4, prompt: "Play the ii–V–I", chord: "Dm7", staff: null,
  notes: [50, 65, 69, 72] });
assert.equal(lit(), 4, "every prompt brings its own voicing");
fire({ type: "step", idx: 1, step: 1, of: 3, chord: "G7", notes: [43, 65, 71] });
assert.equal(lit(), 3, "a progression's step lights the next chord");
fire({ type: "prompt", idx: 2, total: 4, prompt: "Very Early · A line 2 (after A♭7)", chord: null, staff: null,
  notes: null, recall: true });
assert.equal($("keys-lbl").hidden, true, "a card with no voicing hides the switch");
assert.equal(lit(), 0, "…and lights nothing");
fire({ type: "prompt", idx: 3, total: 4, prompt: "Play G7", chord: "G7", staff: null, notes: [43, 59, 62, 65] });
assert.equal($("keys-lbl").hidden, false);
assert.equal(lit(), 4);
fire({ type: "done", deck: "triads", summary: { passed: 4, total: 4, mean_latency_s: 1.0 } });
assert.equal(lit(), 0, "done (or stop) clears the hint");
unmountKeys();
unmountKeys = view.mount(makeEl("div"), ctx, { embedded: true, deck: "triads", title: "Triads" });
await tick();
assert.equal($("keys").checked, true, "a new pane keeps the choice");
$("keys").checked = false;
$("keys").onchange();
assert.equal(store.get("music.trainer.showKeys"), "0");
unmountKeys();
assert.equal([...handlers.values()].reduce((n, set) => n + set.size, 0), 0, "every pane unsubscribes");

// 13. names read with real flats and sharps — the big chord, the step line, the prompt line —
//     while data-raw keeps what the server sent.
const flatPane = makeEl("div");
const unmountFlat = view.mount(flatPane, ctx, { embedded: true, deck: "advanced", title: "Advanced" });
await tick();
$("start").click();
fire({ type: "prompt", idx: 0, total: 3, prompt: "Play Dbm7b5 — any voicing", chord: "Dbm7b5", staff: null,
  notes: [49, 64, 67, 71] });
assert.equal($("chord").textContent, "D♭m7♭5", "the big chord");
assert.equal($("chord").getAttribute("data-raw"), "Dbm7b5");
assert.equal($("prompt").textContent, "Play D♭m7♭5 — any voicing", "the prompt line, word by word");
assert.equal($("prompt").getAttribute("data-raw"), "Play Dbm7b5 — any voicing");
fire({ type: "step", idx: 0, step: 1, of: 2, chord: "F#7#5", notes: [42, 61, 64, 70] });
assert.equal($("chord").textContent, "F♯7♯5");
assert.equal($("verdict").textContent, "✓ step 1/2 — next: F♯7♯5", "the step line");
fire({ type: "prompt", idx: 1, total: 3, prompt: "Play Gbdim7", chord: "Gbdim7", staff: null, notes: [42, 60, 63, 69] });
assert.equal($("chord").textContent, "G♭dim7");
fire({ type: "prompt", idx: 2, total: 3, prompt: "Play Abmaj7/Eb", chord: "Abmaj7/Eb", staff: null, notes: null });
assert.equal($("chord").textContent, "A♭maj7/E♭", "a slash bass too");
unmountFlat();
assert.equal([...handlers.values()].reduce((n, set) => n + set.size, 0), 0);

console.log("trainer.check.mjs: ok — 14 groups, %d messages sent", sent.length);
