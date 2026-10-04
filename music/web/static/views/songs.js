// Songs view (CONTRACTS.md §9): a Real Book page goes in, the changes come out,
// and the song gets three practice modes.
//
//   Add      import only: the URL field, Add, Browse…, drop / paste anywhere
//            (POST /api/songs/import, DRAG.md receiver order), and the progress rows.
//            The Practice sidebar is the list of songs.
//   Song     an onboarding stepper (① check the page → ② add to review) while either is open,
//            the chart as HTML bar boxes — chord text in Tyler's root-pc colors
//            (colors.js) — the grading dial, and the drill: Chords / Phrases /
//            Play through over the trainer's own messages (start/skip/stop →
//            prompt/step/attempt/passed/done), scoped to the deck this view started.
//   Check    the page beside one input per bar (an edit PUTs that one cell back),
//            and the Sections & form editor (PATCH {form}).
//
// Play through (v2): the song in order, a flashcard row — the current chord big,
// the next two beside it. "Show keys" lights the step's voicing (`notes`, computed
// by the server) as a piano hint; "Blind" hides the names (a miss still shows one).
//
// The browser only renders. It never parses or grades a chord: chordRootPc tints
// text, nothing more. Recall cards arrive with chord: null by design — the view
// resolves `ref` against the song JSON and decides what stays hidden.
//
// The trainer firehose is global, so every drill event is claimed before it is
// drawn: a prompt is ours only when its ref names this song (or, ref-less, while
// our own start is in flight); step/attempt/passed only while ours is live.
//
// mount(el, ctx, opts) — the Practice tab (views/practice.js) is its only host, and the
// view fills the pane it is given:
//   opts.song        open that song (otherwise: the add page, cursor in the URL field)
//   opts.onNavigate  ({song, screen}) when the view moves itself (Check it →, delete)
//   opts.importNow   {files, url} a drop the host caught, imported on mount
//   opts.onChange    () after "Add to review" (the host's due counts moved)
//
// On the static page (ctx.static, CONTRACTS.md §12) there is no server to read a page or
// write a chart: importing, the check screen and its edits each answer one calm line
// instead; the dial, review, drills and receipts work as here.

import { makePiano } from "../keyboard.js";
import { rgbOf, css } from "../colors.js";
import { chordRootPc } from "../staff.js";

export const id = "songs";
export const title = "Songs";

const API = "/api/songs";
const DIALS = [
  ["core", "Core", "root + chord type; tensions drop off (B7♭9 → B7)"],
  ["written", "As written", "every chord exactly as the page writes it"],
  ["triads", "Triads", "root + major / minor / dim / aug / sus"],
];
const MODES = [["chords", "Chords"], ["phrases", "Phrases"], ["play", "Play through"]];
const HINT = {
  chords: "Each chord of the tune, shuffled. Play it.",
  phrases: "Each written line from memory, cued by the chord before it.",
  play: "The song in order: see the chord, play it, move on.",
};
const LOCAL_IMPORT = "Importing a Real Book page needs the local app — see the README.";
const LOCAL_CHECK = "Checking a chart against its page needs the local app — see the README.";
const STAGES = {
  queued: "Queued", fetch: "Fetching", normalize: "Preparing", read: "Reading",
  compare: "Comparing", saved: "Saved", error: "Failed",
};
// grade tiers → traffic-light classes (mirrors learn/grading.py, as trainer.js does)
const TIER = {
  clean: "t-good", slip: "t-warn", rough: "t-bad", fail: "t-bad",
  fast: "t-good", ok: "t-good", slow: "t-warn", crawl: "t-bad",
  Easy: "t-good", Good: "t-good", Hard: "t-warn", Again: "t-bad",
};
// `run` is the legacy name of a play-through (§9): both resolve to Play through.
const KIND_MODE = { phrase: "phrases", run: "play", play: "play", chord: "chords" };
const NC = /^(N\.?C\.?|NC|-)$/i;
const PROPS = new Set(["value", "type", "title", "placeholder", "disabled", "hidden", "checked",
  "min", "max", "step", "src", "href", "alt", "accept", "multiple", "spellcheck",
  "autocomplete", "target", "rel"]);

const CSS = `
.sg [hidden] { display: none !important; }
.sg { height: 100%; }
.sg-spacer { flex: 1; }
.sg-lbl { color: var(--dim); font-size: 12px; letter-spacing: .03em; }
.sg .btn { padding: 5px 12px; font-size: 13px; }
.sg .btn.on { border-color: var(--accent); }
.sg-link { background: none; border: 0; padding: 0; color: var(--accent); font: inherit; cursor: pointer; }
.sg-link:hover { text-decoration: underline; }
.sg .is-ok { color: var(--good); }
.sg .is-err { color: var(--bad); }

.sg-seg { display: inline-flex; gap: 2px; padding: 2px; background: #1a1a1e;
  border: 1px solid var(--line); border-radius: 8px; }
.sg-seg button { background: none; border: 0; border-radius: 6px; color: var(--dim); font: inherit;
  font-size: 13px; padding: 4px 11px; cursor: pointer; }
.sg-seg button:hover:not(:disabled) { color: var(--ink); }
.sg-seg button.on { background: #262b38; color: var(--ink); font-weight: 600;
  box-shadow: inset 0 0 0 1px rgba(122,162,247,.5); }
.sg-seg button:disabled { opacity: .4; cursor: default; }

/* ── library ─────────────────────────────────────────────── */
.sg-lib { max-width: 760px; }
.sg-add { border: 1px dashed #36363f; border-radius: 10px; padding: 8px 10px; background: var(--panel);
  margin-bottom: 10px; }
.sg-add-row { display: flex; gap: 8px; }
.sg-url { flex: 1; min-width: 0; background: #1e1e23; color: var(--ink); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 12px; font: inherit; font-size: 14px; }
.sg-url:focus, .sg-in:focus, .sg-text:focus { outline: none; border-color: var(--accent); }
.sg-add-msg { margin-top: 6px; font-size: 13px; color: var(--dim); }
.sg-add-msg:empty { display: none; }
.sg-jobs { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.sg-jobs:empty { display: none; }
.sg-job { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border: 1px solid var(--line);
  border-radius: 8px; background: #141417; font-size: 13px; }
.sg-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.sg-job.busy .sg-dot { animation: sg-pulse 1.1s ease-in-out infinite; }
.sg-job.ok .sg-dot { background: var(--good); }
.sg-job.err .sg-dot { background: var(--bad); }
.sg-stage { font-weight: 600; min-width: 74px; }
.sg-jmsg { flex: 1; min-width: 0; color: var(--dim); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.sg-job.err .sg-jmsg { color: var(--bad); white-space: normal; }
.sg-origin { max-width: 32%; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-elapsed { color: var(--dim); font-variant-numeric: tabular-nums; }
.sg-x { background: none; border: 0; color: #66666f; font-size: 16px; line-height: 1; padding: 0 2px;
  cursor: pointer; }
.sg-x:hover { color: var(--ink); }
@keyframes sg-pulse { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
.sg-empty { color: var(--dim); padding: 14px 10px; font-size: 14px; }

/* ── song + check share the full-height frame ─────────────── */
.sg-song, .sg-check { display: flex; flex-direction: column; gap: 8px; height: 100%;
  min-height: 440px; }
.sg-song > *, .sg-check > * { flex: none; }
.sg-head { display: flex; align-items: center; gap: 10px; min-height: 34px; }
.sg-titles { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.sg-title { font-size: 20px; font-weight: 600; letter-spacing: -.01em; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.sg-meta { font-size: 13px; color: var(--dim); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.sg-note { display: flex; align-items: center; gap: 16px; min-height: 18px; font-size: 13px;
  color: var(--dim); }
.sg-note > span, .sg-steps > span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* the onboarding stepper: one line while onboarding is open, gone once it is done */
.sg-steps { display: flex; align-items: center; gap: 8px; min-height: 24px; font-size: 13px; color: var(--dim); }
.sg-stp { display: inline-flex; align-items: baseline; gap: 6px; padding: 2px 11px; border-radius: 999px;
  border: 1px solid #34343c; background: #18181c; color: var(--ink); font: inherit; font-size: 13px;
  cursor: pointer; white-space: nowrap; }
.sg-stp:hover { border-color: var(--accent); }
.sg-stp .n { color: var(--accent); font-weight: 700; }
.sg-stp .d { color: var(--dim); font-size: 12px; }
.sg-stp.done { border-color: transparent; background: none; color: var(--dim); }
.sg-stp.done .n { color: var(--good); }
.sg-stp-sep { color: #45454d; }

.sg-modebar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sg .sg-runsel { padding: 4px 10px; font-size: 13px; }
.sg-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dim);
  cursor: pointer; user-select: none; }
.sg-toggle input { margin: 0; accent-color: var(--accent); }
.sg-toggle input:disabled + span { opacity: .45; }

.sg .sg-card { position: relative; overflow: hidden; margin: 0; padding: 10px 16px 8px; }
.sg-card-main { display: flex; align-items: center; gap: 18px; min-height: 44px; }
.sg-now { display: flex; align-items: baseline; gap: 14px; min-width: 0; }
.sg-big { font-size: 30px; font-weight: 600; line-height: 1.15; letter-spacing: -.02em;
  white-space: nowrap; font-variant-numeric: tabular-nums; }
.sg-big.idle { font-size: 16px; font-weight: 400; letter-spacing: 0; color: var(--dim); }
.sg-big.done { font-size: 22px; }
.sg-big.q { color: #5d5d66; font-weight: 500; }
.sg-big.warn { color: var(--warn); }
.sg-next { font-size: 18px; color: var(--dim); white-space: nowrap; }
.sg-next:empty { display: none; }
.sg-next b { font-weight: 600; }
.sg-sub { font-size: 14px; color: var(--dim); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.sg-slots { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.sg-step { display: inline-flex; align-items: center; justify-content: center; min-width: 60px;
  height: 38px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: #1b1b20;
  font-size: 17px; font-weight: 600; white-space: nowrap; }
.sg-step.q { color: #5d5d66; font-weight: 500; }
.sg-step.cur { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.sg-step.warn { color: var(--warn); border-color: rgba(234,179,8,.55); }
.sg-card-foot { display: flex; align-items: baseline; gap: 18px; min-height: 20px; margin-top: 4px; }
.sg-done { flex: 0 1 auto; min-width: 0; font-size: 13px; color: var(--dim); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.sg-done .ok { color: var(--good); }
.sg .sg-card-foot .verdict, .sg .sg-card-foot .grade { margin: 0; min-height: 0; font-size: 13px; }
.sg .sg-card-foot .verdict { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.sg-progress { position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: var(--accent);
  opacity: .75; transition: width 160ms linear; }

/* ── the chart ───────────────────────────────────────────── */
.sg .sg-chart { flex: 0 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
  gap: 8px; padding: 1px 2px 1px 0; }
.sg-sec, .sg-esec { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 8px;
  align-items: start; }
.sg-sec-label { display: flex; justify-content: flex-end; padding-top: 6px; }
.sg-mark { display: inline-flex; align-items: center; justify-content: center; min-width: 22px;
  max-width: 52px; height: 22px; padding: 0 6px; border: 1px solid #3a3a44; border-radius: 6px;
  font-size: 12px; font-weight: 700; color: var(--ink); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.sg-lines { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.sg-line { display: flex; gap: 4px; height: 34px; }
.sg-bar { position: relative; flex: 1 1 0; min-width: 0; display: flex; overflow: hidden;
  border: 1px solid var(--line); border-radius: 6px; background: #141417; }
.sg-bar.volta { border-top-color: #5c5c68; }
.sg-volta { position: absolute; top: 1px; right: 6px; z-index: 2; font-size: 10px; font-weight: 600;
  color: var(--dim); }
.sg-bar.act { border-color: rgba(122,162,247,.65); background: rgba(122,162,247,.07); }
.sg-bar.miss { box-shadow: inset 0 -2px 0 var(--bad); }
.sg-miss { position: absolute; right: 6px; bottom: 1px; z-index: 2; font-size: 10px; font-weight: 700;
  color: var(--bad); }
.sg-slot { position: relative; flex: 1 1 0; min-width: 0; display: flex; align-items: flex-start;
  padding: 3px 8px 0; }
.sg-slot + .sg-slot { border-left: 1px dashed #2c2c33; }
.sg-slot.cur { border-radius: 5px; box-shadow: inset 0 0 0 2px var(--accent); }
.sg-slot.hit { box-shadow: inset 0 -2px 0 var(--accent); }
.sg-slot.played { opacity: .5; }
.sg-beats { position: absolute; left: 8px; right: 8px; bottom: 1px; display: flex;
  justify-content: space-around; font-size: 11px; line-height: 13px; color: rgba(255,255,255,.12);
  pointer-events: none; }
.sg-beats i { font-style: normal; }
.sg-sym { position: relative; z-index: 1; font-size: 15px; font-weight: 600; line-height: 18px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-sym.q { color: #5d5d66; font-weight: 500; }
.sg-sym.dim { color: var(--dim); font-weight: 500; }
.sg-sym.warn { color: var(--warn); }
.sg-sym.unread { text-decoration: underline wavy var(--bad); text-underline-offset: 3px; }
.sg-piano { margin-top: auto; display: flex; justify-content: center; }
.sg-piano svg.piano { width: 597px; height: 92px; min-width: 0; max-width: 100%; }

/* ── check ───────────────────────────────────────────────── */
.sg .sg-cbody { flex: 1 1 auto; min-height: 0; display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 14px; }
.sg-page { min-height: 0; overflow: auto; border: 1px solid var(--line); border-radius: 10px;
  background: #0c0c0e; }
.sg-page .sg-empty { padding: 22px; }
.sg-img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: center top;
  background: #fff; cursor: zoom-in; }
.sg-page.zoom .sg-img { height: auto; cursor: zoom-out; }
.sg-pdf { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
.sg-cright { min-height: 0; display: flex; flex-direction: column; }
.sg-edit { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px;
  padding: 2px 4px 2px 0; }
.sg-elines { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.sg-eline { display: flex; gap: 5px; align-items: flex-start; }
.sg-ebar { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.sg-in { width: 100%; background: #1e1e23; color: var(--ink); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 7px; font: 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
.sg-in.flag { border-color: var(--warn); box-shadow: 0 0 0 1px rgba(234,179,8,.3); }
.sg-in.prob, .sg-in.bad { border-color: var(--bad); box-shadow: 0 0 0 1px rgba(239,68,68,.3); }
.sg-chip { align-self: flex-start; max-width: 100%; padding: 1px 8px; border-radius: 9px;
  border: 1px solid rgba(234,179,8,.45); background: rgba(234,179,8,.08); color: var(--warn);
  font: inherit; font-size: 11px; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
.sg-chip:hover { background: rgba(234,179,8,.18); }
.sg-form-warn { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 12px;
  color: var(--warn); margin-top: 4px; }
.sg-pmsg { font-size: 11px; line-height: 1.3; color: var(--bad); }
.sg-fmsg { font-size: 11px; color: var(--warn); }
.sg-form { flex: none; display: flex; flex-direction: column; gap: 7px; margin-top: 8px; padding-top: 9px;
  border-top: 1px solid var(--line); }
.sg-form-head { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
  color: var(--dim); }
.sg-form-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.sg-form-lbl { width: 60px; flex: none; font-size: 12px; color: var(--dim); }
.sg-fchip { display: inline-flex; align-items: center; gap: 2px; padding: 2px 3px 2px 10px; border-radius: 999px;
  border: 1px solid #3a3a44; background: #1b1b20; font-size: 13px; font-weight: 600; }
.sg-fchip button { background: none; border: 0; color: var(--dim); font: inherit; font-size: 14px;
  line-height: 1; padding: 0 5px; cursor: pointer; }
.sg-fchip button:hover { color: var(--bad); }
.sg-schip { padding: 3px 10px; border-radius: 8px; border: 1px dashed #3a3a44; background: none;
  color: var(--dim); font: inherit; font-size: 12px; cursor: pointer; }
.sg-schip b { margin-right: 6px; color: var(--ink); font-weight: 700; }
.sg-schip:hover { border-color: var(--accent); color: var(--ink); }
.sg-form-msg { font-size: 12px; color: var(--bad); }
.sg-textwrap { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.sg-text { flex: 1; min-height: 0; width: 100%; resize: none; padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--line); background: #121215; color: var(--ink);
  font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
.sg-text-bar { display: flex; align-items: flex-start; gap: 8px; }
.sg-text-err { flex: 1; max-height: 96px; overflow: auto; font-size: 12px; line-height: 1.4;
  color: var(--bad); }
.sg-del { display: inline-flex; align-items: center; gap: 6px; }
.sg-confirm { font-size: 13px; color: var(--bad); }
.sg .btn.sg-danger:hover:not(:disabled) { border-color: var(--bad); color: var(--bad); }
.sg .btn.sg-yes { border-color: var(--bad); color: var(--bad); }

.sg-drop { position: fixed; inset: 10px; z-index: 20; display: flex; align-items: center;
  justify-content: center; border: 2px dashed var(--accent); border-radius: 16px;
  background: rgba(17,17,17,.4); pointer-events: none; }
.sg-drop-msg { padding: 10px 18px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--panel); font-size: 17px; color: var(--ink); }
`;

function inject() {
  if (document.getElementById("songs-css")) return;
  const style = document.createElement("style");
  style.id = "songs-css";
  style.textContent = CSS;
  document.head.append(style);
}

// ── small pure helpers ────────────────────────────────────────────────────

/** h("div", {class, text, onclick, "data-x": 1}, ...children) — strings become text nodes. */
function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") || PROPS.has(k)) node[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid !== null && kid !== undefined && kid !== false && kid !== "") node.append(kid);
  }
  return node;
}

/**
 * Display glyphs only (Bb7(#11) → B♭7(♯11)); the text itself is never interpreted.
 * Exported: the trainer pane writes chord names the same way (views/trainer.js).
 */
export const pretty = (t) => String(t ?? "")
  .replace(/#/g, "♯")
  .replace(/(^|\/)([A-G])b/g, "$1$2♭")
  .replace(/b(?=\d)/g, "♭");

/** The same rule word by word, for a sentence that names chords ("Play Dbm7b5 — shell"). */
export const prettyWords = (t) => String(t ?? "").split(/(\s+)/).map(pretty).join("");

/** Root-pc color of a chord's text, or null — chordRootPc is the only "parsing" here.
 *  Exported with tintChord: the Play pane paints a held chord the same way (views/play.js). */
export function rgbFor(text) {
  const pc = chordRootPc(text);
  return pc === null || pc === undefined ? null : rgbOf(pc);
}

/** Paint chord text its root color. The darkest roots (G, F) get a faint light halo on
 *  the dark ground — never a lighter color: in this palette brightness means "sharp". */
export function tintChord(el, rgb) {
  el.style.color = rgb ? css(rgb, 1) : "";
  const lum = rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 : 1;
  el.style.textShadow = lum < 0.32 ? "0 0 1px rgba(255,255,255,.75), 0 0 7px rgba(255,255,255,.2)" : "";
}

/** A chord name in its root color (for inline text). */
function chordSpan(text) {
  const span = h("b", { text: pretty(text) });
  const rgb = rgbFor(text);
  if (rgb) tintChord(span, rgb);
  return span;
}

const count = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th"
  : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th"}`;
const enc = encodeURIComponent;
const keyOf = (step) => `${step.addr}#${step.slot || 0}`;
// The server writes N.C. as an empty symbol (play null); a literal spelling is accepted too.
const isRest = (slot) => slot.play == null && (!slot.symbol || NC.test(String(slot.symbol).trim()));
// A held bar (an empty cell: the previous chord holds) carries that chord in its slot,
// but the page shows an empty bar — its `text` is only the volta prefix, if any.
const isHold = (bar) => !bar.repeat && String(bar.text ?? "").replace(/^\d+\.\s*/, "").trim() === "";

function fmtSecs(s) {
  const t = Math.max(0, Math.floor(Number(s) || 0));
  return t < 60 ? `${t} s` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function fmtDur(s) {
  const n = Number(s) || 0;
  return n < 60 ? `${n.toFixed(1)} s` : fmtSecs(n);
}

function urlOf(text) {
  const t = String(text || "").trim();
  return /^https?:\/\/\S+$/i.test(t) ? t : null;
}

/** First URL in a text/uri-list payload (# lines are comments). */
function firstUri(list) {
  for (const line of String(list || "").split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return urlOf(t);
  }
  return null;
}

const inField = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "")
  || t.isContentEditable === true);

const readType = (dt, type) => {
  try { return dt.getData(type) || ""; } catch { return ""; }
};

/**
 * What a drop carries, read synchronously (DRAG.md receiver order): files first,
 * then an application/x-hq-media URL, a text/uri-list URL, a plain-text URL.
 * Exported so the Practice tab can catch a page dropped on a non-song pane.
 */
export function dropPayload(dt) {
  const files = dt ? [...(dt.files || [])] : [];
  if (!dt || files.length) return { files, url: null };
  let url = null;
  const media = readType(dt, "application/x-hq-media");
  if (media) {
    try { url = urlOf(JSON.parse(media).url); } catch { url = null; }
  }
  url = url || firstUri(readType(dt, "text/uri-list")) || urlOf(readType(dt, "text/plain"));
  return { files: [], url };
}

/** Header values must be bytes: a non-ASCII (or %) name is percent-encoded; the router unquotes it. */
function headerName(name) {
  const s = String(name || "page");
  return /[^\x20-\x7e]|%/.test(s) ? encodeURIComponent(s) : s;
}

function say(node, text, kind) {
  node.textContent = text || "";
  node.classList.toggle("is-ok", kind === "ok");
  node.classList.toggle("is-err", kind === "err");
}

async function call(method, url, body) {
  const opts = { method, headers: {} };
  if (method === "GET") opts.cache = "no-store";   // Safari caches JSON heuristically
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let r;
  try { r = await fetch(url, opts); } catch { return { ok: false, status: 0, body: null }; }
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { ok: r.ok, status: r.status, body: data };
}

/** The human part of an error answer: {detail: str} · {detail: {detail}} · FastAPI's list. */
function detailOf(r) {
  if (!r) return "";
  if (r.status === 0) return "The music server is not answering.";
  const d = r.body && r.body.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => (x && (x.msg || x.message)) || String(x)).join("; ");
  if (d && typeof d === "object") return typeof d.detail === "string" ? d.detail : d.message || "";
  return "";
}

function errorsOf(r) {
  const b = r && r.body;
  if (!b) return [];
  if (Array.isArray(b.errors)) return b.errors;
  if (b.detail && typeof b.detail === "object" && Array.isArray(b.detail.errors)) return b.detail.errors;
  return [];
}

function errText(e) {
  if (typeof e === "string") return e;
  if (!e || typeof e !== "object") return String(e);
  const where = e.line != null ? `line ${e.line}` : e.addr ? `bar ${e.addr}` : "";
  const what = e.message || e.msg || e.error || JSON.stringify(e);
  return where ? `${where}: ${what}` : what;
}

/** song:<id>:phrase:A2 → {song, kind: "phrase", arg: "A2"}. */
function refParts(ref) {
  const m = /^song:([^:]+):(phrase|run|play|chord)(?::(.*))?$/.exec(String(ref || ""));
  return m ? { song: m[1], kind: m[2], arg: m[3] === undefined ? null : m[3] } : null;
}

/** song:<id>:play:B → {song, mode: "play", label: "B"} (`run` = the legacy play-through name). */
function deckParts(deck) {
  const m = /^song:([^:]+):(chords|phrases|play|run)(?::(.*))?$/.exec(String(deck || ""));
  return m ? { song: m[1], mode: m[2] === "run" ? "play" : m[2], label: m[3] || null } : null;
}

const jobDone = (j) => !!j.done || j.stage === "saved" || j.stage === "error";

// ── the view ──────────────────────────────────────────────────────────────

export function mount(el, ctx, opts = {}) {
  inject();
  const offline = !!(ctx && ctx.static);     // the static page: no imports, no check screen
  let alive = true;

  // ── state ───────────────────────────────────────────────────────────────
  let screen = "loading";
  let summaries = null;          // GET /api/songs (null until it answers)
  let song = null;               // the open song's JSON
  let bars = new Map();          // addr -> written bar of the open song
  let addrOrder = [];            // written order, for Enter → next bar
  let openGen = 0;
  const jobs = new Map();        // job id -> job (+ _at, when we heard of it)
  const dismissed = new Set();
  let ticker = null;
  let uiMode = "play";
  let playTarget = "all";        // "all" or a section label
  const showKeys = { chords: false, play: true };
  let blind = false;
  let misses = new Map();        // addr -> wrong attempts (last receipt), until the next Start
  let missNote = "";             // chords-mode receipts count by chord name instead
  let songStatus = { text: "", kind: "" };
  let checkNote = { text: "", kind: "" };
  let formNote = "";
  let formBusy = false;
  let seeding = false;
  let rereadJob = null;
  let delArmed = false;
  let pageKey = null;
  let runCache = null;

  const blankDrill = () => ({
    state: "idle",               // idle | pending | live | done | lost
    deck: null, songId: null, mode: null, label: null,
    idx: -1, total: 0, ref: null, chord: null, prompt: "",
    phrase: null, steps: null, stepIdx: 0, revealed: new Set(), passed: false,
    stopped: false, summary: "", receipt: "",
  });
  let drill = blankDrill();
  const busy = () => drill.state === "pending" || drill.state === "live";
  const overlayOn = () => !!song && drill.songId === song.id && drill.mode === uiMode
    && (drill.state === "live" || drill.state === "done" || drill.state === "lost");

  // ── skeleton ────────────────────────────────────────────────────────────
  const root = h("div", { class: "sg" });
  const libEl = h("section", { class: "sg-lib", hidden: true });
  const songEl = h("section", { class: "sg-song", hidden: true });
  const checkEl = h("section", { class: "sg-check", hidden: true });
  // A song that cannot open (its text no longer parses): one line, and the sidebar stays on it.
  const failEl = h("section", { class: "sg-empty is-err sg-fail", hidden: true });
  const dropMask = h("div", { class: "sg-drop", hidden: true },
    h("div", { class: "sg-drop-msg", text: offline ? LOCAL_IMPORT : "Drop the page to import it" }));
  root.append(libEl, songEl, checkEl, failEl, dropMask);
  el.replaceChildren(root);

  // Add page
  const urlIn = h("input", { class: "sg-url", type: "url", spellcheck: false, autocomplete: "off",
    placeholder: "Add a song: a Real Book page URL — or drop or ⌘V a page anywhere" });
  const addBtn = h("button", { class: "btn primary", text: "Add" });
  const fileIn = h("input", { type: "file", accept: "image/*,.pdf,.svg,.heic", multiple: true, hidden: true });
  const browseBtn = h("button", { class: "btn", text: "Browse…" });
  const addMsg = h("div", { class: "sg-add-msg" });
  const jobsEl = h("div", { class: "sg-jobs" });
  libEl.append(
    ...(offline ? [h("div", { class: "sg-add sg-local" }, h("div", { class: "sg-add-msg", text: LOCAL_IMPORT }))] : [
      h("div", { class: "sg-add" },
        h("div", { class: "sg-add-row" }, urlIn, addBtn, browseBtn, fileIn),
        addMsg),
      jobsEl]));

  // Song — header
  const titleEl = h("span", { class: "sg-title" });
  const metaEl = h("span", { class: "sg-meta" });
  const dialBtns = DIALS.map(([v, label, tip]) =>
    h("button", { text: label, title: tip, "data-v": v, onclick: () => setDial(v) }));
  const checkBtn = h("button", { class: "btn", text: "Check page", hidden: offline, onclick: () => goCheck() });
  const stepsEl = h("div", { class: "sg-steps" });
  // Song — mode bar
  const modeBtns = MODES.map(([v, label]) =>
    h("button", { text: label, "data-v": v, onclick: () => setMode(v) }));
  const runSel = h("select", { class: "sg-runsel", title: "play the whole song, or one section" });
  const keysBox = h("input", { type: "checkbox" });
  const keysLbl = h("label", { class: "sg-toggle",
    title: "light the chord's keys on the piano — a hint; any voicing passes" }, keysBox, h("span", { text: "Show keys" }));
  const blindBox = h("input", { type: "checkbox" });
  const blindLbl = h("label", { class: "sg-toggle",
    title: "hide the chord names — a wrong attempt still shows the chord" }, blindBox, h("span", { text: "Blind" }));
  const startBtn = h("button", { class: "btn primary", text: "Start", onclick: () => startDrill() });
  const skipBtn = h("button", { class: "btn", text: "Skip", disabled: true,
    onclick: () => ctx.send({ type: "skip" }) });
  const stopBtn = h("button", { class: "btn", text: "Stop", disabled: true,
    onclick: () => ctx.send({ type: "stop" }) });
  // Song — drill card
  const bigEl = h("span", { class: "sg-big idle" });
  const nextEl = h("span", { class: "sg-next" });
  const subEl = h("span", { class: "sg-sub" });
  const slotsEl = h("div", { class: "sg-slots" });
  const verdictEl = h("div", { class: "verdict sg-verdict" });
  const gradeEl = h("div", { class: "grade sg-grade" });
  // The phrase just passed, with its chords. The trainer sends the next card the instant
  // one passes (and times it from there), so the finished line stays visible here instead
  // of holding the new card back — holding it would cost speed on the grade.
  const doneEl = h("div", { class: "sg-done" });
  const progBar = h("div", { class: "sg-progress" });
  // Song — chart + piano
  const chartEl = h("div", { class: "sg-chart" });
  const pianoEl = h("div", { class: "sg-piano" });
  songEl.append(
    h("div", { class: "sg-head" },
      h("div", { class: "sg-titles" }, titleEl, metaEl),
      h("span", { class: "sg-spacer" }),
      h("span", { class: "sg-lbl", text: "grade" }),
      h("div", { class: "sg-seg", role: "group", "aria-label": "grading dial" }, ...dialBtns),
      checkBtn),
    stepsEl,
    h("div", { class: "sg-modebar" },
      h("div", { class: "sg-seg", role: "group", "aria-label": "practice mode" }, ...modeBtns),
      runSel, keysLbl, blindLbl,
      h("span", { class: "sg-spacer" }),
      startBtn, skipBtn, stopBtn),
    h("div", { class: "card sg-card" },
      h("div", { class: "sg-card-main" },
        h("div", { class: "sg-now" }, bigEl, nextEl, subEl),
        slotsEl),
      h("div", { class: "sg-card-foot" }, verdictEl, doneEl, gradeEl),
      progBar),
    chartEl, pianoEl);
  const piano = makePiano(pianoEl, { low: 36, high: 96,
    onPlay: (note, on, vel) => ctx.send({ type: "note_in", on, note, vel }) });

  // Check
  const cTitle = h("span", { class: "sg-title" });
  const cMeta = h("span", { class: "sg-meta" });
  const okBtn = h("button", { class: "btn primary", text: "Looks right ✓",
    title: "the chords and the form match the page", onclick: () => markChecked() });
  const textBtn = h("button", { class: "btn", text: "Edit as text", onclick: () => toggleText() });
  const rereadBtn = h("button", { class: "btn", text: "Re-read page",
    title: "Claude reads the page again", onclick: () => reread() });
  const delWrap = h("span", { class: "sg-del" });
  const cMsg = h("div", { class: "sg-note", hidden: true });
  const pageEl = h("div", { class: "sg-page" });
  const editEl = h("div", { class: "sg-edit" });
  const formEl = h("div", { class: "sg-form" });
  const textArea = h("textarea", { class: "sg-text", spellcheck: false, "aria-label": "song text" });
  const textErr = h("div", { class: "sg-text-err" });
  const textWrap = h("div", { class: "sg-textwrap", hidden: true }, textArea,
    h("div", { class: "sg-text-bar" },
      h("button", { class: "btn primary", text: "Save", onclick: () => saveText() }),
      h("button", { class: "btn", text: "Cancel", onclick: () => toggleText(false) }),
      textErr));
  checkEl.append(
    h("div", { class: "sg-head" },
      h("button", { class: "btn", text: "← Song", onclick: () => showSong() }),
      h("div", { class: "sg-titles" }, cTitle, cMeta),
      h("span", { class: "sg-spacer" }),
      okBtn, textBtn, rereadBtn, delWrap),
    cMsg,
    h("div", { class: "sg-cbody" }, pageEl, h("div", { class: "sg-cright" }, editEl, formEl, textWrap)));

  // ── screens ─────────────────────────────────────────────────────────────
  // Screens: "add" (import) · "song" · "check" · "fail" (a song that cannot open).
  function show(name) {
    screen = name;
    libEl.hidden = name !== "add";
    songEl.hidden = name !== "song";
    checkEl.hidden = name !== "check";
    failEl.hidden = name !== "fail";
    if (name !== "loading" && name !== "fail" && typeof opts.onNavigate === "function") {
      try { opts.onNavigate({ song: song ? song.id : null, screen: name }); } catch { /* the host's */ }
    }
  }

  function notify(text, kind) {
    if (screen === "song") setStatus(text, kind);
    else if (screen === "check") setCheckNote(text, kind);
    else say(addMsg, text, kind);
  }

  function setSong(next) {
    const prevId = song && song.id;
    song = next;
    bars = new Map();
    addrOrder = [];
    for (const sec of song.sections || []) {
      for (const line of sec.lines || []) {
        for (const bar of line.bars || []) { bars.set(bar.addr, bar); addrOrder.push(bar.addr); }
      }
    }
    runCache = null;
    if (prevId !== song.id) {
      misses = new Map();
      missNote = "";
      songStatus = { text: "", kind: "" };
      checkNote = { text: "", kind: "" };
      formNote = "";
      rereadJob = null;
      delArmed = false;
      pageKey = null;
      textWrap.hidden = true;
      editEl.hidden = false;
      formEl.hidden = false;
    }
    if (drill.songId === song.id && drill.steps) resolveRef();
  }

  async function openSong(songId, o = {}) {
    if (busy() && drill.songId !== songId) stopDrill();
    const gen = ++openGen;
    const r = await call("GET", `${API}/${enc(songId)}`);
    if (!alive || gen !== openGen) return;
    if (!r.ok || !r.body || !r.body.sections) {
      song = null;
      failEl.textContent = r.status === 404 ? "That song is gone — it may have been deleted."
        : r.status === 422 ? `That song's text does not parse: ${detailOf(r)}`
        : detailOf(r) || "Could not open that song.";
      show("fail");
      return;
    }
    setSong(r.body);
    if (o.screen === "check") showCheck();
    else showSong();
    if (o.resume) applyResume(o.resume);
    loadRuns(song.id);
  }

  async function reloadSong(force) {
    if (!song) return;
    const sid = song.id;
    const r = await call("GET", `${API}/${enc(sid)}`);
    if (!alive || !song || song.id !== sid) return;
    if (r.status === 404) {
      song = null;
      show("add");
      say(addMsg, "That song was deleted.", "");
      loadList();
      return;
    }
    if (!r.ok || !r.body || !r.body.sections) return;
    if (!force && r.body.updated && r.body.updated === song.updated) return;   // our own write, echoed
    setSong(r.body);
    if (screen === "check") renderCheck();
    else renderSong();
  }

  function goCheck() {
    if (!song) return;
    if (offline) {
      notify(LOCAL_CHECK, "");
      return;
    }
    stopDrill();
    showCheck();
  }

  function showSong() {
    show("song");
    renderSong();
  }

  function showCheck() {
    show("check");
    renderCheck();
  }

  // ── the songs we know: only to tidy the import rows (a saved import of a song
  //    already checked needs no "Check it →") ──
  async function loadList() {
    const r = await call("GET", API);
    if (!alive) return;
    if (r.ok && Array.isArray(r.body)) summaries = r.body;
    renderJobs();
  }

  // ── imports ─────────────────────────────────────────────────────────────
  /** {job:"id"} · {job:{…}} · a full job — the POST answer, whichever shape it has. */
  function jobFrom(b) {
    if (!b) return null;
    if (b.job && typeof b.job === "object") return b.job;
    if (b.job === undefined || b.job === null) return null;
    if (b.stage) return b;
    return { job: String(b.job), stage: "queued", message: "", song: null, error: null,
      elapsed_s: 0, done: false, _placeholder: true };
  }

  // Stages only move forward: the POST's answer can land after the WS has already
  // reported a later stage, and must not drag the row back.
  const RANK = { queued: 0, fetch: 1, normalize: 2, read: 3, compare: 4, saved: 5, error: 5 };
  const rankOf = (j) => (jobDone(j) ? 6 : RANK[j.stage] ?? 0);

  function upsertJob(j) {
    if (!j || j.job === undefined || j.job === null) return;
    const jid = String(j.job);
    const prev = jobs.get(jid);
    if (prev && (j._placeholder || rankOf(j) < rankOf(prev))) return;
    const { type: _t, event: _e, ...rest } = j;
    jobs.set(jid, { ...(prev || {}), ...rest, job: jid, _at: Date.now() });
    if (rest.stage === "saved" && prev && prev.stage !== "saved") loadList();   // a fresh song to list
    renderJobs();
    renderCheckNote();
  }

  function elapsedOf(j) {
    const base = Number(j.elapsed_s) || 0;
    return jobDone(j) ? base : base + (Date.now() - (j._at || Date.now())) / 1000;
  }

  function jobRow(j, inline) {
    const done = jobDone(j);
    const err = j.stage === "error";
    const row = h("div", { class: `sg-job ${err ? "err" : done ? "ok" : "busy"}`, "data-job": j.job },
      h("span", { class: "sg-dot" }),
      h("span", { class: "sg-stage", text: STAGES[j.stage] || j.stage || "Working" }),
      j.origin && !inline ? h("span", { class: "sg-origin", text: j.origin, title: j.origin }) : null,
      h("span", { class: "sg-jmsg", text: err ? j.error || j.message || "the import failed" : "" }),
      h("span", { class: "sg-elapsed", text: fmtSecs(elapsedOf(j)) }));
    if (!inline && j.stage === "saved" && j.song) {
      row.append(h("button", { class: "sg-link", text: "Check it →",
        onclick: () => openSong(j.song, { screen: "check" }) }));
    }
    if (done) {
      row.append(h("button", { class: "sg-x", text: "×", title: "dismiss", onclick: () => {
        if (inline) rereadJob = null;
        else dismissed.add(j.job);
        renderJobs();
        renderCheckNote();
      } }));
    }
    return row;
  }

  function renderJobs() {
    const checked = new Set((summaries || []).filter((s) => s.checked).map((s) => s.id));
    const rows = [...jobs.values()].reverse()
      .filter((j) => !dismissed.has(j.job) && !(j.stage === "saved" && checked.has(j.song)))
      .slice(0, 6);
    jobsEl.replaceChildren(...rows.map((j) => jobRow(j, false)));
    syncTicker();
  }

  // Elapsed seconds tick locally while anything is still running.
  function syncTicker() {
    const running = [...jobs.values()].some((j) => !jobDone(j));
    if (running && !ticker) {
      ticker = setInterval(() => {
        if (!alive) return;
        renderJobs();
        renderCheckNote();
      }, 1000);
    } else if (!running && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  async function loadJobs() {
    const r = await call("GET", `${API}/imports`);
    if (!alive || !r.ok) return;
    const list = Array.isArray(r.body) ? r.body : (r.body && r.body.jobs) || [];
    // Newest first on the wire; insert oldest first so the rows read newest-on-top.
    for (const j of [...list].reverse()) if (j && !jobs.has(String(j.job))) upsertJob(j);
  }

  function afterImport(res) {
    if (!alive) return false;
    if (res.ok) {
      upsertJob(jobFrom(res.body));
      notify(screen === "add" ? "" : "Import started — its progress is under + Add song.", "");
      return true;
    }
    notify(res.status === 413 ? "That file is over the 25 MB import limit."
      : detailOf(res) || "The import failed.", "err");
    return false;
  }

  async function importFile(file) {
    if (offline) {
      notify(LOCAL_IMPORT, "");
      return false;
    }
    const name = headerName(file.name);
    notify(`Uploading ${file.name || "the page"}…`, "");
    let res;
    try {
      const r = await fetch(`${API}/import`, { method: "POST", body: file,
        headers: { "X-Filename": name, "Content-Type": file.type || "application/octet-stream" } });
      let data = null;
      try { data = await r.json(); } catch { data = null; }
      res = { ok: r.ok, status: r.status, body: data };
    } catch {
      res = { ok: false, status: 0, body: null };
    }
    return afterImport(res);
  }

  async function importUrl(url) {
    if (offline) {
      notify(LOCAL_IMPORT, "");
      return false;
    }
    notify(`Fetching ${url}…`, "");
    return afterImport(await call("POST", `${API}/import`, { url }));
  }

  addBtn.onclick = async () => {
    const url = urlOf(urlIn.value);
    if (!url) {
      say(addMsg, "That doesn't look like an http(s) link.", "err");
      return;
    }
    if (await importUrl(url)) urlIn.value = "";
  };
  urlIn.onkeydown = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); addBtn.onclick(); }
  };
  browseBtn.onclick = () => fileIn.click();
  fileIn.onchange = () => {
    const files = [...(fileIn.files || [])];
    files.forEach((f) => importFile(f));
    try { fileIn.value = ""; } catch { /* some browsers refuse */ }
  };

  // Drops: the whole window is the target while this view is mounted (a page that
  // misses a smaller zone would otherwise replace the cockpit tab). DRAG.md order.
  let dragDepth = 0;
  const carries = (dt) => {
    const types = dt && dt.types ? [...dt.types] : [];
    return ["Files", "text/uri-list", "application/x-hq-media", "text/plain"].some((t) => types.includes(t));
  };
  const hasFiles = (dt) => !!dt && !!dt.types && [...dt.types].includes("Files");
  function onDragEnter(ev) {
    dragDepth += 1;
    if (carries(ev.dataTransfer)) dropMask.hidden = false;
  }
  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropMask.hidden = true;
  }
  function onDragOver(ev) {
    if (!carries(ev.dataTransfer)) return;
    if (inField(ev.target) && !hasFiles(ev.dataTransfer)) return;   // text into a field lands natively
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    dropMask.hidden = false;
  }
  function onDrop(ev) {
    dragDepth = 0;
    dropMask.hidden = true;
    const dt = ev.dataTransfer;
    if (!dt) return;
    // Read every payload synchronously, before any await (DRAG.md).
    if (!(dt.files && dt.files.length) && inField(ev.target)) return;
    const { files, url } = dropPayload(dt);
    ev.preventDefault();
    if (files.length) files.forEach((f) => importFile(f));
    else if (url) importUrl(url);
    else notify("Nothing importable in that drop — paste ⌘V, or Browse…", "err");
  }

  function onPaste(ev) {
    // A field pastes text for itself; anywhere else a page or a link imports. The URL
    // field can't hold a page image, so a pasted file imports even there (the add page
    // opens with the cursor in it).
    const at = ev.target && ev.target !== document.body ? ev.target : document.activeElement;
    const cd = ev.clipboardData;
    if (!cd) return;
    let files = [...(cd.files || [])];
    if (!files.length && cd.items) {        // Safari: a pasted image only as an item
      files = [...cd.items].filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter(Boolean);
    }
    if (inField(at) && !(at === urlIn && files.length)) return;
    const pages = files.filter((f) => /^image\//.test(f.type || "") || f.type === "application/pdf"
      || /\.(pdf|svg|heic|png|jpe?g|gif|webp|tiff?)$/i.test(f.name || ""));
    if (pages.length) {
      ev.preventDefault();
      pages.forEach((f) => importFile(f));
      return;
    }
    const url = urlOf(readType(cd, "text/plain")) || firstUri(readType(cd, "text/uri-list"));
    if (url) {
      ev.preventDefault();
      importUrl(url);
    }
  }

  // ── song: header, stepper, controls ─────────────────────────────────────
  function setStatus(text, kind) {
    songStatus = { text: text || "", kind: kind || "" };
    renderSteps();
  }


  function renderSong() {
    if (!song) return;
    titleEl.textContent = song.title || song.id;
    metaEl.textContent = [song.key, song.time].filter(Boolean).join(" · ");
    for (const b of dialBtns) {
      const on = b.getAttribute("data-v") === (song.grade || "core");
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    renderSteps();
    renderRunOptions();
    paint();
  }

  /** Onboarding is done once the page is checked (no page on the static site) and it is in review. */
  const ready = () => !!song && (!!song.checked || offline) && Number((song.review || {}).cards) > 0;

  /**
   * The onboarding stepper — ① check the page (chords + sections) → ② add to review — on
   * one line while either is open; it goes away once both are done. While it shows, its
   * steps are the buttons (the header's Check page waits until it is gone). Once the song
   * is in review there is no Add to review: an edit rewrites its cards on the server.
   */
  function renderSteps() {
    if (!song) return;
    const parts = [];
    const rv = song.review || null;
    const label = (rv && rv.label) || "review";
    if (!ready()) {
      const checked = !!song.checked;
      const cards = rv ? Number(rv.cards) || 0 : 0;
      if (!offline) {
        const nf = count(song.flags);
        const nb = count(song.problems);
        const why = [nf ? `${plural(nf, "bar")} flagged` : "", nb ? `${nb} unreadable` : ""]
          .filter(Boolean).join(" · ") || "chords + sections";
        parts.push(checked
          ? h("button", { class: "sg-stp done", "data-step": "check", onclick: () => goCheck() },
            h("span", { class: "n", text: "✓" }), "Checked")
          : h("button", { class: "sg-stp", "data-step": "check", onclick: () => goCheck() },
            h("span", { class: "n", text: "①" }), "Check the page", h("span", { class: "d", text: why })));
        parts.push(h("span", { class: "sg-stp-sep", text: "→" }));
      }
      // The static page has no page to check against: its stepper starts at "Add to review".
      parts.push(cards > 0
        ? h("button", { class: "sg-stp done", "data-step": "review", onclick: () => seed() },
          h("span", { class: "n", text: "✓" }), "In review")
        : h("button", { class: "sg-stp", "data-step": "review", onclick: () => seed() },
          h("span", { class: "n", text: offline ? "①" : "②" }), "Add to review",
          rv && rv.available === false
            ? h("span", { class: "d is-err", text: `${label} is closed — pick Built-in in 🧠` }) : null));
    }
    if (songStatus.text) {
      parts.push(h("span", { class: "sg-spacer" }));
      parts.push(h("span", { class: `sg-status${songStatus.kind ? ` is-${songStatus.kind}` : ""}`,
        text: songStatus.text }));
    }
    stepsEl.replaceChildren(...parts);
    stepsEl.hidden = !parts.length;
    checkBtn.hidden = offline || !ready();
  }

  function renderRunOptions() {
    const sections = (song.decks && song.decks.sections) || {};
    const labels = (song.sections || []).map((s) => s.label).filter((l) => l in sections);
    for (const l of Object.keys(sections)) if (!labels.includes(l)) labels.push(l);
    runSel.replaceChildren(h("option", { value: "all", text: "Whole song" }),
      ...labels.map((l) => h("option", { value: l, text: `${l} only` })));
    if (playTarget !== "all" && !labels.includes(playTarget)) playTarget = "all";
    runSel.value = playTarget;
  }

  function renderModebar() {
    const running = busy();
    for (const b of modeBtns) {
      const on = b.getAttribute("data-v") === uiMode;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.disabled = running && !on;
    }
    for (const b of dialBtns) b.disabled = running;
    runSel.hidden = uiMode !== "play";
    runSel.disabled = running;
    keysLbl.hidden = uiMode === "phrases";
    keysBox.checked = !!showKeys[uiMode];
    keysBox.disabled = uiMode === "play" && blind;        // Blind turns the hint off
    blindLbl.hidden = uiMode !== "play";
    blindBox.checked = blind;
    startBtn.disabled = running || !song;
    skipBtn.disabled = drill.state !== "live";
    stopBtn.disabled = !running;
  }

  function paint() {
    if (!song) return;
    renderModebar();
    renderCard();
    renderChart();
  }

  async function setDial(v) {
    if (!song || busy() || v === (song.grade || "core")) return;
    const r = await call("PATCH", `${API}/${enc(song.id)}`, { grade: v });
    if (!alive || !song) return;
    if (r.ok && r.body && r.body.sections) {
      setSong(r.body);
      renderSong();
    } else if (r.ok) {
      await reloadSong(true);
    } else {
      setStatus(detailOf(r) || "Could not change the grading dial.", "err");
    }
  }

  /** "Add to review": the phrase cards go to the active review backend (§10). */
  async function seed() {
    if (!song || seeding) return;
    seeding = true;                       // the stepper's step is the only way in
    setStatus("Adding to review…", "");
    const r = await call("POST", `${API}/${enc(song.id)}/seed`);
    seeding = false;
    if (!alive || !song) return;
    if (r.ok && r.body) {
      // Did it work — not how many: the counts ask nothing of Tyler.
      const b = r.body;
      setStatus(b.added ? "Added to review." : b.updated ? "Review cards updated." : "Already in review.", "ok");
      await reloadSong(true);             // the stepper reads song.review
      if (typeof opts.onChange === "function") opts.onChange();
    } else if (r.status === 503) {
      setStatus("Anki is closed — open it, or pick Built-in in the 🧠 menu", "err");
    } else {
      setStatus(detailOf(r) || "Could not add the song to review.", "err");
    }
  }

  function setMode(v) {
    if (busy() || v === uiMode) return;
    uiMode = v;
    paint();
  }

  runSel.onchange = () => {
    playTarget = runSel.value;
    runSel.blur();                 // hand the keys back to musical typing
    paint();
  };
  keysBox.onchange = () => {
    if (uiMode in showKeys) showKeys[uiMode] = !!keysBox.checked;
    keysBox.blur();
    renderCard();
  };
  blindBox.onchange = () => {
    blind = !!blindBox.checked;
    blindBox.blur();
    paint();
  };

  // ── the drill (trainer messages, claimed per song) ──────────────────────
  function startDrill() {
    if (!song || busy()) return;
    const decks = song.decks || {};
    const deck = uiMode === "chords" ? decks.chords
      : uiMode === "phrases" ? decks.phrases
      : playTarget === "all" ? decks.play || decks.run : (decks.sections || {})[playTarget];
    if (!deck) {
      setStatus("This song has no deck for that mode yet.", "err");
      return;
    }
    drill = { ...blankDrill(), state: "pending", deck, songId: song.id, mode: uiMode,
      label: uiMode === "play" && playTarget !== "all" ? playTarget : null };
    misses = new Map();
    missNote = "";
    setStatus("", "");                    // "Added to review." and the like are old news now
    setVerdict("", "");
    gradeEl.replaceChildren();
    doneEl.replaceChildren();
    ctx.send({ type: "start", deck });
    paint();
  }

  /** Leaving the song ends its drill: a hidden card must not keep grading the hands. */
  function stopDrill() {
    if (busy()) ctx.send({ type: "stop" });
    if (drill.state !== "idle") drill = blankDrill();
  }

  function claims(m) {
    if (!drill.deck) return false;
    if (typeof m.ref === "string" && m.ref) return m.ref.startsWith(`song:${drill.songId}:`);
    return busy();
  }

  function resolveRef() {
    drill.phrase = null;
    drill.steps = null;
    runCache = null;
    if (!song) return;
    const rp = refParts(drill.ref);
    if (rp && rp.kind === "phrase") {
      drill.phrase = (song.phrases || []).find((p) => p.id === rp.arg) || null;
      drill.steps = drill.phrase ? drill.phrase.steps || [] : null;
    } else if (drill.mode === "play") {
      if (rp && (rp.kind === "run" || rp.kind === "play")) drill.label = rp.arg || null;
      const runs = song.runs || {};
      drill.steps = (drill.label ? runs[drill.label] : runs.all) || [];
    } else if (rp && rp.kind === "chord" && !drill.chord) {
      drill.chord = rp.arg;
    }
  }

  function setVerdict(text, cls) {
    verdictEl.textContent = text || "";
    verdictEl.className = `verdict sg-verdict${cls ? ` ${cls}` : ""}`;
  }

  function onPrompt(m) {
    if (!claims(m)) {
      // One trainer engine: a foreign prompt means ours was replaced. Draw none of
      // it; just release the controls and say so.
      if (busy()) {
        drill.state = "lost";
        setVerdict("Another drill took over the trainer.", "no");
        renderModebar();
        syncHint();
      }
      return;
    }
    const rp = refParts(m.ref);
    const mode = (rp && KIND_MODE[rp.kind]) || drill.mode || uiMode;
    Object.assign(drill, {
      state: "live", mode, idx: Number(m.idx) || 0, total: Number(m.total) || 0,
      ref: m.ref || null, chord: m.chord || null, prompt: m.prompt || "",
      stepIdx: 0, revealed: new Set(), passed: false,
    });
    uiMode = mode;
    if (mode === "play") playTarget = drill.label || (rp && rp.arg) || "all";
    resolveRef();
    setVerdict("", "");
    if (song && screen === "song") renderRunOptions();
    paint();
  }

  function onStep(m) {
    if (drill.state !== "live") return;
    drill.stepIdx = Math.max(0, Number(m.step) || 0);
    renderCard();
    renderChart();
  }

  function onAttempt(m) {
    if (drill.state !== "live") return;
    const v = m.verdict || {};
    setVerdict(v.summary || "", v.ok ? "ok" : "no");
    piano.flash(v.per_note);
    // A miss shows the chord being asked for, so the hands can play it and move on.
    if (!v.ok && (drill.mode === "phrases" || drill.mode === "play")) {
      drill.revealed.add(drill.stepIdx);
      renderCard();
      renderChart();
    }
  }

  function renderGrade(g) {
    const acc = g.accuracy || {};
    const spd = g.speed || {};
    const accText = acc.tier === "clean" ? "clean"
      : `${acc.tier} (${acc.wrong} wrong, ${acc.notes_off} notes off)`;
    gradeEl.replaceChildren(
      h("span", { class: `ease ${TIER[g.label] || ""}`, text: g.label }),
      " speed ",
      h("span", { class: TIER[spd.tier] || "", text: `${spd.tier} ${(Number(spd.latency_s) || 0).toFixed(1)}s` }),
      " · accuracy ",
      h("span", { class: TIER[acc.tier] || "", text: accText }));
  }

  function onPassed(m) {
    if (drill.state !== "live") return;
    drill.passed = true;
    if (drill.mode === "phrases" && drill.phrase) {
      const chords = (drill.phrase.steps || []).map((st) => st.play);
      doneEl.replaceChildren(h("span", { class: "ok", text: `✓ ${drill.phrase.name}: ` }),
        ...chords.flatMap((c, i) => (i ? [" · ", chordSpan(c)] : [chordSpan(c)])));
    }
    if (m.grade) renderGrade(m.grade);
    renderCard();
    renderChart();
  }

  function onDone(m) {
    if (!busy() || !drill.deck) return;
    const deck = String(m.deck || "");
    if (deck !== drill.deck && !deck.startsWith(`song:${drill.songId}:`)) return;
    const s = m.summary || {};
    let text;
    if (drill.mode === "play") {
      const n = (drill.steps || []).length;
      text = s.passed ? `Played through${typeof s.mean_latency_s === "number" ? ` in ${fmtDur(s.mean_latency_s)}` : ""}`
        : `Stopped at chord ${Math.min(drill.stepIdx + 1, n)} of ${n}`;
    } else {
      text = `Passed ${s.passed ?? 0} of ${s.total ?? 0}`;
      if (typeof s.mean_latency_s === "number") text += ` · mean ${s.mean_latency_s.toFixed(1)} s`;
    }
    Object.assign(drill, { state: "done", stopped: !!m.stopped, summary: text });
    paint();
  }

  function onError(m) {
    if (!busy()) return;
    setVerdict(m.message || "the trainer reported an error", "no");
    if (drill.state === "pending") {
      drill = blankDrill();
      paint();
    }
  }

  /** The receipt names missed bars; chords-mode receipts count chord names instead. */
  function applyReceipt(rec, quiet) {
    misses = new Map();
    const other = [];
    for (const [k, n] of Object.entries((rec && rec.misses) || {})) {
      if (bars.has(k)) misses.set(k, Number(n) || 0);
      else other.push(`${pretty(k)} ×${n}`);
    }
    missNote = other.length ? `missed ${other.join(", ")}` : "";
    if (!quiet && drill.songId === (song && song.id)) {
      drill.receipt = misses.size ? `${plural(misses.size, "bar")} missed`
        : other.length ? "" : "no misses";
    }
    renderCard();
    renderChart();
  }

  async function loadRuns(sid) {
    const r = await call("GET", `${API}/${enc(sid)}/runs`);
    if (!alive || !song || song.id !== sid || !r.ok || !Array.isArray(r.body) || !r.body.length) return;
    if (drill.state !== "idle") return;          // a session of this mount owns the marks
    applyReceipt(r.body[0], true);              // the last session's missed bars, on the chart
  }

  /** A view mounted mid-drill (tab switch, reload) picks a song drill back up. */
  function applyResume(d) {
    const pd = deckParts(d.deck);
    if (!song || !pd || pd.song !== song.id) return;
    drill = { ...blankDrill(), state: "pending", deck: d.deck, songId: song.id, mode: pd.mode,
      label: pd.label };
    uiMode = pd.mode;
    if (pd.mode === "play") playTarget = pd.label || "all";
    renderRunOptions();
    onPrompt({ idx: d.idx, total: d.total, prompt: d.prompt, chord: d.chord, ref: d.ref });
    if (typeof d.step === "number" && d.step > 0) {     // the live chord within the card
      drill.stepIdx = d.step;
      paint();
    }
  }

  function syncDrill(d) {
    if (!d) return;
    const pd = d.active ? deckParts(d.deck) : null;
    if (!pd) {
      if (busy()) {                                   // the server restarted: no drill survives
        Object.assign(drill, { state: "done", stopped: true, summary: "The drill ended." });
        paint();
      }
      return;
    }
    if (drill.state === "live" && drill.deck === d.deck && drill.idx === d.idx) return;
    // The host chose this pane's song: never wander off to another one.
    if (pd.song !== (opts.song || (song && song.id))) return;
    if (song && song.id === pd.song) {
      if (screen !== "song") show("song");
      renderSong();
      applyResume(d);
    } else {
      openSong(pd.song, { resume: d });
    }
  }

  // ── the drill card ──────────────────────────────────────────────────────
  function stepBox(st, j) {
    const missed = drill.revealed.has(j);
    const known = drill.passed || j < drill.stepIdx || missed;
    const cur = j === drill.stepIdx && !drill.passed && drill.state === "live";
    const box = h("span", { class: `sg-step${cur ? " cur" : ""}${missed ? " warn" : ""}${known ? "" : " q"}`,
      text: known ? pretty(st.play || st.symbol || "") : "?" });
    const rgb = known && !missed ? rgbFor(st.play) : null;
    if (rgb) tintChord(box, rgb);
    return box;
  }

  /** "Show keys": the step's voicing as a soft piano hint — never in Blind, never in Phrases. */
  function syncHint() {
    let notes = null;
    if (song && overlayOn() && drill.state === "live" && !drill.passed) {
      if (drill.mode === "chords" && showKeys.chords) {
        const entry = (song.chords || []).find((c) => c.play === drill.chord);
        notes = entry && entry.notes;
      } else if (drill.mode === "play" && showKeys.play && !blind) {
        const st = (drill.steps || [])[drill.stepIdx];
        notes = st && st.notes;
      }
    }
    piano.setHint(Array.isArray(notes) ? notes : []);
  }

  function renderCard() {
    if (!song) return;
    slotsEl.replaceChildren();
    nextEl.replaceChildren();
    tintChord(bigEl, null);
    progBar.style.width = "0%";
    if (!overlayOn()) {
      const pending = drill.state === "pending" && drill.songId === song.id;
      bigEl.className = "sg-big idle";
      bigEl.textContent = pending ? "Starting…" : HINT[uiMode];
      subEl.textContent = "";
      syncHint();
      return;
    }
    if (drill.state === "done") {
      bigEl.className = "sg-big done";
      bigEl.textContent = drill.stopped ? "Stopped" : "Done";
      subEl.textContent = [drill.summary, drill.receipt, missNote].filter(Boolean).join(" · ");
      syncHint();
      return;
    }
    bigEl.className = "sg-big";
    // How far through the session: a thin bar, no numbers (they would not ask for anything).
    if (drill.total) progBar.style.width = `${((drill.idx / drill.total) * 100).toFixed(1)}%`;
    if (drill.mode === "chords") {
      const target = drill.chord;
      bigEl.textContent = target ? pretty(target) : drill.prompt || "?";
      const rgb = target ? rgbFor(target) : null;
      if (rgb) tintChord(bigEl, rgb);
      // The page's spellings, when the dial changed any of them (G7 and G7#5 → "written G7, G7♯5").
      const entry = (song.chords || []).find((c) => c.play === target);
      const forms = entry ? (entry.symbols || []).filter(Boolean) : [];
      subEl.textContent = forms.some((s) => s !== target) ? `written ${forms.map(pretty).join(", ")}` : "";
    } else if (drill.mode === "phrases") {
      const p = drill.phrase;
      bigEl.textContent = p ? p.name || p.id : drill.prompt || "Play the line";
      subEl.textContent = p ? (p.cue ? `after ${pretty(p.cue)}` : "from the top") : "";
      slotsEl.append(...(drill.steps || []).map((st, j) => stepBox(st, j)));
    } else {
      // Play through: the current chord big, the next two beside it, where we are.
      const steps = drill.steps || [];
      const j = drill.stepIdx;
      const st = drill.passed ? null : steps[j];
      const missed = drill.revealed.has(j);
      const named = !!st && (!blind || missed);
      if (!st) bigEl.textContent = drill.passed ? "✓" : drill.prompt || "Play through";
      else bigEl.textContent = named ? pretty(st.play) : "?";
      if (st && !named) bigEl.className = "sg-big q";
      else if (st && missed) bigEl.className = "sg-big warn";
      else if (st) {
        const rgb = rgbFor(st.play);
        if (rgb) tintChord(bigEl, rgb);
      }
      const ahead = st && !blind ? steps.slice(j + 1, j + 3) : [];
      if (ahead.length) {
        nextEl.append("then ", chordSpan(ahead[0].play));
        if (ahead[1]) nextEl.append(" → ", chordSpan(ahead[1].play));
      }
      const pos = runPosition();
      subEl.textContent = pos ? `${pos.section} · bar ${pos.secBar} of ${pos.secBars}`
        + (pos.passes > 1 ? ` · ${ordinal(pos.pass)} time` : "") : "";
      const frac = steps.length ? (drill.passed ? 1 : j / steps.length) : 0;
      progBar.style.width = `${(frac * 100).toFixed(1)}%`;
    }
    syncHint();
  }

  // ── play-through + phrase geometry (which written slots a step covers) ──
  /** The play-through's order as written slots, and where each step lands in it. */
  function runMap() {
    if (!song || !drill.steps) return null;
    if (runCache && runCache.song === song && runCache.steps === drill.steps) return runCache;
    const plays = (song.play || [])
      .filter((p) => !drill.label || (p.section === drill.label && (p.pass || 1) === 1));
    // Where each play bar sits inside its own pass of its section ("A · bar 3 of 16").
    const secBar = [];
    const secBars = [];
    for (let i = 0; i < plays.length;) {
      let k = i;
      const same = (q) => q.section === plays[i].section && (q.pass || 1) === (plays[i].pass || 1);
      while (k < plays.length && same(plays[k])) k += 1;
      for (let x = i; x < k; x++) { secBar[x] = x - i + 1; secBars[x] = k - i; }
      i = k;
    }
    const seq = [];
    const passes = {};
    plays.forEach((p, i) => {
      const bar = bars.get(p.addr);
      if (!bar) return;
      const pass = p.pass || 1;
      passes[p.section] = Math.max(passes[p.section] || 0, pass);
      const n = Math.max(1, (bar.slots || []).length);
      for (let s = 0; s < n; s++) {
        seq.push({ key: `${p.addr}#${s}`, addr: p.addr, section: p.section, pass, bar: i + 1,
          secBar: secBar[i], secBars: secBars[i] });
      }
    });
    const stepPos = [];
    let from = 0;
    for (const st of drill.steps) {
      const want = keyOf(st);
      let at = seq.findIndex((e, k) => k >= from && e.key === want);
      if (at < 0) at = seq.findIndex((e) => e.key === want);
      stepPos.push(at);
      if (at >= 0) from = at + 1;
    }
    runCache = { song, steps: drill.steps, seq, stepPos, bars: plays.length, passes };
    return runCache;
  }

  function runPosition() {
    const map = runMap();
    if (!map || !map.seq.length) return null;
    const p = drill.passed ? map.seq.length - 1 : map.stepPos[drill.stepIdx];
    if (p === undefined || p < 0) return null;
    const e = map.seq[p];
    return { bar: e.bar, of: map.bars, section: e.section, pass: e.pass, secBar: e.secBar,
      secBars: e.secBars, passes: map.passes[e.section] || 1 };
  }

  function runOverlay() {
    const map = runMap();
    if (!map) return null;
    const curP = drill.passed ? -1 : map.stepPos[drill.stepIdx] ?? -1;
    const cur = curP >= 0 ? map.seq[curP] : null;
    const limit = drill.passed ? map.seq.length : Math.max(0, curP);
    const played = new Set();
    for (let p = 0; p < limit; p++) {
      const e = map.seq[p];
      if (cur && e.section === cur.section && e.pass !== cur.pass) continue;   // an earlier pass stays as it was
      played.add(e.key);
    }
    const missed = new Set();
    for (const j of drill.revealed) {
      const p = map.stepPos[j];
      if (p >= 0) missed.add(map.seq[p].key);
    }
    return { played, missed, cur: cur ? cur.key : null, curRevealed: drill.revealed.has(drill.stepIdx) };
  }

  /** The active phrase's bars, which slot starts each step, and which step owns each slot. */
  function phraseOverlay() {
    const p = drill.phrase;
    if (!p || !song) return null;
    const sec = (song.sections || []).find((s) => s.label === p.section);
    const line = sec && ((sec.lines || []).find((l) => l.n === p.line) || (sec.lines || [])[p.line - 1]);
    if (!line) return null;
    const barsIn = (line.bars || []).filter((b) => p.volta == null || b.volta == null || b.volta === p.volta);
    const seq = [];
    for (const b of barsIn) {
      const n = Math.max(1, (b.slots || []).length);
      for (let s = 0; s < n; s++) seq.push(`${b.addr}#${s}`);
    }
    const starts = new Map();
    let from = 0;
    (drill.steps || []).forEach((st, j) => {
      let at = seq.indexOf(keyOf(st), from);
      if (at < 0) at = seq.indexOf(keyOf(st));
      if (at >= 0) { starts.set(seq[at], j); from = at + 1; }
    });
    const owner = new Map();
    let j = -1;
    for (const k of seq) {
      if (starts.has(k)) j = starts.get(k);
      owner.set(k, j);
    }
    return { addrs: new Set(barsIn.map((b) => b.addr)), starts, owner };
  }

  /**
   * What one drawn slot shows. Chords: everything. Phrases: letters only, the active
   * line as "?" slots that fill in. Play through: everything, or in Blind only what
   * was already played (dimmed) and a missed chord. `keys` is one slot key — or, for
   * a `%` bar, every slot it repeats: "%" may only show once all of them may.
   */
  function visibility(keys, env) {
    const out = { show: false, q: false, played: false, cur: false, warn: false };
    const live = drill.state === "live" && !drill.passed;
    if (env.ph && keys.some((k) => env.ph.owner.has(k))) {
      const seen = (j) => drill.passed || (j >= 0 && (j < drill.stepIdx || drill.revealed.has(j)));
      const starts = keys.filter((k) => env.ph.starts.has(k)).map((k) => env.ph.starts.get(k));
      if (starts.length) {
        out.cur = live && starts.includes(drill.stepIdx);
        out.warn = starts.some((j) => drill.revealed.has(j));
        if (starts.every(seen)) out.show = true;
        else out.q = true;
      } else {
        const j = env.ph.owner.get(keys[0]);
        out.show = seen(j === undefined ? -1 : j);
      }
      return out;
    }
    if (env.mode === "phrases") return out;          // the rest of the chart: letters only
    if (env.run) {
      const r = env.run;
      const isCur = keys.includes(r.cur);
      out.cur = isCur && drill.state === "live";
      out.warn = keys.some((k) => r.missed.has(k));
      if (keys.every((k) => r.played.has(k))) {
        out.show = true;
        out.played = true;
        return out;
      }
      if (isCur && r.curRevealed) {
        out.show = true;
        return out;
      }
    }
    out.show = !env.blind;
    return out;
  }

  // ── the chart ───────────────────────────────────────────────────────────
  function slotNode(bar, i, slot, env, beats) {
    const n = bar.repeat ? Math.max(1, (bar.slots || []).length) : 1;
    const keys = Array.from({ length: n }, (_, k) => `${bar.addr}#${bar.repeat ? k : i}`);
    const node = h("div", { class: "sg-slot" });
    node.style.flexGrow = String(beats);
    node.append(h("span", { class: "sg-beats", "aria-hidden": "true" },
      ...Array.from({ length: Math.max(1, Math.round(beats)) }, () => h("i", { text: "/" }))));
    let kind = "chord";
    if (bar.repeat) kind = "repeat";
    else if (!slot || isHold(bar)) kind = "none";
    else if (isRest(slot)) kind = "rest";
    if (kind === "none") return node;
    const vis = visibility(keys, env);
    if (vis.cur) {
      node.classList.add("cur");
      env.cursor = node;
    }
    if (vis.q) {
      node.append(h("span", { class: "sg-sym q", text: "?" }));
      return node;
    }
    if (!vis.show) return node;
    if (vis.played) node.classList.add("played");
    if (kind === "repeat") {
      node.append(h("span", { class: "sg-sym dim", text: "%", title: "the previous bar again" }));
      return node;
    }
    if (kind === "rest") {
      node.append(h("span", { class: "sg-sym dim", text: "N.C." }));
      return node;
    }
    const readable = slot.ok !== false;
    const text = slot.play || slot.symbol;
    const sym = h("span", { class: `sg-sym${readable ? "" : " unread"}${vis.warn ? " warn" : ""}`,
      text: pretty(text), title: readable ? pretty(slot.symbol) : `${slot.symbol} — not readable` });
    const rgb = vis.warn ? null : rgbFor(text);
    if (rgb) {
      tintChord(sym, rgb);
      node.style.background = css(rgb, 0.07);
    }
    if (env.hit && slot.play === env.hit) node.classList.add("hit");
    node.append(sym);
    return node;
  }

  function barNode(bar, env) {
    const node = h("div", { class: "sg-bar", "data-addr": bar.addr });
    if (bar.volta !== null && bar.volta !== undefined) {
      node.classList.add("volta");
      node.append(h("span", { class: "sg-volta", text: `${bar.volta}.` }));
    }
    if (env.ph && env.ph.addrs.has(bar.addr)) node.classList.add("act");
    const slots = bar.slots || [];
    const perBar = song.beats_per_bar || 4;
    if (bar.repeat || !slots.length) node.append(slotNode(bar, 0, slots[0] || null, env, perBar));
    else slots.forEach((s, i) => node.append(slotNode(bar, i, s, env, Number(s.beats) || 1)));
    const n = misses.get(bar.addr);
    if (n) {
      node.classList.add("miss");
      node.append(h("span", { class: "sg-miss", text: `×${n}`,
        title: `${plural(n, "wrong attempt")} here last time` }));
    }
    return node;
  }

  function renderChart() {
    if (!song) {
      chartEl.replaceChildren();
      return;
    }
    const on = overlayOn();
    const env = {
      mode: uiMode,
      blind: uiMode === "play" && blind,
      // a finished phrase session lets go of its last line; a play-through keeps where it got to
      ph: on && uiMode === "phrases" && drill.state !== "done" ? phraseOverlay() : null,
      run: on && uiMode === "play" ? runOverlay() : null,
      hit: on && uiMode === "chords" && drill.state === "live" ? drill.chord : null,
      cursor: null,
    };
    chartEl.replaceChildren(...(song.sections || []).map((sec) =>
      h("div", { class: "sg-sec", "data-label": sec.label },
        h("div", { class: "sg-sec-label" }, h("span", { class: "sg-mark", text: sec.label, title: sec.label })),
        h("div", { class: "sg-lines" }, ...(sec.lines || []).map((line) =>
          h("div", { class: "sg-line" }, ...(line.bars || []).map((bar) => barNode(bar, env))))))));
    // A long chart scrolls inside itself; keep the cursor in sight.
    const c = env.cursor;
    if (c && typeof c.scrollIntoView === "function" && chartEl.scrollHeight > chartEl.clientHeight) {
      c.scrollIntoView({ block: "nearest" });
    }
  }

  // ── check ───────────────────────────────────────────────────────────────
  const inputs = new Map();      // addr -> <input> of the current check render
  let checkGen = 0;

  function setCheckNote(text, kind) {
    checkNote = { text: text || "", kind: kind || "" };
    renderCheckNote();
  }

  function renderCheckNote() {
    const parts = [];
    const j = rereadJob ? jobs.get(rereadJob) : null;
    if (j) parts.push(jobRow(j, true));
    if (checkNote.text) {
      parts.push(h("span", { class: `sg-status${checkNote.kind ? ` is-${checkNote.kind}` : ""}`,
        text: checkNote.text }));
    }
    cMsg.replaceChildren(...parts);
    cMsg.hidden = !parts.length;
    rereadBtn.disabled = !!(j && !jobDone(j));
  }

  function formOf(s) {
    return Array.isArray(s.form) ? s.form.slice() : String(s.form || "").split(/\s+/).filter(Boolean);
  }

  function renderCheck(o = {}) {
    if (!song) return;
    cTitle.textContent = song.title || song.id;
    cMeta.textContent = [song.key, song.time].filter(Boolean).join(" · ");
    renderPage();
    renderInputs(o);
    renderForm();
    renderDelete();
    renderCheckNote();
  }

  // The page only re-renders when it changes: a bar edit must not reload the PDF.
  function renderPage() {
    const p = song.page;
    const k = p && p.url ? `${p.url}|${p.mime}` : "none";
    if (k === pageKey) return;
    pageKey = k;
    if (!p || !p.url) {
      pageEl.replaceChildren(h("div", { class: "sg-empty", text: "no page" }));
      return;
    }
    const mime = String(p.mime || "");
    const openLink = () => h("a", { class: "sg-link", href: p.url, target: "_blank", rel: "noopener",
      text: "open it" });
    if (mime === "application/pdf") {
      pageEl.replaceChildren(h("iframe", { class: "sg-pdf", src: p.url, title: p.name || "page" }));
    } else if (mime.startsWith("image/")) {
      // A HEIC (or any image this browser can't decode) falls back to the raster Claude read.
      const srcs = [p.url, ...(song.reads ? [`${API}/${enc(song.id)}/read/1`] : [])];   // 1-based
      let at = 0;
      const img = h("img", { class: "sg-img", src: srcs[0], alt: p.name || "the page",
        title: "click to zoom to the page width",
        onclick: () => pageEl.classList.toggle("zoom") });
      img.onerror = () => {
        at += 1;
        if (at < srcs.length) img.src = srcs[at];
        else pageEl.replaceChildren(h("div", { class: "sg-empty" }, "This page can't be shown here — ", openLink()));
      };
      pageEl.replaceChildren(img);
    } else {
      pageEl.replaceChildren(h("div", { class: "sg-empty" }, `${p.name || "The page"} — `, openLink()));
    }
  }

  function nextAddr(addr) {
    const i = addrOrder.indexOf(addr);
    return i >= 0 && i + 1 < addrOrder.length ? addrOrder[i + 1] : null;
  }

  function renderInputs(o) {
    const gen = ++checkGen;
    // Keep the caret where it was across a re-render (a WS echo, a neighbour's save).
    const active = document.activeElement;
    const activeAddr = active && typeof active.getAttribute === "function" ? active.getAttribute("data-addr") : null;
    const carry = activeAddr && inputs.get(activeAddr) === active
      ? { addr: activeAddr, value: active.value, a: active.selectionStart, b: active.selectionEnd } : null;
    inputs.clear();
    const flags = new Map();
    for (const f of song.flags || []) if (f && f.addr && !flags.has(f.addr)) flags.set(f.addr, f);
    const probs = new Map();
    for (const p of song.problems || []) if (p && p.addr && !probs.has(p.addr)) probs.set(p.addr, p);
    editEl.replaceChildren(...(song.sections || []).map((sec) =>
      h("div", { class: "sg-esec" },
        h("div", { class: "sg-sec-label" }, h("span", { class: "sg-mark", text: sec.label, title: sec.label })),
        h("div", { class: "sg-elines" }, ...(sec.lines || []).map((line) =>
          h("div", { class: "sg-eline" }, ...(line.bars || []).map((bar) =>
            barEditor(bar, flags.get(bar.addr), probs.get(bar.addr), gen))))))));
    const focusAddr = o.focus || (carry && carry.addr);
    const target = focusAddr ? inputs.get(focusAddr) : null;
    if (!target) return;
    if (!o.focus && carry && carry.value !== target.value) target.value = carry.value;
    target.focus();
    if (o.focus && typeof target.select === "function") target.select();
    else if (carry && typeof target.setSelectionRange === "function" && carry.a !== null && carry.a !== undefined) {
      try { target.setSelectionRange(carry.a, carry.b); } catch { /* not a text input */ }
    }
  }

  function barEditor(bar, flag, prob, gen) {
    const original = bar.text ?? "";
    const input = h("input", { class: `sg-in${flag ? " flag" : ""}${prob ? " prob" : ""}`, value: original,
      spellcheck: false, autocomplete: "off", "data-addr": bar.addr, "aria-label": `bar ${bar.addr}`,
      title: prob ? prob.message : flag ? flag.message || "flagged" : bar.addr });
    const errEl = h("div", { class: "sg-pmsg", hidden: true });
    const cell = h("div", { class: "sg-ebar" }, input);
    cell.style.flexGrow = String(Math.max(6, String(bar.text ?? "").length));   // "D-7/C:2 C#-7:1"
    let saving = false;

    async function save(text, next) {
      if (saving || gen !== checkGen || !song) return;
      saving = true;
      const r = await call("PUT", `${API}/${enc(song.id)}/bar/${enc(bar.addr)}`, { text });
      saving = false;
      if (!alive || !song) return;
      if (r.ok && r.body && r.body.sections) {
        setSong(r.body);
        renderCheck({ focus: next ? nextAddr(bar.addr) || undefined : undefined });
        return;
      }
      if (r.ok) {
        await reloadSong(true);
        return;
      }
      const detail = detailOf(r) || `could not save (${r.status || "no answer"})`;
      input.classList.add("bad");
      input.title = detail;
      errEl.textContent = detail;
      errEl.hidden = false;
    }

    function commit(next) {
      if (gen !== checkGen) return;           // a stale input from an earlier render
      const text = input.value.trim();
      if (text === original) {
        if (next) {
          const n = nextAddr(bar.addr);
          if (n && inputs.get(n)) inputs.get(n).focus();
        }
        return;
      }
      save(text, next);
    }

    input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        input.value = original;
        input.classList.remove("bad");
        errEl.hidden = true;
        input.blur();
      }
    };
    input.onblur = () => commit(false);

    if (flag && flag.other !== undefined && flag.other !== null && flag.other !== "") {
      cell.append(h("button", { class: "sg-chip", text: `other read: ${flag.other}`,
        title: `${flag.message || "the second read differs"} — use it`,
        onclick: () => save(String(flag.other), false) }));
    } else if (flag) {
      cell.append(h("div", { class: "sg-fmsg", text: flag.message || "unsure" }));
    }
    if (prob) cell.append(h("div", { class: "sg-pmsg", text: prob.message || "does not parse" }));
    cell.append(errEl);
    inputs.set(bar.addr, input);
    return cell;
  }

  /**
   * Sections & form: the written sections as chips (click = append to the form),
   * the form as chips in play order (× removes one), "Written order" resets.
   * Every change is one PATCH {form: "A A B Ending"}; "" means written order.
   */
  function renderForm() {
    const form = formOf(song);
    const written = (song.sections || []).map((s) => s.label);
    formEl.replaceChildren(
      h("div", { class: "sg-form-head", text: "Sections & form" }),
      h("div", { class: "sg-form-row" },
        h("span", { class: "sg-form-lbl", text: "Form" }),
        ...form.map((label, i) => h("span", { class: "sg-fchip", "data-i": String(i) }, label,
          h("button", { text: "×", title: `take this ${label} out of the form`,
            "aria-label": `remove ${label} (${ordinal(i + 1)} in the form)`,
            onclick: () => patchForm(form.filter((_, k) => k !== i).join(" ")) }))),
        form.join(" ") === written.join(" ") ? null
          : h("button", { class: "sg-link", text: "Written order", title: "each written section once, top to bottom",
            onclick: () => patchForm("") })),
      h("div", { class: "sg-form-row" },
        h("span", { class: "sg-form-lbl", text: "Sections" }),
        ...(song.sections || []).map((sec) => {
          const lines = sec.lines || [];
          const nb = lines.reduce((a, l) => a + (l.bars || []).length, 0);
          return h("button", { class: "sg-schip", "data-label": sec.label, title: `add ${sec.label} to the end of the form`,
            onclick: () => patchForm([...form, sec.label].join(" ")) },
          h("b", { text: sec.label }), `${plural(lines.length, "line")} · ${plural(nb, "bar")}`);
        })),
      ...formWarnings(),
      ...(formNote ? [h("div", { class: "sg-form-msg", text: formNote })] : []));
  }

  /** What the form editor must say out loud: the two reads disagreed on the form (a flag
   *  with addr "form" and the other read's form, one click to use it), and any song-level
   *  problem such as a written section the form never plays. */
  function formWarnings() {
    const out = [];
    const flag = (song.flags || []).find((f) => f && f.addr === "form");
    if (flag) {
      const other = String(flag.other || "");
      out.push(h("div", { class: "sg-form-warn" }, `${flag.message || "the reads disagree on the form"} · `,
        h("button", { class: "sg-chip", text: `other read: ${other || "written order"}`,
          title: "use the other read's form", onclick: () => patchForm(other) })));
    }
    for (const p of song.problems || []) {
      if (p && !p.addr) out.push(h("div", { class: "sg-form-warn", text: p.message }));
    }
    return out;
  }

  async function patchForm(next) {
    if (formBusy || !song) return;
    formBusy = true;
    const r = await call("PATCH", `${API}/${enc(song.id)}`, { form: next });
    formBusy = false;
    if (!alive || !song) return;
    if (r.ok) {
      formNote = "";
      if (r.body && r.body.sections) {
        setSong(r.body);
        renderCheck();
      } else {
        await reloadSong(true);
      }
      return;
    }
    formNote = detailOf(r) || "That form was refused.";
    renderForm();
  }

  async function markChecked() {
    if (!song) return;
    const r = await call("PATCH", `${API}/${enc(song.id)}`, { checked: true });
    if (!alive || !song) return;
    if (!r.ok) {
      setCheckNote(detailOf(r) || "Could not mark it checked.", "err");
      return;
    }
    if (r.body && r.body.sections) setSong(r.body);
    else await reloadSong(true);
    showSong();
    setStatus("Checked ✓ — chords and form match the page.", "ok");
  }

  async function toggleText(on = textWrap.hidden) {
    if (!on) {
      textWrap.hidden = true;
      editEl.hidden = false;
      formEl.hidden = false;
      textBtn.classList.remove("on");
      return;
    }
    textErr.replaceChildren();
    textArea.value = "";
    textArea.disabled = true;
    textWrap.hidden = false;
    editEl.hidden = true;
    formEl.hidden = true;                 // the text carries its own form: line
    textBtn.classList.add("on");
    const r = await call("GET", `${API}/${enc(song.id)}/text`);
    if (!alive) return;
    textArea.disabled = false;
    if (r.ok && r.body) textArea.value = r.body.text ?? "";
    else textErr.replaceChildren(h("div", { text: detailOf(r) || "Could not load the song text." }));
  }

  async function saveText() {
    if (!song) return;
    const r = await call("PUT", `${API}/${enc(song.id)}/text`, { text: textArea.value });
    if (!alive || !song) return;
    if (r.ok) {
      if (r.body && r.body.sections) setSong(r.body);
      else await reloadSong(true);
      toggleText(false);
      renderCheck();
      setCheckNote("Saved.", "ok");
      return;
    }
    textErr.replaceChildren(
      h("div", { text: detailOf(r) || "The text does not parse." }),
      ...errorsOf(r).map((e) => h("div", { class: "sg-err-line", text: errText(e) })));
  }

  async function reread() {
    if (!song) return;
    rereadBtn.disabled = true;
    setCheckNote("", "");
    const r = await call("POST", `${API}/${enc(song.id)}/reread`);
    if (!alive) return;
    const j = r.ok ? jobFrom(r.body) : null;
    if (j) {
      rereadJob = String(j.job);
      upsertJob(j);
      renderCheckNote();
    } else {
      rereadBtn.disabled = false;
      setCheckNote(detailOf(r) || "Could not start a re-read.", "err");
    }
  }

  function renderDelete() {
    if (!delArmed) {
      delWrap.replaceChildren(h("button", { class: "btn sg-danger", text: "Delete song",
        onclick: () => { delArmed = true; renderDelete(); } }));
      return;
    }
    delWrap.replaceChildren(
      h("span", { class: "sg-confirm", text: "Really delete?" }),
      h("button", { class: "btn sg-yes", text: "Yes", onclick: () => doDelete() }),
      h("button", { class: "btn", text: "No", onclick: () => { delArmed = false; renderDelete(); } }));
  }

  async function doDelete() {
    if (!song) return;
    const sid = song.id;
    const r = await call("DELETE", `${API}/${enc(sid)}`);
    if (!alive) return;
    delArmed = false;
    if (!r.ok) {
      renderDelete();
      setCheckNote(detailOf(r) || "Could not delete the song.", "err");
      return;
    }
    song = null;
    show("add");
    say(addMsg, "Deleted — it's kept in songs/.trash.", "");
    loadList();
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  const offs = [
    ctx.on("prompt", onPrompt),
    ctx.on("step", onStep),
    ctx.on("attempt", onAttempt),
    ctx.on("passed", onPassed),
    ctx.on("done", onDone),
    ctx.on("error", onError),
    ctx.on("held", (m) => piano.setHeld(m.notes || [])),
    ctx.on("hello", (m) => syncDrill(m.status && m.status.drill)),
    ctx.on("songs", (m) => {
      if (m.event === "import") upsertJob(m);
      else if (m.event === "changed") {
        loadList();
        if (song && m.song === song.id) reloadSong();
      } else if (m.event === "receipt" && song && m.song === song.id) {
        applyReceipt(m.receipt, false);
      }
    }),
    ctx.on("srs", () => { if (song) reloadSong(true); }),   // the stepper names the backend
  ];
  document.addEventListener("paste", onPaste);
  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);

  renderJobs();
  loadList();
  loadJobs();
  if (opts.song) openSong(opts.song);
  else show("add");
  if (screen === "add" && !offline) urlIn.focus();       // + Add song: ready to paste a link
  call("GET", "/api/trainer/status").then((r) => {
    if (alive && r.ok && r.body) syncDrill(r.body.drill);
  });
  if (opts.importNow) {
    const { files, url } = opts.importNow;
    if (files && files.length) [...files].forEach((f) => importFile(f));
    else if (url) importUrl(url);
  }

  return () => {
    alive = false;
    offs.forEach((off) => off());
    document.removeEventListener("paste", onPaste);
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
    if (ticker) clearInterval(ticker);
    piano.setHint([]);
  };
}
