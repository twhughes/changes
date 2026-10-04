// Musical typing — the laptop keyboard as a piano, Logic Pro's layout:
//
//     W E   T Y U   O P          black keys
//    A S D F G H J K L ; '       white keys  C D E F G A B C D E F
//   Z / X = octave down / up      C / V = softer / harder
//
// OFF by default (it steals letters from the page). Ignored while an input,
// textarea or select has focus. Held keys are tracked so auto-repeat doesn't
// retrigger and a lost keyup (⌘-tab) is cleaned up on blur.
//
// While on, the letters sit on the on-screen piano itself (keyboard.js asks
// typingLetters() and listens with onTypingChange) — one keyboard on screen, nothing
// floating over the piano (Tyler, 2026-10-04: "musical keyboard blocks the keyboard
// display"). The button says what it is in words — "🎹 Musical typing" (the ⌨ glyph read as
// a blank bar) — and the octave while it is on; its tooltip has the keys and the velocity.

const LAYOUT = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
                 k: 12, o: 13, l: 14, p: 15, ";": 16, "'": 17 };

// ── the page-wide state the pianos read ─────────────────────────────────────
let current = { on: false, octave: 4 };
const listeners = new Set();

/** midi → the computer key that plays it ("A", "W", ";" …); empty while typing is off. */
export function typingLetters() {
  const out = new Map();
  if (!current.on) return out;
  for (const [key, step] of Object.entries(LAYOUT)) out.set((current.octave + 1) * 12 + step, key.toUpperCase());
  return out;
}

/** Call fn() whenever the letters change (on/off, octave). Returns the unsubscribe. */
export function onTypingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* one broken piano must not stop the rest */ }
  }
}

export function mountTyping(ctx, button) {
  let on = false;
  let octave = 4;           // 'a' = C4 (MIDI 60)
  let vel = 100;
  const held = new Map();   // key -> midi note

  const tip = () => (on
    ? `musical typing on — A … ' play (W E T Y U O P are the black keys), Z / X octave, `
      + `C / V softer / harder (velocity ${vel})`
    : "musical typing: play from the computer keyboard (off)");
  function label() {
    button.textContent = on ? `🎹 Musical typing · C${octave}` : "🎹 Musical typing";
    button.classList.toggle("on", on);
    button.title = tip();
    const changed = current.on !== on || current.octave !== octave;
    current = { on, octave };
    if (changed) announce();
  }
  const send = (note, isOn) => ctx.send({ type: "note_in", on: isOn, note, vel });
  const inField = (ev) => /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || "");
  const allOff = () => { for (const n of held.values()) send(n, false); held.clear(); };

  function keydown(ev) {
    if (!on || inField(ev) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k === "z") { allOff(); octave = Math.max(0, octave - 1); label(); ev.preventDefault(); return; }
    if (k === "x") { allOff(); octave = Math.min(8, octave + 1); label(); ev.preventDefault(); return; }
    if (k === "c") { vel = Math.max(20, vel - 16); button.title = tip(); ev.preventDefault(); return; }
    if (k === "v") { vel = Math.min(127, vel + 16); button.title = tip(); ev.preventDefault(); return; }
    if (!(k in LAYOUT)) return;
    ev.preventDefault();
    if (held.has(k)) return;                       // auto-repeat
    const note = (octave + 1) * 12 + LAYOUT[k];
    held.set(k, note);
    send(note, true);
  }
  function keyup(ev) {
    const k = ev.key.toLowerCase();
    const note = held.get(k);
    if (note === undefined) return;
    held.delete(k);
    send(note, false);
  }

  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);
  window.addEventListener("blur", allOff);
  const toggle = () => { on = !on; if (!on) allOff(); label(); button.blur(); };
  button.onclick = toggle;
  label();
  return { isOn: () => on };
}
