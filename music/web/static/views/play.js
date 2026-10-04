// Play: the landing pane. Play the keyboard and see what you hold; no flashcards, no drill.
//
// mount(el, ctx, opts) -> unmount. The Practice tab (views/practice.js) shows it as its first
// item and lands on it when nothing is remembered. The pane only listens to one message:
//
//   held  {notes: [midi], pcs: [pc], names: [{name, exact}]}   (up to 2 readings; none below 2 pcs)
//
// - The chord, big and centered: names[0], in its root's color (colors.js, as the song chart
//   paints chords). names[1] sits small and dim beside it only when it is exact too: a real
//   second reading (C6 / Am7/C). An inexact one (Cmaj7 → "C") is noise. With no name, the
//   notes themselves ("E4", "C4 · E4"), each in its own color. Nothing held: a quiet dash.
// - The notes, one small line ("C4 · E4 · G4 · B4"), under a named chord only: without a
//   name, the big line already says them.
// - The piano, the pane's full width: click to play (note_in, as the trainer pane), held keys lit.
// - Until the first note of this visit, one line says how to play. It is not remembered.
// Nothing else: no Start, no cards, no grade, no counters, no history. Chord names keep the
// song pane's real flats and sharps (pretty); notes are spelled as theory/pitch.py (staff.js).

import { makePiano } from "../keyboard.js";
import { rgbOf } from "../colors.js";
import { spell } from "../staff.js";
import { pretty, rgbFor, tintChord } from "./songs.js";

export const id = "play";
export const title = "Play";

const HINT = "Play your MIDI keyboard, click the keys, or turn on 🎹 Musical typing";

let playedThisVisit = false;     // the visit's first note hides the hint; a reload brings it back

const CSS = `
.pl { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
.pl [hidden] { display: none !important; }
.pl-stage { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px; text-align: center; }
.pl-chord { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: center; column-gap: 26px;
  font-size: clamp(64px, 9vw, 128px); font-weight: 600; line-height: 1.05; letter-spacing: -0.02em; }
.pl-chord.pl-bare { font-size: clamp(40px, 5vw, 72px); }
.pl-chord.idle .pl-name { color: #3b3b44; font-weight: 300; }
.pl-alt { font-size: clamp(22px, 2.6vw, 36px); font-weight: 500; letter-spacing: -0.01em; color: var(--dim); }
.pl-sep { color: var(--dim); font-weight: 300; }
.pl-notes { font-size: 16px; letter-spacing: .02em; color: var(--dim); }
.pl-hint { font-size: 15px; color: var(--dim); }
.pl .pl-keys.piano-wrap { flex: none; }
.pl .pl-keys.piano-wrap svg.piano { max-width: none; margin: 0; }
`;

function inject() {
  if (document.getElementById("play-css")) return;
  const style = document.createElement("style");
  style.id = "play-css";
  style.textContent = CSS;
  document.head.append(style);
}

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "title" || k === "hidden") node[k] = v;
    else node.setAttribute(k, String(v));
  }
  if (kids.length) node.append(...kids);
  return node;
}

/** MIDI → "C♯4" (middle C = C4), spelled as theory/pitch.py note_name. */
const noteText = (n) => pretty(spell(n).name);

/** One note in its own color (Tyler's palette, colors.js). */
function noteSpan(n) {
  const span = h("span", { text: noteText(n) });
  tintChord(span, rgbOf(n % 12));
  return span;
}

export function mount(el, ctx, opts = {}) {
  inject();
  const nameEl = h("span", { class: "pl-name" });
  const altEl = h("span", { class: "pl-alt", hidden: true, title: "the same notes, read another way" });
  const chordEl = h("div", { class: "pl-chord" }, nameEl, altEl);
  const notesEl = h("div", { class: "pl-notes", hidden: true });
  const hintEl = h("div", { class: "pl-hint", text: HINT });
  const keysEl = h("div", { class: "piano-wrap pl-keys" });
  el.replaceChildren(h("div", { class: "pl" }, h("div", { class: "pl-stage" }, chordEl, notesEl, hintEl), keysEl));
  const piano = makePiano(keysEl, { low: 36, high: 96,
    onPlay: (note, on, vel) => ctx.send({ type: "note_in", on, note, vel }) });

  function show(m) {
    const notes = (Array.isArray(m && m.notes) ? m.notes : []).map(Number).filter(Number.isFinite)
      .sort((a, b) => a - b);
    const names = notes.length && Array.isArray(m.names) ? m.names.filter((r) => r && r.name) : [];
    piano.setHeld(notes);
    if (notes.length) playedThisVisit = true;
    hintEl.hidden = playedThisVisit;
    const top = names[0] || null;
    const alt = names[1] && names[1].exact === true ? names[1] : null;
    chordEl.classList.toggle("idle", notes.length === 0);
    chordEl.classList.toggle("pl-bare", !top && notes.length > 0);
    if (top) {
      nameEl.replaceChildren(pretty(top.name));
      tintChord(nameEl, rgbFor(top.name));
    } else if (notes.length) {
      nameEl.replaceChildren(...notes.flatMap((n, i) => (i ? [h("span", { class: "pl-sep", text: " · " }), noteSpan(n)]
        : [noteSpan(n)])));
      tintChord(nameEl, null);
    } else {
      nameEl.replaceChildren("—");
      tintChord(nameEl, null);
    }
    altEl.textContent = alt ? pretty(alt.name) : "";
    altEl.hidden = !alt;
    notesEl.textContent = top ? notes.map(noteText).join(" · ") : "";
    notesEl.hidden = !top;
  }

  show(null);
  const offs = [
    ctx.on("held", show),
    ctx.on("_close", () => show(null)),            // no server: nothing is known to be held
  ];
  return () => offs.forEach((off) => off());
}
