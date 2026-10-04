// staff.js — SVG music engraving as pure functions (no DOM, runs in node too).
//
// Middle C = 60 = C4. Default spelling is sharps except Eb/Ab/Bb; a flat key
// spells flats, a sharp key spells sharps. Every function returns a string.
//
//   import { staffSVG, grandStaffSVG, leadSheetSVG, layoutNotes } from "./staff.js";
//
//   layoutNotes({clef, pitches, key, width, height})   -> layout object (no SVG)
//   staffSVG({clef, pitches, key, width, height, label, color, bg, colorNotes})
//   grandStaffSVG({pitches, key, width, height, split})   split: notes >= it go treble (60)
//   leadSheetSVG({bars, barsPerLine, width, key, cursor, color, bg})
//
//   staffSVG({clef: "treble", pitches: [64, 67], key: "C", width: 320, height: 160})
//   grandStaffSVG({pitches: [48, 64], key: "F"})
//   leadSheetSVG({bars: [{chord: "Dm7", beats: 4, label: "A"}, {chord: "G7", beats: 4}],
//                 barsPerLine: 4, width: 900, cursor: {bar: 1, beat: 2}})
//
// clef is "treble" | "bass" | "grand" ("grand" in staffSVG delegates to
// grandStaffSVG). Dark-theme friendly: stroke #d8d8de on a transparent ground;
// pass `color`/`bg` to change that. Everything scales from `width`/`height`.
// Classes for the caller to style or move: staffline ledger clef keysig
// accidental note bar barline chord slash cursor label.

import { rgbOf } from "./colors.js";

// ── note names / spelling ───────────────────────────────────────────────────

const LETTER_STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

/** Default spelling — matches music.theory.pitch._PC_NAMES. */
const SPELL_DEFAULT = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const SPELL_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SPELL_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

const SHARP_KEYS = { G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7 };
const FLAT_KEYS = { F: 1, Bb: 2, Eb: 3, Ab: 4, Db: 5, Gb: 6, Cb: 7 };

/** Order the accidentals appear in a key signature. */
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

/** Staff position (half-gaps below the top line) of each key-signature mark, treble. */
const SHARP_POS_TREBLE = [0, 3, -1, 2, 5, 1, 4];
const FLAT_POS_TREBLE = [4, 1, 5, 2, 6, 3, 7];

/** Diatonic step (octave * 7 + letter) sitting on the TOP line of each clef. */
const CLEF_TOP_STEP = { treble: 38, bass: 26 };   // F5, A3
/** Bass positions are the treble ones pushed down a third. */
const CLEF_KEY_SHIFT = { treble: 0, bass: 2 };

const GLYPH = { "-2": "♭♭", "-1": "♭", 0: "♮", 1: "♯", 2: "♯♯" };

const num = (v) => Math.round(v * 100) / 100;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "Bbm" / "a minor" / "C" → {name, accidental: "sharp"|"flat"|null, count, table}. */
export function keyInfo(key) {
  let text = String(key == null ? "C" : key).trim();
  text = text.replace(/♯/g, "#").replace(/♭/g, "b");
  let minor = false;
  const m = text.match(/^([A-Ga-g][#b]?)\s*(m|min|minor)?$/);
  if (!m) return { name: "C", accidental: null, count: 0, table: SPELL_DEFAULT };
  let name = m[1][0].toUpperCase() + m[1].slice(1);
  if (m[2]) minor = true;
  if (minor) {
    // relative major of each minor tonic
    const REL = {
      A: "C", E: "G", B: "D", "F#": "A", "C#": "E", "G#": "B", "D#": "F#", "A#": "C#",
      D: "F", G: "Bb", C: "Eb", F: "Ab", Bb: "Db", Eb: "Gb", Ab: "Cb" };
    name = REL[name] || "C";
  }
  if (name in SHARP_KEYS) return { name, accidental: "sharp", count: SHARP_KEYS[name], table: SPELL_SHARP };
  if (name in FLAT_KEYS) return { name, accidental: "flat", count: FLAT_KEYS[name], table: SPELL_FLAT };
  return { name: "C", accidental: null, count: 0, table: SPELL_DEFAULT };
}

/** MIDI number → {midi, name, letter, alter, octave, step} spelled for `key`. */
export function spell(midi, key = "C") {
  const info = keyInfo(key);
  const name = info.table[((midi % 12) + 12) % 12];
  const letter = name[0];
  const alter = name.length > 1 ? (name[1] === "#" ? 1 : -1) : 0;
  const octave = Math.floor(midi / 12) - 1;
  return { midi, name: name + octave, letter, alter, octave, step: octave * 7 + LETTER_STEP[letter] };
}

/** letter → alteration the key signature already applies (0 when untouched). */
function keyAlterMap(key) {
  const info = keyInfo(key);
  const map = {};
  const order = info.accidental === "sharp" ? SHARP_ORDER : FLAT_ORDER;
  for (let i = 0; i < info.count; i++) map[order[i]] = info.accidental === "sharp" ? 1 : -1;
  return map;
}

/** The key signature marks for a clef: [{letter, glyph, pos}] in writing order. */
export function keySignature(key, clef = "treble") {
  const info = keyInfo(key);
  if (!info.count) return [];
  const sharp = info.accidental === "sharp";
  const order = sharp ? SHARP_ORDER : FLAT_ORDER;
  const base = sharp ? SHARP_POS_TREBLE : FLAT_POS_TREBLE;
  const shift = CLEF_KEY_SHIFT[clef] || 0;
  const marks = [];
  for (let i = 0; i < info.count; i++) {
    marks.push({ letter: order[i], glyph: sharp ? GLYPH[1] : GLYPH[-1], pos: base[i] + shift });
  }
  return marks;
}

// ── geometry ────────────────────────────────────────────────────────────────

function metrics(o) {
  const width = o.width || 320;
  const height = o.height || 160;
  const gap = o.gap || height / 10;
  const top = o.top != null ? o.top : (height - 4 * gap) / 2;
  return { width, height, gap, top, bottom: top + 4 * gap };
}

/**
 * Lay out one staff-worth of notes. Returns positions in SVG user units.
 * clef "grand" returns {clef: "grand", staves: [trebleLayout, bassLayout]}.
 */
export function layoutNotes(opts = {}) {
  const clef = opts.clef || "treble";
  const key = opts.key || "C";
  const pitches = (opts.pitches || []).slice().sort((a, b) => a - b);
  if (clef === "grand") return layoutGrand({ ...opts, pitches, key });

  const m = metrics(opts);
  const { gap, top } = m;
  const left = opts.left != null ? opts.left : 0.7 * gap;
  const right = opts.right != null ? opts.right : m.width - 0.7 * gap;

  const marks = keySignature(key, clef);
  const clefW = clef === "bass" ? 3.0 * gap : 3.1 * gap;
  const keyW = marks.length ? marks.length * 0.62 * gap + 0.4 * gap : 0;
  const clefX = left;
  const keyX = clefX + clefW;
  const notesLeft = keyX + keyW;

  const topStep = CLEF_TOP_STEP[clef] != null ? CLEF_TOP_STEP[clef] : CLEF_TOP_STEP.treble;
  const yOf = (pos) => top + pos * (gap / 2);

  const keyMarks = marks.map((mk, i) => ({
    ...mk, x: num(keyX + 0.25 * gap + i * 0.62 * gap), y: num(yOf(mk.pos)),
  }));

  const rx = 0.62 * gap, ry = 0.44 * gap;
  const alters = keyAlterMap(key);
  const baseX = opts.x != null ? opts.x : (notesLeft + right) / 2;

  // stack: seconds get pushed a notehead to the right (ascending order)
  const notes = [];
  let prevPos = null, prevOffset = false;
  for (const midi of pitches) {
    const sp = spell(midi, key);
    const pos = topStep - sp.step;
    const offset = prevPos != null && prevPos - pos === 1 && !prevOffset;
    const y = yOf(pos);
    const x = baseX + (offset ? 2 * rx * 0.96 : 0);
    let accidental = null;
    if (sp.alter !== (alters[sp.letter] || 0)) accidental = GLYPH[sp.alter];
    notes.push({ midi, name: sp.name, letter: sp.letter, alter: sp.alter, step: sp.step,
      pos, x: num(x), y: num(y), offset, accidental, rx: num(rx), ry: num(ry),
      ledgerAbove: pos < 0 ? Math.floor(-pos / 2) : 0,
      ledgerBelow: pos > 8 ? Math.floor((pos - 8) / 2) : 0 });
    prevPos = pos; prevOffset = offset;
  }

  // accidentals: columns left of the heads, top-down, avoiding vertical clashes
  const slots = [];
  for (const n of notes.slice().sort((a, b) => a.pos - b.pos)) {
    if (!n.accidental) continue;
    let slot = 0;
    while (slots[slot] != null && n.pos - slots[slot] < 3) slot++;
    slots[slot] = n.pos;
    n.accSlot = slot;
    n.accX = num(baseX - rx - 0.45 * gap - slot * 0.8 * gap);
    n.accY = n.y;
  }

  // ledger lines, one entry per drawn line
  const ledgers = [];
  for (const n of notes) {
    for (let i = 1; i <= n.ledgerAbove; i++) {
      ledgers.push({ y: num(top - i * gap), x1: num(n.x - rx * 1.6), x2: num(n.x + rx * 1.6) });
    }
    for (let i = 1; i <= n.ledgerBelow; i++) {
      ledgers.push({ y: num(m.bottom + i * gap), x1: num(n.x - rx * 1.6), x2: num(n.x + rx * 1.6) });
    }
  }

  return {
    clef, key, width: m.width, height: m.height, gap: num(gap),
    top: num(top), bottom: num(m.bottom), left: num(left), right: num(right),
    clefX: num(clefX), keyX: num(keyX), notesLeft: num(notesLeft), noteX: num(baseX),
    keyMarks, notes, ledgers,
    lines: [0, 1, 2, 3, 4].map((i) => num(top + i * gap)),
  };
}

function layoutGrand(opts) {
  const width = opts.width || 320;
  const height = opts.height || 260;
  const gap = opts.gap || height / 18;
  const split = opts.split != null ? opts.split : 60;
  const key = opts.key || "C";
  const pitches = (opts.pitches || []).slice().sort((a, b) => a - b);
  const treble = pitches.filter((p) => p >= split);
  const bass = pitches.filter((p) => p < split);
  const braceW = 1.4 * gap;
  const topTop = (height - (8 * gap + 3 * gap)) / 2;          // two staves + the gap between
  const bassTop = topTop + 4 * gap + 3 * gap;
  const common = { width, height, gap, key, left: braceW + 0.6 * gap, x: opts.x };
  const t = layoutNotes({ ...common, clef: "treble", pitches: treble, top: topTop });
  const b = layoutNotes({ ...common, clef: "bass", pitches: bass, top: bassTop });
  // one shared note column so the two staves line up vertically
  const x = Math.max(t.notesLeft, b.notesLeft) + (Math.min(t.right, b.right) -
    Math.max(t.notesLeft, b.notesLeft)) / 2;
  const t2 = layoutNotes({ ...common, clef: "treble", pitches: treble, top: topTop, x });
  const b2 = layoutNotes({ ...common, clef: "bass", pitches: bass, top: bassTop, x });
  return { clef: "grand", key, width, height, gap: num(gap), split, braceW: num(braceW),
    staves: [t2, b2], noteX: num(x) };
}

// ── drawing primitives ──────────────────────────────────────────────────────

function svgOpen(width, height, bg, color, cls) {
  const back = bg && bg !== "none" ? `<rect x="0" y="0" width="${width}" height="${height}" fill="${bg}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${cls}" viewBox="0 0 ${num(width)} ${num(height)}" ` +
    `width="${num(width)}" height="${num(height)}" fill="none" stroke="${color}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${back}`;
}

function textEl(x, y, s, size, fill, cls, anchor, dy) {
  return `<text class="${cls}" x="${num(x)}" y="${num(y + (dy || 0))}" font-size="${num(size)}" ` +
    `font-family="Georgia, 'Times New Roman', serif" text-anchor="${anchor || "middle"}" ` +
    `dominant-baseline="middle" fill="${fill}" stroke="none">${esc(s)}</text>`;
}

/**
 * Treble (G) clef as a monoline stroke. Origin = the spiral centre, which sits
 * on the G4 line (3 spaces below the top line); units are staff spaces.
 */
function trebleClef(x, top, gap, color) {
  const cx = x + 1.5 * gap, cy = top + 3 * gap, u = gap;
  const p = (ax, ay) => `${num(cx + ax * u)},${num(cy + ay * u)}`;
  const stem = [
    `M ${p(0.20, -3.55)}`,
    `C ${p(0.20, -2.00)} ${p(0.10, 0.60)} ${p(0.02, 1.60)}`,
    `C ${p(-0.04, 2.32)} ${p(-0.30, 2.76)} ${p(-0.74, 2.62)}`,
    `C ${p(-1.06, 2.52)} ${p(-1.10, 2.10)} ${p(-0.80, 1.98)}`,
  ].join(" ");
  const loop = [
    `M ${p(0.20, -3.55)}`,
    `C ${p(0.05, -3.98) } ${p(-0.50, -3.92)} ${p(-0.62, -3.35)}`,
    `C ${p(-0.78, -2.62)} ${p(-0.20, -2.05)} ${p(0.25, -1.55)}`,
    `C ${p(0.75, -1.00)} ${p(1.06, -0.35)} ${p(0.98, 0.32)}`,
    `C ${p(0.90, 1.22)} ${p(0.30, 1.96)} ${p(-0.30, 1.92)}`,
    `C ${p(-1.00, 1.88)} ${p(-1.42, 1.30)} ${p(-1.35, 0.62)}`,
    `C ${p(-1.28, -0.10)} ${p(-0.70, -0.62)} ${p(-0.05, -0.55)}`,
    `C ${p(0.55, -0.48)} ${p(0.86, -0.10)} ${p(0.72, 0.28)}`,
    `C ${p(0.58, 0.66)} ${p(0.18, 0.74)} ${p(0.00, 0.45)}`,
  ].join(" ");
  const w = num(0.2 * gap);
  return `<path class="clef" d="${stem}" stroke="${color}" stroke-width="${w}" fill="none"/>` +
    `<path class="clef" d="${loop}" stroke="${color}" stroke-width="${w}" fill="none"/>`;
}

/** Bass (F) clef: head dot on the F3 line, hook, and the two dots. */
function bassClef(x, top, gap, color) {
  const cx = x + 0.6 * gap, cy = top + gap, u = gap;      // F line = 2nd from the top
  const p = (ax, ay) => `${num(cx + ax * u)},${num(cy + ay * u)}`;
  const d = [
    `M ${p(0.10, -0.52)}`,
    `C ${p(1.20, -1.02)} ${p(2.00, -0.20)} ${p(1.84, 0.72)}`,
    `C ${p(1.66, 1.72)} ${p(0.92, 2.34)} ${p(-0.16, 2.72)}`,
  ].join(" ");
  const dot = (ax, ay) => `<circle class="clef" cx="${num(cx + ax * u)}" cy="${num(cy + ay * u)}" ` +
    `r="${num(0.16 * u)}" fill="${color}" stroke="none"/>`;
  return `<circle class="clef" cx="${num(cx)}" cy="${num(cy)}" r="${num(0.42 * u)}" fill="${color}" stroke="none"/>` +
    `<path class="clef" d="${d}" stroke="${color}" stroke-width="${num(0.26 * gap)}" fill="none"/>` +
    dot(2.25, -0.5) + dot(2.25, 0.5);
}

function clefGlyph(clef, x, top, gap, color) {
  return clef === "bass" ? bassClef(x, top, gap, color) : trebleClef(x, top, gap, color);
}

function noteHead(n, gap, color, filled) {
  const t = `rotate(-18 ${n.x} ${n.y})`;
  if (filled) {
    return `<ellipse class="note" data-midi="${n.midi}" cx="${n.x}" cy="${n.y}" rx="${n.rx}" ` +
      `ry="${n.ry}" transform="${t}" fill="${color}" stroke="none"/>`;
  }
  return `<ellipse class="note" data-midi="${n.midi}" cx="${n.x}" cy="${n.y}" rx="${n.rx}" ` +
    `ry="${n.ry}" transform="${t}" fill="none" stroke="${color}" stroke-width="${num(0.2 * gap)}"/>`;
}

function drawStaff(L, opts) {
  const color = opts.color || "#d8d8de";
  const gap = L.gap;
  let out = "";
  for (const y of L.lines) {
    out += `<line class="staffline" x1="${L.left}" y1="${y}" x2="${L.right}" y2="${y}" ` +
      `stroke="${color}" stroke-width="${num(0.07 * gap)}"/>`;
  }
  out += clefGlyph(L.clef, L.clefX, L.top, gap, color);
  // the ♭/♯ characters sit a shade high when centred on their em box
  const DY = 0.1 * gap;
  for (const mk of L.keyMarks) out += textEl(mk.x, mk.y, mk.glyph, 1.75 * gap, color, "keysig", "middle", DY);
  for (const g of L.ledgers) {
    out += `<line class="ledger" x1="${g.x1}" y1="${g.y}" x2="${g.x2}" y2="${g.y}" ` +
      `stroke="${color}" stroke-width="${num(0.09 * gap)}"/>`;
  }
  for (const n of L.notes) {
    const c = opts.colorNotes ? `rgb(${rgbOf(n.midi % 12).join(",")})` : color;
    if (n.accidental) out += textEl(n.accX, n.accY, n.accidental, 1.7 * gap, c, "accidental", "middle", DY);
    out += noteHead(n, gap, c, !!opts.filled);
  }
  return out;
}

// ── public renderers ────────────────────────────────────────────────────────

/** One staff (or the grand staff when clef === "grand") as an SVG string. */
export function staffSVG(opts = {}) {
  if ((opts.clef || "treble") === "grand") return grandStaffSVG(opts);
  const color = opts.color || "#d8d8de";
  const L = layoutNotes(opts);
  let out = svgOpen(L.width, L.height, opts.bg, color, "staff");
  out += drawStaff(L, opts);
  if (opts.label) out += textEl(L.left, L.top - 1.4 * L.gap, opts.label, 1.1 * L.gap, color, "label", "start");
  return out + "</svg>";
}

/** Grand staff: brace, two staves, notes >= `split` (default 60) on the treble. */
export function grandStaffSVG(opts = {}) {
  const color = opts.color || "#d8d8de";
  const G = layoutGrand(opts);
  const [t, b] = G.staves;
  const gap = G.gap;
  let out = svgOpen(G.width, G.height, opts.bg, color, "staff grand");
  // brace + the joining barline at the left edge
  const x = t.left, y0 = t.top, y1 = b.bottom, mid = (y0 + y1) / 2, w = G.braceW;
  const d = `M ${num(x)},${num(y0)} C ${num(x - w)},${num(y0 + gap)} ${num(x - w * 0.2)},${num(mid - gap)} ` +
    `${num(x - w * 0.75)},${num(mid)} C ${num(x - w * 0.2)},${num(mid + gap)} ${num(x - w)},${num(y1 - gap)} ` +
    `${num(x)},${num(y1)}`;
  out += `<path class="brace" d="${d}" stroke="${color}" stroke-width="${num(0.12 * gap)}" fill="none"/>`;
  out += `<line class="barline" x1="${num(x)}" y1="${num(y0)}" x2="${num(x)}" y2="${num(y1)}" ` +
    `stroke="${color}" stroke-width="${num(0.1 * gap)}"/>`;
  out += drawStaff(t, opts) + drawStaff(b, opts);
  if (opts.label) out += textEl(t.left, t.top - 1.4 * gap, opts.label, 1.1 * gap, color, "label", "start");
  return out + "</svg>";
}

const ROOT_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "Dm7" / "Bb7" / "F#maj7" → root pitch class, or null. */
export function chordRootPc(text) {
  const m = String(text || "").trim().match(/^([A-G])([#b♯♭]?)/);
  if (!m) return null;
  const acc = m[2] === "#" || m[2] === "♯" ? 1 : (m[2] === "b" || m[2] === "♭" ? -1 : 0);
  return ((ROOT_PC[m[1]] + acc) % 12 + 12) % 12;
}

/**
 * A chord chart: bars with symbols above, section labels, an optional cursor.
 * bars: [{chord, beats=4, label?}]. cursor: {bar, beat} (beat is 0-based).
 */
export function leadSheetSVG(opts = {}) {
  const bars = opts.bars || [];
  const perLine = Math.max(1, opts.barsPerLine || 4);
  const width = opts.width || 900;
  const color = opts.color || "#d8d8de";
  const rows = Math.max(1, Math.ceil(bars.length / perLine));
  const padX = opts.padX != null ? opts.padX : 34;
  const rowH = opts.rowH || 92;
  const padTop = opts.padTop != null ? opts.padTop : 34;
  const height = opts.height || padTop + rows * rowH + 16;
  const barW = (width - 2 * padX) / perLine;
  const colored = opts.colorChords !== false;

  const rowY = (r) => padTop + r * rowH;
  const barX = (i) => padX + (i % perLine) * barW;
  const staffY = (r) => rowY(r) + 46;

  let out = svgOpen(width, height, opts.bg, color, "leadsheet");
  for (let r = 0; r < rows; r++) {
    const y = staffY(r);
    const n = Math.min(perLine, Math.max(0, bars.length - r * perLine));
    if (!n) continue;
    out += `<line class="staffline" x1="${num(padX)}" y1="${num(y)}" x2="${num(padX + n * barW)}" ` +
      `y2="${num(y)}" stroke="${color}" stroke-width="1" opacity="0.5"/>`;
  }
  bars.forEach((bar, i) => {
    const r = Math.floor(i / perLine);
    const x = barX(i), y = staffY(r), beats = bar.beats || 4;
    out += `<rect class="bar" data-bar="${i}" x="${num(x)}" y="${num(y - 22)}" ` +
      `width="${num(barW)}" height="44" fill="none" stroke="none"/>`;
    out += `<line class="barline" x1="${num(x)}" y1="${num(y - 16)}" x2="${num(x)}" y2="${num(y + 16)}" ` +
      `stroke="${color}" stroke-width="1.4"/>`;
    for (let bt = 0; bt < beats; bt++) {
      const bx = x + (bt + 0.5) * (barW / beats);
      out += `<line class="slash" x1="${num(bx - 4)}" y1="${num(y + 7)}" x2="${num(bx + 4)}" ` +
        `y2="${num(y - 7)}" stroke="${color}" stroke-width="1.2" opacity="0.45"/>`;
    }
    if (bar.chord) {
      const pc = chordRootPc(bar.chord);
      const fill = colored && pc != null ? `rgb(${rgbOf(pc).join(",")})` : color;
      out += `<text class="chord" data-bar="${i}" x="${num(x + 7)}" y="${num(y - 30)}" ` +
        `font-size="19" font-weight="600" font-family="Georgia, 'Times New Roman', serif" ` +
        `text-anchor="start" fill="${fill}" stroke="none">${esc(bar.chord)}</text>`;
    }
    if (bar.label) {
      out += `<text class="label" data-bar="${i}" x="${num(x)}" y="${num(rowY(r) - 6)}" font-size="11" ` +
        `letter-spacing="1.5" font-family="ui-sans-serif, system-ui, sans-serif" text-anchor="start" ` +
        `fill="${color}" stroke="none" opacity="0.65">${esc(String(bar.label).toUpperCase())}</text>`;
    }
    const last = i === bars.length - 1;
    if (last || (i + 1) % perLine === 0) {
      const ex = x + barW;
      out += `<line class="barline" data-end="${i}" x1="${num(ex)}" y1="${num(y - 16)}" x2="${num(ex)}" ` +
        `y2="${num(y + 16)}" stroke="${color}" stroke-width="${last ? 3 : 1.4}"/>`;
    }
  });
  const cur = opts.cursor;
  if (cur && cur.bar != null && cur.bar >= 0 && cur.bar < bars.length) {
    const i = cur.bar, r = Math.floor(i / perLine);
    const beats = bars[i].beats || 4;
    const beat = Math.min(Math.max(cur.beat || 0, 0), beats);
    const w = barW / beats;
    out += `<rect class="cursor" data-bar="${i}" data-beat="${num(beat)}" ` +
      `x="${num(barX(i) + beat * w)}" y="${num(staffY(r) - 20)}" width="${num(w)}" height="40" ` +
      `fill="${color}" fill-opacity="0.16" stroke="none"/>`;
  }
  return out + "</svg>";
}

export default { layoutNotes, staffSVG, grandStaffSVG, leadSheetSVG, keySignature, keyInfo, spell };
