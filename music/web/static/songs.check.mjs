// Headless check for views/songs.js — `node songs.check.mjs`.
//
// Same idea as trainer/player/lessons.check.mjs: a DOM stub (dom-stub.mjs — real
// children, parents and text, because songs.js builds its DOM with createElement),
// a fake ctx and a fake server, then replay what Tyler and the trainer would do.
// The Practice tab is the view's only host (the sidebar lists the songs), so every mount
// here is the embedded one: "+ Add song" (import only) or one song.
// The fixture is CONTRACTS.md §9's Very Early, grown to A (4 lines) · B (4 lines) ·
// Ending (1 line), form A A B Ending, built the way the server builds it (play
// order, phrases with cues and steps, runs, chords, `notes` voicings, review,
// flags, problems; N.C. as an empty symbol, a held bar repeating its chord).
// Exit 0 = every assertion held; exit 1 prints the first failure.

import assert from "node:assert/strict";
import { rgbOf, css } from "./colors.js";
import { chordRootPc } from "./staff.js";
import { installDom, walk, byClass, one, button, evt, settle, fakeCtx, failFast } from "./dom-stub.mjs";

failFast("songs.check.mjs");
const dom = installDom();
const { makeEl, store, intervals, clock, counters, pumpIntervals, fireWin, fireDoc, winListeners } = dom;

// ── the fixture: Very Early, as the server would serve it ────────────────
const SHEET = {
  A: ["Cmaj7 | Bb7 | Ebmaj7 | Ab7",
    "Dbmaj7 | G7 | Cmaj7 | Bb7(#11)",
    "Dmaj7 | A-7 | F#-7 | B7b9",
    "E-9 | Ab7 | Dbmaj7 | 1. G7 | 2. G7#5"],
  B: ["Bmaj7 | Ab7 | Dbmaj7 | Bb7",
    "D-7:2 E-7:1 | Fmaj7:1 G7:2 | % | N.C.",
    "Cmaj7 | Bb7(#11 | Ebmaj7 | Ab7",
    "Dbmaj7 | G7 | Cmaj7 | "],
  Ending: ["Dbmaj7 | G7 | Cmaj7 | %"],
};
const FORM = ["A", "A", "B", "Ending"];
const UNREADABLE = new Set(["Bb7(#11"]);
const DIAL = {   // the server's theory/simplify.py, for exactly these symbols
  core: { "Bb7(#11)": "Bb7", B7b9: "B7", "E-9": "E-7", "G7#5": "G7" },
  triads: { Cmaj7: "C", Bb7: "Bb", Ebmaj7: "Eb", Ab7: "Ab", Dbmaj7: "Db", G7: "G", "Bb7(#11)": "Bb",
    Dmaj7: "D", "A-7": "A-", "F#-7": "F#-", B7b9: "B", "E-9": "E-", "G7#5": "G+", Bmaj7: "B",
    "D-7": "D-", "E-7": "E-", Fmaj7: "F" },
  written: {},
};
/** A stand-in for the server's close voicing: root in octave 3, the rest above middle C. */
function notesFor(play) {
  const pc = chordRootPc(play);
  return pc === null ? [] : [48 + pc, 60 + ((pc + 4) % 12), 60 + ((pc + 7) % 12), 60 + ((pc + 10) % 12)];
}

// Shapes follow music/songs/chart.py song_dict: N.C. is an empty symbol (play null);
// a held (empty) cell carries the previous chord in one slot, with text "".
function buildSong({ grade = "core", checked = "", form = FORM, cards = 0 } = {}) {
  const playOf = (sym) => (!sym || UNREADABLE.has(sym) ? null : DIAL[grade][sym] ?? sym);
  const slot = (sym, beats) => ({ symbol: sym, beats, play: playOf(sym), ok: !UNREADABLE.has(sym) });
  const sections = Object.entries(SHEET).map(([label, rows]) => ({
    label,
    lines: rows.map((row, li) => {
      let prev = [];
      const bars = row.split("|").map((c) => c.trim()).map((cell, bi) => {
        const addr = `${label}.${li + 1}.${bi + 1}`;
        const vm = /^(\d)\.\s*(.*)$/.exec(cell);
        const volta = vm ? Number(vm[1]) : null;
        const body = vm ? vm[2] : cell;
        if (body === "%") return { addr, volta, repeat: true, text: cell, slots: prev.map((s) => ({ ...s })) };
        if (body === "") {
          prev = [slot(prev.length ? prev[prev.length - 1].symbol : "", 3)];
          return { addr, volta, repeat: false, text: "", slots: prev };
        }
        const toks = body.split(/\s+/).map((t) => {
          const m = /^(.*):(\d+)$/.exec(t);
          const sym = m ? m[1] : t;
          return { sym: sym === "N.C." ? "" : sym, beats: m ? Number(m[2]) : null };
        });
        const fixed = toks.reduce((a, t) => a + (t.beats || 0), 0);
        const free = toks.filter((t) => t.beats === null).length;
        const slots = toks.map((t) => slot(t.sym, t.beats ?? (3 - fixed) / free));
        prev = slots;
        return { addr, volta, repeat: false, text: cell, slots };
      });
      return { n: li + 1, bars };
    }),
  }));
  const barAt = new Map(sections.flatMap((s) => s.lines.flatMap((l) => l.bars.map((b) => [b.addr, b]))));
  const play = [];
  const passes = {};
  for (const label of form) {
    const pass = (passes[label] = (passes[label] || 0) + 1);
    const sec = sections.find((s) => s.label === label);
    const last = Math.max(0, ...sec.lines.flatMap((l) => l.bars.map((b) => b.volta || 0)));
    const ending = Math.min(pass, last);
    for (const line of sec.lines) {
      for (const bar of line.bars) {
        if (bar.volta === null || bar.volta === ending) play.push({ n: play.length + 1, addr: bar.addr, section: label, pass });
      }
    }
  }
  // rests and unreadable symbols are skipped; repeats of the same chord merge
  const stepsOver = (entries, withN) => {
    const out = [];
    for (const { addr, n } of entries) {
      barAt.get(addr).slots.forEach((s, i) => {
        if (!s.play || (out.length && out[out.length - 1].play === s.play)) return;
        out.push({ play: s.play, symbol: s.symbol, addr, slot: i, notes: notesFor(s.play), ...(withN ? { n } : {}) });
      });
    }
    return out;
  };
  const phrases = [];
  for (const sec of sections) {
    for (const line of sec.lines) {
      const voltas = [...new Set(line.bars.map((b) => b.volta).filter((v) => v !== null))];
      const variants = (voltas.length ? voltas : [null]).map((v) => ({
        v, addrs: line.bars.filter((b) => v === null || b.volta === null || b.volta === v).map((b) => ({ addr: b.addr })) }));
      const same = variants.length > 1 && new Set(variants.map((x) => stepsOver(x.addrs).map((s) => s.play).join())).size === 1;
      for (const x of same ? [{ v: null, addrs: variants[0].addrs }] : variants) {
        const at = play.findIndex((p) => p.addr === x.addrs[0].addr);
        const before = at < 0 ? [] : stepsOver(play.slice(0, at));
        const steps = stepsOver(x.addrs);
        phrases.push({
          id: `${sec.label}${line.n}${x.v ? `.${x.v}` : ""}`, section: sec.label, line: line.n, volta: x.v,
          name: `${sec.label} line ${line.n}${x.v ? ` · ${x.v === 1 ? "1st" : "2nd"} ending` : ""}`,
          front: `Very Early · ${sec.label} line ${line.n}`, back: steps.map((s) => s.symbol).join(" · "),
          cue: before.length ? before[before.length - 1].play : null, steps,
        });
      }
    }
  }
  const runs = { all: stepsOver(play, true) };
  for (const s of sections) runs[s.label] = stepsOver(play.filter((p) => p.section === s.label && p.pass === 1), true);
  const chords = [];
  for (const st of runs.all) {
    let c = chords.find((x) => x.play === st.play);
    if (!c) chords.push((c = { play: st.play, symbols: [], notes: notesFor(st.play) }));
    if (!c.symbols.includes(st.symbol)) c.symbols.push(st.symbol);
  }
  return {
    id: "very-early", title: "Very Early", composer: "Bill Evans", style: "Medium Waltz", time: "3/4",
    beats_per_bar: 3, key: "C", tempo: null, form: [...form], grade, checked, source: "https://example.org/early.svg",
    page: { url: "/api/songs/very-early/page", mime: "image/svg+xml", name: "early.svg" }, reads: 2,
    sections, play, phrases, chords, runs,
    decks: { chords: "song:very-early:chords", phrases: "song:very-early:phrases", play: "song:very-early:play",
      sections: { A: "song:very-early:play:A", B: "song:very-early:play:B", Ending: "song:very-early:play:Ending" } },
    review: { theme: "song:very-early", backend: "local", label: "Built-in", cards, due: 0 },
    anki: { subdeck: "Music::PianoChords::Songs::Very Early", theme: "anki:song:very-early" },
    problems: [{ addr: "B.3.2", message: "unknown chord quality '(#11'" }],
    flags: [{ addr: "A.4.5", message: "the two reads differ", other: "G7+" }],
    updated: "2026-10-03T17:02:11",
  };
}

// ── fake server ───────────────────────────────────────────────────────────
const IDLE = { active: false, deck: null, idx: -1, total: 0, streak: 0, prompt: null, chord: null,
  ref: null, recall: false, step: 0 };
const server = {
  summaries: [   // what the import rows check against (a saved import of a checked song hides)
    { id: "very-early", title: "Very Early", composer: "Bill Evans", key: "C", time: "3/4",
      checked: "", phrases: 9, chords: 14, problems: 1, flags: 1, updated: "2026-10-03T17:02:11" },
    { id: "autumn-leaves", title: "Autumn Leaves", composer: "Joseph Kosma", key: "G-", time: "4/4",
      checked: "2026-10-01", phrases: 8, chords: 9, problems: 0, flags: 0, updated: "2026-10-01T10:00:00" },
    { id: "blue-bossa", title: "Blue Bossa", composer: "Kenny Dorham", key: "C-", time: "4/4",
      checked: "2026-09-20", phrases: 4, chords: 8, problems: 0, flags: 0, updated: "2026-09-20T10:00:00" },
  ],
  song: buildSong(),
  imports: [   // newest first, as GET /api/songs/imports answers
    { job: "jB", stage: "error", message: "", song: null, error: "no chart found on that page",
      origin: "https://example.org/blog", elapsed_s: 3.1, done: true },
    { job: "j0", stage: "saved", message: "saved Autumn Leaves", song: "autumn-leaves", error: null,
      origin: "autumn.pdf", elapsed_s: 41.2, done: true },
    { job: "jA", stage: "error", message: "", song: null, error: "the file is over 25 MB",
      origin: "huge.tiff", elapsed_s: 0.2, done: true },
  ],
  status: { midi_port: null, drill: IDLE },
  runs: [{ v: 1, song: "very-early", deck: "song:very-early:play", mode: "play", finished: "2026-10-02T21:00:00",
    stopped: false, passed: 1, total: 1, mean_latency_s: 70.1, misses: { "B.1.2": 3 } }],
  seed: 200, bar: 200, text: 200, form: 200, jobs: 0, stamp: 0,
};
const touch = () => { server.song.updated = `2026-10-03T18:00:${String(++server.stamp).padStart(2, "0")}`; };
const rebuild = (changes = {}) => {
  const S = server.song;
  server.song = buildSong({ grade: S.grade, checked: S.checked, form: S.form, cards: S.review.cards, ...changes });
  touch();
};

function route(req) {
  const path = req.url.split("?")[0];
  const body = () => JSON.parse(req.body);
  if (path === "/api/trainer/status") return [200, server.status];
  if (path === "/api/songs" && req.method === "GET") return [200, server.summaries];
  if (path === "/api/songs/imports") return [200, server.imports];
  if (path === "/api/songs/import" && req.method === "POST") {   // the job, as service._public writes it
    const origin = typeof req.body === "string" ? JSON.parse(req.body).url : req.headers["X-Filename"];
    return [200, { job: `j${++server.jobs}`, stage: "queued", message: "waiting for a free reader",
      song: null, error: null, origin, elapsed_s: 0, done: false }];
  }
  const m = /^\/api\/songs\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (m && m[1] === "zz-broken" && req.method === "GET" && !m[2]) {
    return [422, { detail: "line 3: unknown chord 'Q7'", errors: ["line 3: unknown chord 'Q7'"] }];
  }
  const S = server.song;
  if (!m || !S || decodeURIComponent(m[1]) !== S.id) return [404, { detail: "no such song" }];
  const rest = m[2] || "";
  if (!rest && req.method === "GET") return [200, S];
  if (!rest && req.method === "PATCH") {
    const b = body();
    if (b.form !== undefined) {
      const labels = String(b.form).split(/\s+/).filter(Boolean);
      const bad = labels.find((l) => !(l in SHEET));
      if (server.form === 422 || bad) return [422, { detail: `form names [${bad || "Coda"}], which is not in the chart` }];
      rebuild({ form: labels.length ? labels : Object.keys(SHEET) });
    }
    if (b.grade) rebuild({ grade: b.grade });
    if (b.checked === true) rebuild({ checked: "2026-10-03" });
    return [200, server.song];
  }
  if (!rest && req.method === "DELETE") { server.song = null; return [200, { deleted: "very-early" }]; }
  if (rest === "runs") return [200, server.runs];
  if (rest === "seed") {
    if (server.seed === 503) return [503, { detail: "Anki is closed — open Anki (with AnkiConnect) and try again" }];
    S.review.cards = S.phrases.length;
    return [200, { backend: "local", deck: "Very Early", added: S.phrases.length, updated: 0, unchanged: 0,
      total: S.phrases.length }];
  }
  if (rest === "reread") {
    return [200, { job: "r1", stage: "queued", message: "waiting for a free reader", song: "very-early",
      error: null, origin: "early.svg", elapsed_s: 0, done: false }];
  }
  if (rest === "text" && req.method === "GET") return [200, { text: "title: Very Early\n[A]\n| Cmaj7 | Bb7 |\n" }];
  if (rest === "text" && req.method === "PUT") {
    if (server.text === 422) {
      return [422, { detail: "the song text does not parse",
        errors: [{ line: 12, message: "unknown chord 'Q7'" }, "line 14: a bar line must start with |"] }];
    }
    touch();
    return [200, S];
  }
  const bm = /^bar\/(.+)$/.exec(rest);
  if (bm && req.method === "PUT") {
    if (server.bar === 422) return [422, { detail: "unknown chord 'Xyz'" }];
    const addr = decodeURIComponent(bm[1]);
    const bar = S.sections.flatMap((s) => s.lines.flatMap((l) => l.bars)).find((b) => b.addr === addr);
    bar.text = body().text;
    S.flags = S.flags.filter((f) => f.addr !== addr);
    touch();
    return [200, S];
  }
  return [404, { detail: "no route" }];
}

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const req = { method: (opts.method || "GET").toUpperCase(), url: String(url), headers: opts.headers || {},
    body: opts.body };
  calls.push(req);
  const [status, payload] = route(req);
  const wire = payload === undefined ? null : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(wire) };
};
const lastCall = () => calls[calls.length - 1];
const callsTo = (method, path) => calls.filter((c) => c.method === method && c.url.split("?")[0] === path);

const { ctx, sent, fire, live, lastSent } = fakeCtx();

// ── mount: "+ Add song" (no song given) ─────────────────────────────────────
const view = await import("./views/songs.js");
assert.equal(view.id, "songs");
assert.equal(view.title, "Songs");

const host = makeEl("main");
document.body.append(host);
const navLog = [];
const unmount = view.mount(host, ctx, { embedded: true, onNavigate: (n) => navLog.push(n) });
assert.equal(typeof unmount, "function", "mount must return an unmount fn");
await settle();

const lib = one(host, "sg-lib");
const songScreen = one(host, "sg-song");
const checkScreen = one(host, "sg-check");
const chart = () => one(songScreen, "sg-chart");
const barEl = (addr) => byClass(chart(), "sg-bar").find((b) => b.getAttribute("data-addr") === addr);
const symOf = (addr, i = 0) => { const s = byClass(barEl(addr), "sg-slot")[i]; return s ? one(s, "sg-sym") : null; };
const slotOf = (addr, i = 0) => byClass(barEl(addr), "sg-slot")[i];
const card = () => one(songScreen, "sg-card");
const big = () => one(card(), "sg-big").textContent;
const next = () => one(card(), "sg-next").textContent;
const sub = () => one(card(), "sg-sub").textContent;
const steps = () => byClass(card(), "sg-step");
const verdict = () => one(card(), "verdict");
const stepper = () => one(songScreen, "sg-steps");
const stepBtn = (name) => walk(stepper()).find((n) => n.getAttribute("data-step") === name) || null;
const marks = () => byClass(chart(), "sg-mark");
const toggle = (label) => walk(songScreen).find((n) => n.tagName === "LABEL" && n.textContent === label);
const box = (label) => toggle(label).children.find((n) => n.tagName === "INPUT");
const flip = (label, on) => { const b = box(label); b.checked = on; b.onchange(); };
const pc = (n) => css(rgbOf(n), 1);
const modeBtn = (label, scope = songScreen) => button(one(scope, "sg-modebar"), label);
// keyboard.js paints a hinted key in soft gold (white key / black key)
const HINT_FILLS = new Set(["#f0d48c", "#8d6c22"]);
const hinted = () => byClass(one(songScreen, "sg-piano"), "piano")[0]
  ? walk(one(songScreen, "sg-piano")).filter((n) => n.tagName === "RECT" && HINT_FILLS.has(n.getAttribute("fill"))).length
  : 0;

// 1. "+ Add song" is an import page: the URL field (cursor in it), Add, Browse…, the
//    import rows. No list and no search: the sidebar is the list of songs.
assert.equal(lib.hidden, false, "no song given → the add page");
assert.equal(songScreen.hidden, true);
assert.equal(host.classList.contains("sg-host"), false, "the host owns the layout");
assert.ok(document.activeElement === one(lib, "sg-url"), "the cursor waits in the URL field");
assert.ok(button(lib, "Add") && button(lib, "Browse…"), "Add and Browse…");
assert.equal(byClass(lib, "sg-search").length + byClass(lib, "sg-row").length + byClass(lib, "sg-list").length, 0,
  "no song list, no search box");
assert.equal(byClass(lib, "sg-how").length, 0, "no explainer paragraph: the add zone says what to do");
assert.deepEqual(navLog[navLog.length - 1], { song: null, screen: "add" }, "the host hears where the pane is");
assert.equal(callsTo("GET", "/api/songs/imports").length, 1, "GET /api/songs/imports on mount");
assert.equal(callsTo("GET", "/api/trainer/status").length, 1, "a mid-drill mount would resume");
const jobIds = () => byClass(lib, "sg-job").map((r) => r.getAttribute("data-job"));
assert.deepEqual(jobIds(), ["jB", "jA"],
  "past jobs read newest-on-top; a saved import of an already-checked song stays out of the way");
assert.equal(one(byClass(lib, "sg-job")[0], "sg-origin").textContent, "https://example.org/blog", "where it came from");

// 2. Add: a URL posts JSON {url}; junk never leaves the browser.
const urlIn = one(lib, "sg-url");
urlIn.value = "not a link";
button(lib, "Add").click();
await settle();
assert.equal(callsTo("POST", "/api/songs/import").length, 0, "junk is refused inline");
assert.match(one(lib, "sg-add-msg").textContent, /doesn't look like/);
urlIn.value = "https://example.org/real-book/very-early.pdf";
button(lib, "Add").click();
await settle();
let req = lastCall();
assert.equal(req.url, "/api/songs/import");
assert.equal(req.headers["Content-Type"], "application/json");
assert.deepEqual(JSON.parse(req.body), { url: "https://example.org/real-book/very-early.pdf" });
assert.equal(urlIn.value, "", "the field clears once the import is queued");
assert.equal(jobIds()[0], "j1", "the queued job shows a progress row at once, on top");

// 3. drops follow DRAG.md: files first (raw bytes + X-Filename), then URL payloads.
const png = new File([new Uint8Array([137, 80, 78, 71])], "Very Early.png", { type: "image/png" });
fireWin("dragenter", { dataTransfer: { types: ["Files"] } });
assert.equal(one(host, "sg-drop").hidden, false, "a file drag lights the whole view");
let ev = evt({ target: host, dataTransfer: { types: ["Files"], dropEffect: "none" } });
for (const f of winListeners.dragover) f(ev);
assert.ok(ev.prevented, "dragover accepts the drop");
ev = evt({ target: host, dataTransfer: { files: [png], types: ["Files"], getData: () => "" } });
for (const f of winListeners.drop) f(ev);
assert.ok(ev.prevented, "the browser never navigates to a dropped file");
assert.equal(one(host, "sg-drop").hidden, true, "the highlight clears on drop");
await settle();
req = lastCall();
assert.equal(req.body, png, "a dropped File goes up as the raw body");
assert.equal(req.headers["X-Filename"], "Very Early.png");
assert.equal(req.headers["Content-Type"], "image/png");
const accented = new File([new Uint8Array([1])], "Très Tôt.pdf", { type: "application/pdf" });
fireWin("drop", evt({ target: host, dataTransfer: { files: [accented], types: ["Files"], getData: () => "" } }));
await settle();
assert.equal(lastCall().headers["X-Filename"], "Tr%C3%A8s%20T%C3%B4t.pdf", "a non-ASCII name is percent-encoded");
const uriDrop = { types: ["text/uri-list"],
  getData: (t) => (t === "text/uri-list" ? "# from yt\r\nhttp://127.0.0.1:8770/media/early.png\r\n" : "") };
fireWin("drop", evt({ target: host, dataTransfer: { files: [], ...uriDrop } }));
await settle();
assert.deepEqual(JSON.parse(lastCall().body), { url: "http://127.0.0.1:8770/media/early.png" });
const mediaDrop = { types: ["application/x-hq-media"], getData: (t) => (t === "application/x-hq-media"
  ? JSON.stringify({ url: "http://127.0.0.1:8771/f/early.pdf", name: "early.pdf", source: "files" }) : "") };
fireWin("drop", evt({ target: host, dataTransfer: { files: [], ...mediaDrop } }));
await settle();
assert.deepEqual(JSON.parse(lastCall().body), { url: "http://127.0.0.1:8771/f/early.pdf" },
  "application/x-hq-media wins over the plain-text types");
let before = calls.length;
fireWin("drop", evt({ target: host, dataTransfer: { files: [], types: ["text/plain"], getData: () => "just words" } }));
await settle();
assert.equal(calls.length, before, "nothing importable → no request");
assert.match(one(lib, "sg-add-msg").textContent, /Nothing importable/, "…and an inline message, never an alert");

// 4. paste: an image file or a URL imports; text pasted into a field is the field's.
urlIn.focus();
fireDoc("paste", evt({ target: urlIn, clipboardData: { files: [png], getData: () => "" } }));
await settle();
assert.equal(lastCall().body, png, "an image pasted with the cursor in the URL field still imports");
before = calls.length;
fireDoc("paste", evt({ target: urlIn, clipboardData: { files: [], getData: () => "https://example.org/x.pdf" } }));
await settle();
assert.equal(calls.length, before, "a link pasted into the URL field lands there (Enter adds it)");
urlIn.blur();
fireDoc("paste", evt({ target: document.body, clipboardData: { files: [png], getData: () => "" } }));
await settle();
assert.equal(lastCall().body, png, "a pasted image uploads raw");
fireDoc("paste", evt({ target: document.body, clipboardData: { files: [], getData: (t) => (t === "text/plain"
  ? "  https://example.org/early.svg " : "") } }));
await settle();
assert.deepEqual(JSON.parse(lastCall().body), { url: "https://example.org/early.svg" });

// 5. import progress rows: stage + message + a local elapsed tick; saved → Check it; error → red.
fire({ type: "songs", event: "import", job: "j9", stage: "read", message: "reading the page (2 reads)",
  song: null, error: null, origin: "early.png", elapsed_s: 3, done: false });
let row = byClass(lib, "sg-job").find((r) => r.getAttribute("data-job") === "j9");
assert.match(row.textContent, /Reading/);
assert.doesNotMatch(row.textContent, /reading the page/, "while it runs the stage says enough");
assert.equal(one(row, "sg-origin").textContent, "early.png", "…with which page it is");
assert.equal(one(row, "sg-elapsed").textContent, "3 s");
clock.skew += 2000;
pumpIntervals();
row = byClass(lib, "sg-job").find((r) => r.getAttribute("data-job") === "j9");
assert.equal(one(row, "sg-elapsed").textContent, "5 s", "elapsed seconds tick locally");
fire({ type: "songs", event: "import", job: "j9", stage: "queued", message: "waiting", song: null,
  error: null, elapsed_s: 0, done: false });
row = byClass(lib, "sg-job").find((r) => r.getAttribute("data-job") === "j9");
assert.match(row.textContent, /Reading/, "a late, older stage never drags a row back");
fire({ type: "songs", event: "import", job: "j9", stage: "saved", message: "saved Very Early",
  song: "very-early", error: null, elapsed_s: 6.4, done: true });
row = byClass(lib, "sg-job").find((r) => r.getAttribute("data-job") === "j9");
assert.ok(button(row, "Check it →"), "a saved import offers the check screen");
fire({ type: "songs", event: "import", job: "j10", stage: "error", message: "",
  song: null, error: "no chart found on that page", elapsed_s: 2, done: true });
row = byClass(lib, "sg-job").find((r) => r.getAttribute("data-job") === "j10");
assert.ok(row.classList.contains("err"), "a failed import is red");

// 6. "Check it →" opens the check screen for that song; "← Song" goes to its song screen.
button(byClass(lib, "sg-job").find((r) => r.getAttribute("data-job") === "j9"), "Check it →").click();
await settle();
assert.equal(checkScreen.hidden, false, "Check it → lands on the check screen");
assert.deepEqual(navLog[navLog.length - 1], { song: "very-early", screen: "check" },
  "the host hears the pane move (Practice remembers the selection, not this view)");
button(checkScreen, "← Song").click();
await settle();
assert.equal(songScreen.hidden, false);

// 7. the song screen: the stepper, and one box per written bar tinted by root pc.
const headBtn = (label) => button(one(songScreen, "sg-head"), label);
assert.equal(one(songScreen, "sg-title").textContent, "Very Early");
assert.equal(one(songScreen, "sg-meta").textContent, "C · 3/4", "key and time — what playing needs");
assert.ok(button(songScreen, "← Songs") === null, "no way back to a list: the sidebar is the list");
assert.match(stepBtn("check").textContent, /^①Check the page1 bar flagged · 1 unreadable$/, "step ① and why");
assert.equal(stepBtn("review").textContent, "②Add to review", "step ②, nothing to count");
assert.ok(stepBtn("practice") === null, "no step ③: the mode bar is right below");
assert.ok(headBtn("Check page").hidden, "while the steps show, they are the buttons — the header's copy waits");
assert.equal(headBtn("Add to review"), null, "the header never offers Add to review: the stepper does, once");
assert.equal(toggle("as written"), undefined, "no 'as written' switch: the dial covers it, the tooltip shows the page");
assert.equal(byClass(chart(), "sg-bar").length, 37, "17 + 16 + 4 written bars");
assert.deepEqual(marks().map((m) => m.textContent), ["A", "B", "Ending"]);
assert.ok(modeBtn("Play through").classList.contains("on"), "Play through is the default mode");
assert.equal(walk(songScreen).filter((n) => n.tagName === "INPUT" && n.type === "range").length, 0,
  "no fade slider anywhere");
assert.equal(symOf("A.1.1").textContent, "Cmaj7");
assert.equal(symOf("A.1.1").style.color, pc(0), "C is Tyler's C");
assert.equal(symOf("A.1.2").textContent, "B♭7");
assert.equal(symOf("A.1.2").style.color, pc(10), "B♭ takes A♯'s color");
assert.equal(symOf("A.2.4").textContent, "B♭7", "the core dial's target…");
assert.equal(symOf("A.2.4").title, "B♭7(♯11)", "…with the written symbol on hover");
assert.equal(one(barEl("A.4.4"), "sg-volta").textContent, "1.", "first-ending bracket");
assert.equal(symOf("B.2.3").textContent, "%", "a repeat bar shows %");
assert.equal(symOf("B.2.4").textContent, "N.C.", "the server's empty-symbol rest reads N.C.");
assert.ok(symOf("B.4.4") === null, "a held bar is drawn empty, not a second Cmaj7…");
assert.equal(byClass(slotOf("B.4.4"), "sg-beats")[0].children.length, 3, "…but keeps its three beat slashes");
assert.deepEqual(byClass(barEl("B.2.1"), "sg-slot").map((s) => s.style.flexGrow), ["2", "1"], "slots by beats");
assert.ok(symOf("B.3.2").classList.contains("unread"), "an unreadable symbol is marked");
assert.ok(barEl("B.1.2").classList.contains("miss"), "the last session's missed bars show on open");
assert.equal(sub(), "", "…and nothing else about it: the marks are the useful part");

// 8. the dial PATCHes the grade and redraws from the answer.
button(songScreen, "Triads").click();
await settle();
assert.deepEqual(JSON.parse(lastCall().body), { grade: "triads" });
assert.equal(symOf("A.1.1").textContent, "C", "triads: Cmaj7 → C");
button(songScreen, "Core").click();
await settle();
assert.equal(symOf("A.1.1").textContent, "Cmaj7");

// 9. step ② adds the song to review; a closed Anki says what to do.
server.song.review = { ...server.song.review, backend: "anki", label: "Anki", available: false };
touch();
fire({ type: "songs", event: "changed", song: "very-early" });
await settle();
assert.match(stepBtn("review").textContent, /Anki is closed — pick Built-in in 🧠/, "step ② warns before a 503");
server.song.review = { ...server.song.review, backend: "local", label: "Built-in", available: true };
touch();
fire({ type: "songs", event: "changed", song: "very-early" });
await settle();
assert.equal(stepBtn("review").textContent, "②Add to review", "a working backend needs no word");
server.seed = 503;
stepBtn("review").click();
await settle();
assert.match(stepper().textContent, /Anki is closed — open it, or pick Built-in in the 🧠 menu/);
server.seed = 200;
stepBtn("review").click();
await settle();
assert.equal(lastCall().url, "/api/songs/very-early", "a successful add re-reads the song for its review counts");
assert.ok(callsTo("POST", "/api/songs/very-early/seed").length >= 2);
assert.match(stepper().textContent, /Added to review\./, "did it work — not how many");
assert.doesNotMatch(stepper().textContent, /\d+ (cards?|added|updated)/, "no card counts on the stepper");
assert.equal(stepBtn("review").textContent, "✓In review", "step ② is done");
assert.ok(stepBtn("review").classList.contains("done"));

// 10. Chords mode: the target by name, its written forms, its places, Show keys.
modeBtn("Chords").click();
assert.equal(box("Show keys").checked, false, "Chords: Show keys starts off");
assert.equal(toggle("Blind").hidden, true, "Blind belongs to Play through");
button(songScreen, "Start").click();
assert.deepEqual(lastSent(), { type: "start", deck: "song:very-early:chords" });
assert.equal(barEl("B.1.2").classList.contains("miss"), false, "Start clears the old misses");
assert.doesNotMatch(stepper().textContent, /Added to review/, "…and the old status line");
fire({ type: "prompt", idx: 0, total: 14, prompt: "Play B7", chord: "B7", ref: "song:very-early:chord:B7",
  recall: false, level: "loose", staff: null });
assert.equal(big(), "B7");
assert.equal(one(card(), "sg-big").style.color, pc(11));
assert.equal(sub(), "written B7♭9");
assert.ok(slotOf("A.3.4").classList.contains("hit"), "where the chord lives is underlined");
assert.equal(hinted(), 0, "no hint until asked");
flip("Show keys", true);
assert.equal(hinted(), 4, "Show keys lights the chord's voicing");
fire({ type: "prompt", idx: 1, total: 14, prompt: "Play G7", chord: "G7", ref: "song:very-early:chord:G7", recall: false });
assert.equal(sub(), "written G7, G7♯5", "every spelling shows when the dial changed one of them");
button(songScreen, "Stop").click();
assert.deepEqual(lastSent(), { type: "stop" });
fire({ type: "done", deck: "song:very-early:chords", stopped: true,
  summary: { passed: 0, total: 14, mean_latency_s: null }, results: [] });
assert.equal(big(), "Stopped");
assert.equal(sub(), "Passed 0 of 14");
assert.equal(hinted(), 0, "the hint goes when the drill does");

// 11. Phrases: letters only; a recall prompt hides its line, names the cue, fills slot by slot.
modeBtn("Phrases").click();
assert.equal(toggle("Show keys").hidden, true, "no key hints for recall");
assert.equal(byClass(chart(), "sg-sym").length, 0, "Phrases: no chord text anywhere…");
assert.deepEqual(marks().map((m) => m.textContent), ["A", "B", "Ending"], "…but the letters stay");
button(songScreen, "Start").click();
assert.deepEqual(lastSent(), { type: "start", deck: "song:very-early:phrases" });
fire({ type: "prompt", idx: 0, total: 9, prompt: "Very Early · A line 2 (after Ab7)", chord: null,
  ref: "song:very-early:phrase:A2", recall: true, level: "loose", staff: null });
assert.equal(big(), "A line 2");
assert.equal(sub(), "after A♭7");
assert.deepEqual(steps().map((s) => s.textContent), ["?", "?", "?", "?"], "one hidden slot per step");
for (const a of ["A.2.1", "A.2.2", "A.2.3", "A.2.4"]) {
  assert.ok(barEl(a).classList.contains("act"), `${a} is outlined`);
  assert.equal(symOf(a).textContent, "?", `${a} is hidden`);
}
assert.ok(symOf("A.1.1") === null, "the other lines stay letters only");
assert.doesNotMatch(host.textContent, /null/, "a recall item never prints null");
fire({ type: "step", idx: 0, step: 1, of: 4, chord: null });
assert.equal(steps()[0].textContent, "D♭maj7", "a step fills the slot it passed");
assert.equal(symOf("A.2.1").textContent, "D♭maj7", "and the chart reveals it too");
fire({ type: "attempt", idx: 0, latency_s: 2.1, verdict: { ok: false, summary: "G7 ✗  (G B F#) — missing F",
  per_note: [[67, "chord-tone"], [66, "extra"]] } });
assert.equal(verdict().textContent, "G7 ✗  (G B F#) — missing F");
assert.equal(steps()[1].textContent, "G7", "a miss reveals the current slot…");
assert.ok(steps()[1].classList.contains("warn"), "…in the warning color");
assert.ok(symOf("A.2.2").classList.contains("warn"));
fire({ type: "done", deck: "triads", summary: { passed: 5, total: 5, mean_latency_s: 1.2 }, results: [] });
assert.equal(big(), "A line 2", "a done for another deck does not end ours");
fire({ type: "attempt", idx: 0, latency_s: 3.0, verdict: { ok: true, summary: "G7 ✓", per_note: [] } });
fire({ type: "step", idx: 0, step: 3, of: 4, chord: null });
fire({ type: "passed", idx: 0, latency_s: 5.2, first_try: false, streak: 0, review_ease: 2, backend: "local",
  grade: { ease: 2, label: "Hard", accuracy: { tier: "slip", wrong: 1, notes_off: 2 },
    speed: { tier: "ok", latency_s: 5.2 } } });
assert.deepEqual(steps().map((s) => s.textContent), ["D♭maj7", "G7", "Cmaj7", "B♭7"], "passed fills every slot");
assert.match(one(card(), "grade").textContent, /Hard/);
assert.doesNotMatch(one(card(), "grade").textContent, /review ✓/, "the grade is the outcome; no bookkeeping tick");
fire({ type: "prompt", idx: 1, total: 9, prompt: "Very Early · B line 2 (after Bb7)", chord: null,
  ref: "song:very-early:phrase:B2", recall: true });
assert.equal(big(), "B line 2");
assert.equal(steps().length, 6, "the % bar's two chords count as steps");
fire({ type: "step", idx: 1, step: 5, of: 6, chord: null });   // Fmaj7 of the % bar passed, its G7 not
assert.equal(symOf("B.2.3").textContent, "?", "% stands for both chords: half-known is still hidden");
assert.ok(slotOf("B.2.3").classList.contains("cur"), "the cursor sits on the % bar");
// the firehose is global: a foreign prompt and its events are ignored
fire({ type: "prompt", idx: 0, total: 8, prompt: "Autumn Leaves · A line 1 (start)", chord: null,
  ref: "song:autumn-leaves:phrase:A1", recall: true });
assert.equal(big(), "B line 2", "a foreign prompt is never drawn");
const note = verdict().textContent;
fire({ type: "attempt", idx: 0, latency_s: 1, verdict: { ok: false, summary: "foreign ✗", per_note: [] } });
assert.equal(verdict().textContent, note, "a foreign drill's attempt is ignored");
fire({ type: "prompt", idx: 3, total: 20, prompt: "Play C", chord: "C", ref: null, recall: false });
assert.equal(big(), "B line 2", "a ref-less prompt from another deck is ignored too");
assert.equal(button(songScreen, "Start").disabled, false, "the controls are free again");

// 12. Play through: the current chord big, the next two beside it, in song order.
modeBtn("Play through").click();
const runSel = walk(songScreen).find((n) => n.tagName === "SELECT");
assert.deepEqual(runSel.children.map((o) => o.textContent), ["Whole song", "A only", "B only", "Ending only"]);
assert.equal(box("Show keys").checked, true, "Play through: Show keys starts on");
assert.equal(box("Blind").checked, false, "…and Blind off");
button(songScreen, "Start").click();
assert.deepEqual(lastSent(), { type: "start", deck: "song:very-early:play" });
fire({ type: "prompt", idx: 0, total: 1, prompt: "Very Early · play through", chord: "Cmaj7",
  ref: "song:very-early:play", recall: false });
const all = server.song.runs.all;
assert.equal(big(), "Cmaj7", "the current chord, big");
assert.equal(one(card(), "sg-big").style.color, pc(0), "…in its root color");
assert.equal(next(), "then B♭7 → E♭maj7", "the next two beside it");
assert.equal(sub(), "A · bar 1 of 16 · 1st time");
assert.ok(one(card(), "sg-cmeta") === null, "no i/n counter and no streak on the card");
assert.equal(one(card(), "sg-progress").style.width, "0.0%", "how far through: a thin bar");
assert.ok(slotOf("A.1.1").classList.contains("cur"), "the chart's cursor starts on bar 1");
assert.equal(symOf("A.3.1").textContent, "Dmaj7", "not blind: the whole chart shows");
assert.equal(hinted(), 4, "Show keys lights the current voicing");
fire({ type: "step", idx: 0, step: 1, of: all.length, chord: "Bb7" });
assert.equal(big(), "B♭7");
assert.equal(next(), "then E♭maj7 → A♭7");
assert.equal(sub(), "A · bar 2 of 16 · 1st time");
assert.ok(slotOf("A.1.2").classList.contains("cur"), "a step moves the cursor");
assert.ok(slotOf("A.1.1").classList.contains("played"), "what was played dims");
assert.match(one(card(), "sg-progress").style.width, /^[0-9.]+%$/);
flip("Blind", true);
assert.equal(big(), "?", "Blind hides the current chord…");
assert.equal(next(), "", "…and what comes next");
assert.ok(symOf("A.1.2") === null && symOf("A.3.1") === null, "…on the chart too");
assert.equal(symOf("A.1.1").textContent, "Cmaj7", "what was already played stays, dimmed");
assert.equal(hinted(), 0, "Blind turns the key hint off");
assert.equal(box("Show keys").disabled, true);
fire({ type: "attempt", idx: 0, latency_s: 4, verdict: { ok: false, summary: "Bb7 ✗", per_note: [] } });
assert.equal(big(), "B♭7", "a wrong attempt still reveals the chord");
assert.ok(one(card(), "sg-big").classList.contains("warn"));
assert.ok(symOf("A.1.2").classList.contains("warn"));
const second = all.findIndex((s, i) => i > 0 && s.addr === "A.1.1");
fire({ type: "step", idx: 0, step: second, of: all.length, chord: "Cmaj7" });
assert.equal(sub(), "A · bar 1 of 16 · 2nd time", "the second time through A");
assert.ok(symOf("A.2.1") === null, "Blind: the first pass does not leak into the second");
flip("Blind", false);
assert.equal(big(), "Cmaj7");
assert.equal(hinted(), 4, "the hint comes back with the names");
const end = all.findIndex((s) => s.addr.startsWith("Ending"));
fire({ type: "step", idx: 0, step: end, of: all.length, chord: "Dbmaj7" });
assert.equal(sub(), "Ending · bar 1 of 4");
fire({ type: "step", idx: 0, step: all.length - 1, of: all.length, chord: "Cmaj7" });
assert.equal(next(), "", "nothing after the last chord");
fire({ type: "passed", idx: 0, latency_s: 63.2, first_try: false, streak: 0,
  grade: { ease: 1, label: "Again", accuracy: { tier: "rough", wrong: 3, notes_off: 4 },
    speed: { tier: "crawl", latency_s: 63.2 } } });
fire({ type: "done", deck: "song:very-early:play", summary: { passed: 1, total: 1, mean_latency_s: 63.2 }, results: [] });
assert.equal(big(), "Done");
assert.equal(sub(), "Played through in 1:03");
fire({ type: "songs", event: "receipt", song: "very-early", receipt: { v: 1, song: "very-early",
  deck: "song:very-early:play", mode: "play", stopped: false, passed: 1, total: 1, mean_latency_s: 63.2,
  misses: { "A.4.4": 2, "B.3.4": 1 } } });
assert.ok(barEl("A.4.4").classList.contains("miss"), "the receipt marks missed bars");
assert.equal(one(barEl("A.4.4"), "sg-miss").textContent, "×2");
assert.match(sub(), /2 bars missed/);
runSel.value = "B";
runSel.onchange();
button(songScreen, "Start").click();
assert.deepEqual(lastSent(), { type: "start", deck: "song:very-early:play:B" }, "one section on its own");
assert.equal(byClass(chart(), "miss").length, 0, "the next Start clears the marks");
fire({ type: "error", message: "unknown deck 'song:very-early:play:B'" });
assert.equal(verdict().textContent, "unknown deck 'song:very-early:play:B'", "a failed start says why");
assert.equal(button(songScreen, "Start").disabled, false, "and frees the controls");

// 13. the check screen: an input per bar, flags and problems, one-cell PUTs.
button(songScreen, "Check page").click();
assert.equal(checkScreen.hidden, false);
const img = walk(checkScreen).find((n) => n.tagName === "IMG");
assert.equal(img.src, "/api/songs/very-early/page", "the page shows beside the inputs");
const inputs = () => byClass(checkScreen, "sg-in");
const input = (addr) => inputs().find((i) => i.getAttribute("data-addr") === addr);
assert.equal(inputs().length, 37, "one input per written bar");
assert.equal(input("A.4.4").value, "1. G7");
assert.equal(input("B.2.1").value, "D-7:2 E-7:1");
assert.equal(input("B.4.4").value, "");
assert.ok(input("A.4.5").classList.contains("flag"), "a flagged bar is outlined yellow");
assert.ok(input("B.3.2").classList.contains("prob"), "a problem bar is outlined red");
const chip = one(input("A.4.5").parentNode, "sg-chip");
assert.equal(chip.textContent, "other read: G7+");
chip.click();
await settle();
assert.equal(lastCall().url, "/api/songs/very-early/bar/A.4.5");
assert.deepEqual(JSON.parse(lastCall().body), { text: "G7+" });
assert.equal(input("A.4.5").value, "G7+", "the answer re-renders the inputs");
input("A.1.2").value = "Bb7sus";
input("A.1.2").onkeydown({ key: "Enter", preventDefault() {} });
await settle();
assert.deepEqual(JSON.parse(lastCall().body), { text: "Bb7sus" });
assert.equal(document.activeElement.getAttribute("data-addr"), "A.1.3", "Enter moves on to the next bar");
server.bar = 422;
input("A.1.3").value = "Xyz";
input("A.1.3").onblur();
await settle();
assert.ok(input("A.1.3").classList.contains("bad"), "a 422 turns the input red");
assert.equal(input("A.1.3").title, "unknown chord 'Xyz'");
server.bar = 200;
img.onerror();
assert.equal(img.src, "/api/songs/very-early/read/1", "an image this browser can't show falls back to Claude's raster");

// 14. Sections & form: chips in play order; click a section to append, × removes, reset.
const formEl = one(checkScreen, "sg-form");
const formChips = () => byClass(formEl, "sg-fchip").map((c) => c.childNodes[0].textContent);
const secChip = (label) => byClass(formEl, "sg-schip").find((c) => c.getAttribute("data-label") === label);
assert.deepEqual(formChips(), ["A", "A", "B", "Ending"], "the form, in play order");
assert.equal(secChip("A").textContent, "A4 lines · 17 bars");
assert.equal(secChip("Ending").textContent, "Ending1 line · 4 bars");
assert.ok(button(formEl, "Written order"), "a reset when the form is not the written order");
button(byClass(formEl, "sg-fchip")[1], "×").click();
await settle();
assert.equal(lastCall().method, "PATCH");
assert.deepEqual(JSON.parse(lastCall().body), { form: "A B Ending" }, "× drops one occurrence");
assert.deepEqual(formChips(), ["A", "B", "Ending"]);
assert.ok(button(formEl, "Written order") === null, "already the written order");
secChip("A").click();
await settle();
assert.deepEqual(JSON.parse(lastCall().body), { form: "A B Ending A" }, "a section chip appends");
assert.deepEqual(formChips(), ["A", "B", "Ending", "A"], "the chips are the form (the header no longer repeats it)");
button(formEl, "Written order").click();
await settle();
assert.deepEqual(JSON.parse(lastCall().body), { form: "" }, "the reset asks for the written order");
assert.deepEqual(formChips(), ["A", "B", "Ending"]);
server.form = 422;
secChip("B").click();
await settle();
assert.match(one(checkScreen, "sg-form-msg").textContent, /not in the chart/, "a refused form says why, inline");
server.form = 200;
secChip("A").click();
await settle();
assert.ok(one(checkScreen, "sg-form-msg") === null, "the message clears on the next good change");

// 15. edit as text: GET the text, PUT it back, show a 422's error list.
button(checkScreen, "Edit as text").click();
await settle();
const area = walk(checkScreen).find((n) => n.tagName === "TEXTAREA");
assert.match(area.value, /title: Very Early/);
assert.equal(formEl.hidden, true, "the text carries its own form: line");
server.text = 422;
button(checkScreen, "Save").click();
await settle();
assert.match(one(checkScreen, "sg-text-err").textContent, /line 12: unknown chord 'Q7'/);
server.text = 200;
button(checkScreen, "Save").click();
await settle();
assert.equal(one(checkScreen, "sg-textwrap").hidden, true, "a good save returns to the inputs");
assert.equal(formEl.hidden, false);

// 16. re-read: the job's progress rides the same WS events, inline.
button(checkScreen, "Re-read page").click();
await settle();
fire({ type: "songs", event: "import", job: "r1", stage: "compare", message: "comparing the two reads",
  song: "very-early", error: null, elapsed_s: 12, done: false });
assert.match(one(checkScreen, "sg-note").textContent, /Comparing/);
assert.equal(button(checkScreen, "Re-read page").disabled, true, "one re-read at a time");
fire({ type: "songs", event: "import", job: "r1", stage: "saved", message: "saved", song: "very-early",
  error: null, elapsed_s: 14, done: true });
assert.equal(button(checkScreen, "Re-read page").disabled, false);

// 17. Looks right ✓ confirms chords and form; with ② done the steps go away entirely.
button(checkScreen, "Looks right ✓").click();
await settle();
assert.deepEqual(JSON.parse(lastCall().body), { checked: true });
assert.equal(songScreen.hidden, false, "back to the song screen");
assert.ok(stepBtn("check") === null && stepBtn("review") === null, "onboarding done: no steps");
assert.ok(one(stepper(), "sg-ready") === null, "…and no '✓ ready' trophy either");
assert.equal(stepper().textContent, "Checked ✓ — chords and form match the page.", "just the confirmation");
assert.equal(headBtn("Check page").hidden, false, "now the header offers Check page…");
assert.equal(headBtn("Add to review"), null, "…but no Add to review: an edit rewrites a song's cards itself");

// 18. delete asks inline, then trashes and returns to the add page.
button(songScreen, "Check page").click();
button(checkScreen, "Delete song").click();
assert.match(checkScreen.textContent, /Really delete\?/);
button(checkScreen, "No").click();
button(checkScreen, "Delete song").click();
button(checkScreen, "Yes").click();
await settle();
assert.equal(callsTo("DELETE", "/api/songs/very-early").length, 1, "Yes sends the DELETE");
assert.equal(lib.hidden, false, "deleting lands on the add page");
assert.deepEqual(navLog[navLog.length - 1], { song: null, screen: "add" }, "…and the host follows it there");
assert.equal(counters.innerHTML, 0, "songs.js builds its DOM, it never writes innerHTML");

unmount();
assert.equal(live(), 0, "unmount removes every subscription");
assert.equal(dom.domListeners(), 0, "…and every window/document listener");
assert.equal(intervals.size, 0, "…and the elapsed ticker");

// 19. one song as the pane: another song's drill never moves it; it reports its moves.
server.song = buildSong();
server.status = { midi_port: null, drill: { ...IDLE, active: true, deck: "song:autumn-leaves:phrases", idx: 0,
  total: 8, prompt: "Autumn Leaves · A line 1 (start)", ref: "song:autumn-leaves:phrase:A1", recall: true } };
const navs = [];
const paneHost = makeEl("div");
const unmountPane = view.mount(paneHost, ctx, { embedded: true, song: "very-early",
  onNavigate: (n) => navs.push(n) });
await settle();
const paneSong = one(paneHost, "sg-song");
assert.equal(paneSong.hidden, false, "opts.song opens that song — another song's drill never moves the pane");
assert.equal(one(paneSong, "sg-title").textContent, "Very Early");
server.status = { midi_port: null, drill: IDLE };
assert.equal(one(paneHost, "sg-lib").hidden, true, "the add page waits behind the song");
assert.deepEqual(navs[navs.length - 1], { song: "very-early", screen: "song" });
assert.equal(document.activeElement === one(paneHost, "sg-url"), false, "opening a song never grabs the keys");
walk(paneSong).find((n) => n.getAttribute("data-step") === "check").click();
assert.deepEqual(navs[navs.length - 1], { song: "very-early", screen: "check" }, "the host hears the pane move");
unmountPane();

// a drop the host caught on a deck pane is imported as the add page opens
const addHost = makeEl("div");
before = callsTo("POST", "/api/songs/import").length;
const unmountAdd = view.mount(addHost, ctx, { embedded: true, screen: "add", importNow: { files: [png], url: null } });
await settle();
assert.equal(one(addHost, "sg-lib").hidden, false);
assert.equal(callsTo("POST", "/api/songs/import").length, before + 1, "a drop the host caught is imported");
assert.equal(callsTo("POST", "/api/songs/import").pop().body, png);
unmountAdd();

// a song whose text no longer parses: one plain line, and the pane does not move
const brokenNavs = [];
const brokenHost = makeEl("div");
const unmountBroken = view.mount(brokenHost, ctx, { embedded: true, song: "zz-broken",
  onNavigate: (n) => brokenNavs.push(n) });
await settle();
assert.equal(one(brokenHost, "sg-fail").hidden, false, "a song that cannot open says why");
assert.match(one(brokenHost, "sg-fail").textContent, /That song's text does not parse: line 3: unknown chord 'Q7'/);
assert.equal(one(brokenHost, "sg-lib").hidden, true, "…instead of an import page nobody asked for");
assert.deepEqual(brokenNavs, [], "the sidebar stays on the song");
unmountBroken();

// 20. a mid-drill mount resumes mid-card (status.drill.step), from the legacy `run` deck name alone.
server.status = { midi_port: null, drill: { active: true, deck: "song:very-early:run", idx: 0, total: 1,
  streak: 0, prompt: "Very Early · play through", chord: "Cmaj7", ref: null, recall: false, step: 3 } };
const host3 = makeEl("main");
const unmount3 = view.mount(host3, ctx, { embedded: true, song: "very-early" });
await settle();
const song3 = one(host3, "sg-song");
assert.equal(song3.hidden, false, "an active song drill reopens its song");
assert.ok(modeBtn("Play through", song3).classList.contains("on"), "run → Play through");
assert.equal(one(song3, "sg-big").textContent, "A♭7", "resumed on the 4th chord");
assert.equal(one(song3, "sg-next").textContent, "then D♭maj7 → G7");
fire({ type: "hello", status: { drill: IDLE } });
assert.equal(one(song3, "sg-big").textContent, "Stopped", "a restart that lost the drill says so");
unmount3();
assert.equal(live(), 0);

// 21. ⌨ musical typing never eats a letter typed into the URL field (typing.js skips fields).
//     Last: typing.js keeps its window listeners for the life of the page.
const { mountTyping } = await import("./typing.js");
const kbd = makeEl("button");
mountTyping(ctx, kbd);
kbd.click();                                       // typing on
const lib4 = makeEl("div");
const off4 = view.mount(lib4, ctx, { embedded: true, screen: "add" });
await settle();
const box4 = one(lib4, "sg-url");
const sentBefore = sent.length;
const inBox = evt({ key: "a", target: box4 });
for (const f of [...winListeners.keydown]) f(inBox);
assert.equal(inBox.prevented, false, "the letter reaches the URL field");
assert.equal(sent.length, sentBefore, "…and plays no note");
const onPage = evt({ key: "a", target: document.body });
for (const f of [...winListeners.keydown]) f(onPage);
assert.ok(onPage.prevented && lastSent().type === "note_in" && lastSent().on, "outside a field, A still plays");
for (const f of [...winListeners.keyup]) f(evt({ key: "a", target: document.body }));
off4();

// …and its letters sit on the on-screen piano itself — no panel floating over the piano
// (Tyler: "musical keyboard blocks the keyboard display").
const { makePiano } = await import("./keyboard.js");
const pianoHost = makeEl("div");
makePiano(pianoHost, { low: 36, high: 96 });
const typedLetters = () => walk(pianoHost).filter((n) => n.tagName === "TEXT" && /^[A-Z;']$/.test(n.textContent));
const xOfA = () => typedLetters().find((n) => n.textContent === "A").getAttribute("x");
assert.equal(typedLetters().length, 18, "typing on: A … ' — 18 letters on the piano");
assert.equal(walk(document.body).filter((n) => /\bmt\b/.test(n.className || "")).length, 0, "no overlay panel");
const atC4 = xOfA();
for (const f of [...winListeners.keydown]) f(evt({ key: "x", target: document.body }));        // octave up
assert.notEqual(xOfA(), atC4, "Z / X move the letters with the octave");
assert.equal(kbd.textContent, "🎹 Musical typing · C5", "the button says what it is, and the octave");
for (const f of [...winListeners.keydown]) f(evt({ key: "z", target: document.body }));
kbd.click();                                        // typing off
assert.equal(typedLetters().length, 0, "typing off: no letters");

console.log("songs.check.mjs: ok — 21 groups, %d requests, %d messages sent", calls.length, sent.length);
