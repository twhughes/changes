// Headless check for views/play.js, the Play landing pane — `node play.check.mjs`.
//
// The pane listens to `held` and sends `note_in` from piano clicks; nothing else. This mounts
// it over dom-stub.mjs with a fake ctx and checks: nothing held is a quiet dash with the how-to
// line; a held chord shows names[0] big, in its root's color; an exact second reading sits
// small beside it and an inexact one never shows; the notes line sits under a named chord;
// one or two notes with no name show the notes themselves, with real ♭/♯; the how-to line
// goes after the visit's first note and is not remembered; the piano lights what is held and
// a click sends note_in; unmount drops every subscription. No buttons, no counters.
// Exit 0 = every assertion held; exit 1 prints the first failure.

import assert from "node:assert/strict";
import { installDom, walk, one, fakeCtx, failFast } from "./dom-stub.mjs";
import { rgbOf, css } from "./colors.js";

failFast("play.check.mjs");
const dom = installDom();
const { makeEl, store } = dom;
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };   // plain values only, never stub nodes

const HINT = "Play your MIDI keyboard, click the keys, or turn on 🎹 Musical typing";
const held = (notes, names = []) => ({ type: "held", notes, pcs: [...new Set(notes.map((n) => n % 12))].sort((a, b) => a - b), names });

const view = await import("./views/play.js");
eq([view.id, view.title], ["play", "Play"], "a pane module: id, title, mount");
const { ctx, sent, fire, live } = fakeCtx();
const host = makeEl("div");
document.body.append(host);
const unmount = view.mount(host, ctx, {});
ok(typeof unmount === "function", "mount returns its unmount");
ok(live() === 2, "it listens to held and to the socket closing, nothing more");
const chord = one(host, "pl-chord");
const name = one(host, "pl-name");
const alt = one(host, "pl-alt");
const notesLine = one(host, "pl-notes");
const hint = one(host, "pl-hint");

// ── 1. before the first note ─────────────────────────────────────────────────────────
ok(name.textContent === "—" && chord.classList.contains("idle"), "nothing held: a quiet dash");
ok(hint.hidden === false && hint.textContent === HINT, "one line says how to play");
ok(alt.hidden && notesLine.hidden, "no second reading, no notes line");
eq(walk(host).filter((n) => ["BUTTON", "SELECT", "INPUT"].includes(n.tagName)).length, 0,
  "nothing to press: no Start, no menus, no switches");
ok(!/\d/.test(walk(host).filter((n) => n.tagName !== "SVG" && !walk(one(host, "pl-keys")).includes(n))
  .map((n) => n.childNodes.filter((c) => c.nodeType === 3).map((c) => c.textContent).join("")).join("")),
  "no numbers off the piano: no counters, no grade, no history");

// ── 2. the piano: C2–C7 at the pane's width, lit by held ──────────────────────────────
const svg = walk(host).find((n) => n.tagName === "SVG") || null;
ok(svg !== null && svg.parentNode === one(host, "pl-keys"), "the piano");
const rects = walk(svg).filter((n) => n.tagName === "RECT");
ok(rects.length === 61, "C2–C7, the trainer's keys");
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);
const isWhite = (n) => WHITE.has(n % 12);
function keyRect(midi) {                 // keyboard.js draws the whites low → high, then the blacks
  let w = 0, b = 0;
  for (let n = 36; n < midi; n++) { if (isWhite(n)) w++; else b++; }
  return isWhite(midi) ? rects[w] : rects[36 + b];
}
const fill = (midi) => keyRect(midi).getAttribute("fill");

// ── 3. a chord with a real second reading ─────────────────────────────────────────────
fire(held([60, 64, 67, 69], [{ name: "C6", exact: true }, { name: "Am7/C", exact: true }]));
ok(name.textContent === "C6" && !chord.classList.contains("idle"), "names[0], big");
ok(alt.hidden === false && alt.textContent === "Am7/C", "an exact second reading: small, beside it");
ok(notesLine.hidden === false && notesLine.textContent === "C4 · E4 · G4 · A4", "the notes, one small line");
ok(hint.hidden, "the first note: the how-to line goes");
ok(name.style.color === css(rgbOf(0), 1), "the name in its root's color (C)");
ok(fill(60) === "#7aa2f7" && fill(69) === "#7aa2f7" && fill(62) === "#ececf0", "the held keys light, the rest do not");

// ── 4. an inexact second reading is noise; names keep real flats and sharps ─────────────
fire(held([60, 64, 67, 71], [{ name: "Cmaj7", exact: true }, { name: "C", exact: false }]));
ok(name.textContent === "Cmaj7" && alt.hidden && alt.textContent === "", "Cmaj7, and no 'C' beside it");
fire(held([60, 63, 66, 70], [{ name: "Cm7b5", exact: true }, { name: "Ebm6/C", exact: true }]));
ok(name.textContent === "Cm7♭5" && alt.textContent === "E♭m6/C", "Cm7♭5 / E♭m6/C, with real flats");
ok(notesLine.textContent === "C4 · E♭4 · F♯4 · B♭4", "the notes too");
ok(fill(63) === "#3f6bd0" && fill(61) === "#1b1b1f", "a held black key lights");
fire(held([66, 70, 73, 76], [{ name: "F#7", exact: true }, { name: "F#", exact: false }]));
ok(name.textContent === "F♯7" && name.style.color === css(rgbOf(6), 1), "F♯7, in F♯'s color");
fire(held([55, 59, 62, 65], [{ name: "G7", exact: true }]));
ok(name.style.color === css(rgbOf(7), 1) && name.style.textShadow !== "", "a dark root (G) gets the chart's light halo");
fire(held([60, 64, 67, 71], [{ name: "Cmaj7", exact: true }]));
ok(name.style.textShadow === "", "a light root does not");

// ── 5. no name: the notes themselves ──────────────────────────────────────────────────
fire(held([64]));
ok(name.textContent === "E4" && chord.classList.contains("pl-bare"), "one note: its name ('E4')");
ok(name.children[0].style.color === css(rgbOf(4), 1), "in its own color");
ok(notesLine.hidden && alt.hidden, "the big line says it: no notes line, no second reading");
fire(held([61]));
ok(name.textContent === "C♯4", "a black key, with a real sharp");
fire(held([60, 64]));
ok(name.textContent === "C4 · E4" && notesLine.hidden, "two notes: both");
fire(held([64, 60]));
ok(name.textContent === "C4 · E4", "low to high, whatever order they arrive in");
fire(held([48, 60]));
ok(name.textContent === "C3 · C4", "two Cs: both, one pitch class has no chord");
fire(held([], [{ name: "C", exact: true }]));
ok(name.textContent === "—" && chord.classList.contains("idle") && !chord.classList.contains("pl-bare"),
  "nothing held (a stale name is ignored): the quiet dash again");
ok(hint.hidden && notesLine.hidden && alt.hidden, "and the how-to line stays gone");
ok(rects.every((r) => r.getAttribute("fill") === "#ececf0" || r.getAttribute("fill") === "#1b1b1f"), "no key lit");

// ── 6. a click on the piano plays, as the trainer's does ───────────────────────────────
const pointer = (type, midi) => {
  for (const f of svg.listeners[type] || []) {
    f({ type, target: midi === undefined ? svg : keyRect(midi), pointerId: 1, clientX: 0, clientY: 5, preventDefault() {} });
  }
};
pointer("pointerdown", 60);
const on = sent.at(-1) || {};
ok(on.type === "note_in" && on.on === true && on.note === 60 && Number.isInteger(on.vel) && on.vel > 0,
  "a key click sends note_in on");
pointer("pointerup");
eq(sent.at(-1), { type: "note_in", on: false, note: 60, vel: 0 }, "release sends note_in off");
pointer("pointerdown", 61);
pointer("pointerup");
eq(sent.slice(-2).map((m) => [m.note, m.on]), [[61, true], [61, false]], "a black key too");

// ── 7. the how-to line is for this visit; nothing is stored ───────────────────────────
eq([...store.keys()], [], "nothing about Play is stored");
const second = makeEl("div");
const offSecond = view.mount(second, ctx, {});
ok(one(second, "pl-hint").hidden, "the same visit, the pane again: no how-to line");
const reloaded = await import("./views/play.js?visit=2");          // a reload: a fresh module
const third = makeEl("div");
const offThird = reloaded.mount(third, ctx, {});
ok(one(third, "pl-hint").hidden === false, "a new visit shows it again");

// ── 8. the socket closing: nothing is known to be held ──────────────────────────────────
fire(held([57, 60, 64, 67], [{ name: "Am7", exact: true }, { name: "C6/A", exact: true }]));
ok(name.textContent === "Am7" && alt.textContent === "C6/A", "Am7 / C6/A");
fire({ type: "_close" });
ok(name.textContent === "—" && alt.hidden && notesLine.hidden && fill(57) === "#ececf0", "disconnected: the dash, no keys lit");

// ── 9. unmount drops every subscription ─────────────────────────────────────────────────
offSecond();
offThird();
unmount();
ok(live() === 0, "unmount removes every subscription");
fire(held([60, 64, 67], [{ name: "C", exact: true }]));
ok(name.textContent === "—", "a held after unmount changes nothing");
ok(dom.domListeners() === 0, "no window or document listeners, ever");

// ── 10. it fits the pane: the stage takes what the piano leaves ──────────────────────────
const style = document.getElementById("play-css").textContent;
ok(/\.pl \{[^}]*height: 100%/.test(style) && /\.pl-stage \{[^}]*flex: 1;[^}]*min-height: 0/.test(style),
  "the pane fills its slot, never more: the page does not scroll");
ok(/\.pl \.pl-keys\.piano-wrap svg\.piano \{ max-width: none/.test(style), "the piano spans the pane's width");

console.log(`play.check.mjs: ok — ${checks} checks, ${sent.length} messages sent`);
