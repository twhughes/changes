// SVG piano. Held keys tint blue; verdicts flash green/red per note from
// Verdict.per_note — the browser only paints, the matcher lives in theory/.
// A hint layer (setHint) tints suggested keys a soft gold underneath both: the
// "show keys" voicing a song step carries. Paint order: flash > held > hint.
// While ⌨ musical typing is on, each key it plays carries its computer key's letter.

import { onTypingChange, typingLetters } from "./typing.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);
const isWhite = (n) => WHITE_PCS.has(((n % 12) + 12) % 12);

const KEY_W = 22;
const KEY_H = 110;
const BLACK_W = 13;
const BLACK_H = 68;

const COLORS = {
  white: "#ececf0",
  black: "#1b1b1f",
  heldWhite: "#7aa2f7",
  heldBlack: "#3f6bd0",
  hintWhite: "#f0d48c",
  hintBlack: "#8d6c22",
  good: "#22c55e",
  bad: "#ef4444",
};

// onPlay(note, on): when given, the keys are clickable — press/drag plays,
// release stops. Velocity from where you hit the key (lower = harder).
export function makePiano(el, { low = 36, high = 96, flashMs = 800, onPlay = null } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "piano");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const whites = [];
  for (let n = low; n <= high; n++) if (isWhite(n)) whites.push(n);
  const whiteIndex = new Map(whites.map((n, i) => [n, i]));
  const width = whites.length * KEY_W;
  svg.setAttribute("viewBox", `0 0 ${width} ${KEY_H + 12}`);

  const keys = new Map(); // midi -> {rect, black}
  const held = new Set();
  const hints = new Set();
  const flashes = new Map(); // midi -> color

  const rect = (x, w, h, cls) => {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("x", x);
    r.setAttribute("y", 0);
    r.setAttribute("width", w);
    r.setAttribute("height", h);
    r.setAttribute("rx", 2);
    r.setAttribute("stroke", "#0b0b0d");
    r.setAttribute("stroke-width", cls === "black" ? 0.5 : 1);
    svg.append(r);
    return r;
  };

  for (const n of whites) {
    keys.set(n, { rect: rect(whiteIndex.get(n) * KEY_W, KEY_W, KEY_H, "white"), black: false });
    if (n % 12 === 0) {
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", whiteIndex.get(n) * KEY_W + KEY_W / 2);
      label.setAttribute("y", KEY_H + 9);
      label.setAttribute("text-anchor", "middle");
      label.textContent = `C${n / 12 - 1}`;
      svg.append(label);
    }
  }
  // Blacks last so they sit above the whites they overlap.
  for (let n = low; n <= high; n++) {
    if (isWhite(n) || !whiteIndex.has(n - 1)) continue;
    const x = (whiteIndex.get(n - 1) + 1) * KEY_W - BLACK_W / 2;
    keys.set(n, { rect: rect(x, BLACK_W, BLACK_H, "black"), black: true });
  }

  function paint(n) {
    const key = keys.get(n);
    if (!key) return;
    let fill = key.black ? COLORS.black : COLORS.white;
    if (hints.has(n)) fill = key.black ? COLORS.hintBlack : COLORS.hintWhite;
    if (held.has(n)) fill = key.black ? COLORS.heldBlack : COLORS.heldWhite;
    if (flashes.has(n)) fill = flashes.get(n);
    key.rect.setAttribute("fill", fill);
  }

  for (const n of keys.keys()) paint(n);

  // ⌨ letters, drawn over the keys (clicks pass through to the key underneath).
  const letters = document.createElementNS(SVG_NS, "g");
  letters.setAttribute("pointer-events", "none");
  letters.setAttribute("font-weight", "600");
  svg.append(letters);
  function drawLetters() {
    const marks = [];
    for (const [n, letter] of typingLetters()) {
      const key = keys.get(n);
      if (!key) continue;
      const t = document.createElementNS(SVG_NS, "text");
      const x = Number(key.rect.getAttribute("x")) + Number(key.rect.getAttribute("width")) / 2;
      t.setAttribute("x", x);
      t.setAttribute("y", key.black ? BLACK_H - 7 : KEY_H - 9);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", key.black ? "kb-letter on-black" : "kb-letter");   // style.css
      t.textContent = letter;
      marks.push(t);
    }
    letters.replaceChildren(...marks);
  }
  drawLetters();
  const offTyping = onTypingChange(() => {
    if (svg.isConnected === false) { offTyping(); return; }   // this piano's pane is gone
    drawLetters();
  });
  el.replaceChildren(svg);

  if (onPlay) {
    const noteAt = (target) => {
      for (const [n, k] of keys) if (k.rect === target) return n;
      return null;
    };
    let down = null;
    const velOf = (ev, n) => {
      const k = keys.get(n);
      const h = k.black ? BLACK_H : KEY_H;
      const box = k.rect.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (ev.clientY - box.top) / box.height));
      return Math.round(40 + 87 * frac);          // top = soft, bottom = hard
    };
    const press = (n, ev) => { if (n === null || n === down) return; release(); down = n; onPlay(n, true, velOf(ev, n)); };
    const release = () => { if (down !== null) { onPlay(down, false, 0); down = null; } };
    svg.style.cursor = "pointer";
    svg.style.touchAction = "none";
    svg.addEventListener("pointerdown", (ev) => { ev.preventDefault(); svg.setPointerCapture(ev.pointerId); press(noteAt(ev.target), ev); });
    svg.addEventListener("pointermove", (ev) => { if (down === null) return; const t = document.elementFromPoint(ev.clientX, ev.clientY); press(noteAt(t), ev); });
    svg.addEventListener("pointerup", release);
    svg.addEventListener("pointercancel", release);
    svg.addEventListener("lostpointercapture", release);
  }

  let timer = null;

  return {
    setHeld(notes) {
      const next = new Set(notes);
      const touched = new Set([...held, ...next]);
      held.clear();
      for (const n of next) held.add(n);
      for (const n of touched) paint(n);
    },
    // notes: MIDI numbers to suggest (a hint, never a verdict); [] or null clears.
    setHint(notes) {
      const next = new Set(notes || []);
      const touched = new Set([...hints, ...next]);
      hints.clear();
      for (const n of next) hints.add(n);
      for (const n of touched) paint(n);
    },
    // perNote: [[midi, "chord-tone" | "bass" | "extra"], ...]
    flash(perNote) {
      flashes.clear();
      for (const [note, tag] of perNote || []) {
        flashes.set(note, tag === "extra" ? COLORS.bad : COLORS.good);
      }
      for (const n of keys.keys()) paint(n);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        flashes.clear();
        for (const n of keys.keys()) paint(n);
      }, flashMs);
    },
  };
}
