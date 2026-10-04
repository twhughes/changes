// offline/theory.js — the static page's twin of theory/match.py and theory/naming.py
// (CONTRACTS.md §7, §12). The server path has no JS matcher; this one exists only for the
// page with no server, and it must pass the Python-generated parity vectors
// (tools/static_vectors.py → offline/parity.check.mjs). It never parses a chord symbol:
// a chord arrives precomputed from site/data as {text, pcs, req, bass} (web/static_data.py).
//
// Pure: no DOM, no clock, no storage.

// theory/pitch.py _PC_NAMES — the default spelling (sharps, except the flat-friendly Eb/Ab/Bb).
export const PC_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export const pcName = (pc) => PC_NAMES[((pc % 12) + 12) % 12];
/** MIDI → 'F#3' (middle C = C4 = 60), as theory.pitch.note_name. */
export const noteName = (n) => `${PC_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;

/**
 * theory/chords.py hint_voicing — the "Show keys" hint from a chord-table row: the bass in
 * octave 3, every other chord tone in the octave above middle C, low to high.
 */
export function hintVoicing(chord) {
  const upper = chord.pcs.filter((pc) => pc !== chord.bass).map((pc) => 60 + pc).sort((a, b) => a - b);
  return [48 + chord.bass, ...upper];
}

/**
 * Python's round(x, nd): the exact binary value rounded to nd decimals, ties to even.
 * toFixed is exact too but breaks ties upward, so a real tie (only dyadic values such as
 * 0.0625 can be one) is detected from the exact expansion and sent to the even neighbour.
 */
export function pyRound(x, nd = 0) {
  if (!Number.isFinite(x)) return x;
  const fixed = x.toFixed(nd);
  const exact = Math.abs(x).toFixed(Math.min(100, nd + 30));
  const tail = exact.slice(exact.length - 30);
  if (tail === "5".padEnd(30, "0")) {
    const scaled = Math.round(Math.abs(x) * 10 ** nd - 0.5);   // the lower neighbour
    const even = scaled % 2 === 0 ? scaled : scaled + 1;
    const out = even / 10 ** nd;
    return x < 0 ? -out : out;
  }
  return Number(fixed);
}

const sortNum = (a, b) => a - b;
const uniqSorted = (xs) => [...new Set(xs.map((n) => Number(n)))].sort(sortNum);

/** theory.match.match: does this handful of MIDI notes count as that chord? → Verdict.to_dict(). */
export function match(played, chord, level = "loose") {
  const notes = uniqSorted(played);
  const chordPcs = new Set(chord.pcs);
  const playedPcs = new Set(notes.map((n) => n % 12));
  const missing = [...chord.req].sort(sortNum).filter((pc) => !playedPcs.has(pc));
  const extra = [...playedPcs].filter((pc) => !chordPcs.has(pc)).sort(sortNum);

  let ok = missing.length === 0 && notes.length > 0;
  if (level !== "loose") ok = ok && extra.length === 0;

  let bassOk = null;
  if (level === "inversion" || level === "voiced") {
    bassOk = notes.length > 0 && notes[0] % 12 === chord.bass;
    ok = ok && bassOk;
  }
  // VOICED constraints: type pinned in Python, enforcement lands later — same here.

  const perNote = notes.map((n, i) => {
    if (i === 0 && bassOk !== null) return [n, bassOk ? "bass" : "extra"];
    return [n, chordPcs.has(n % 12) ? "chord-tone" : "extra"];
  });
  return {
    ok, level, missing, extra, bass_ok: bassOk, per_note: perNote,
    summary: summarize(chord, notes, ok, missing, extra, bassOk),
  };
}

function summarize(chord, notes, ok, missing, extra, bassOk) {
  if (!notes.length) return `${chord.text}: nothing played`;
  const played = notes.map(noteName).join(" ");
  if (ok) return `${chord.text} ✓  (${played})`;
  const parts = [];
  if (missing.length) parts.push("missing " + missing.map((pc) => pcName(pc)).join(", "));
  if (extra.length) parts.push("extra " + extra.map((pc) => pcName(pc)).join(", "));
  if (bassOk === false) parts.push(`bass should be ${pcName(chord.bass)}`);
  const detail = parts.length ? parts.join("; ") : "not matched";
  return `${chord.text} ✗  (${played}) — ${detail}`;
}

/** theory.match.match_pitches: the sight-reading grade (pitch-exact unless octaveExact is false). */
export function matchPitches(played, targets, octaveExact = true) {
  const notes = uniqSorted(played);
  const want = uniqSorted(targets);
  const keyOf = octaveExact ? (n) => n : (n) => n % 12;
  const playedKeys = new Set(notes.map(keyOf));
  const wantKeys = new Set(want.map(keyOf));
  const missing = [...wantKeys].filter((k) => !playedKeys.has(k)).sort(sortNum);
  const extra = [...playedKeys].filter((k) => !wantKeys.has(k)).sort(sortNum);
  const ok = notes.length > 0 && !missing.length && !extra.length;
  const perNote = notes.map((n) => [n, wantKeys.has(keyOf(n)) ? "chord-tone" : "extra"]);
  const label = want.map((n) => (octaveExact ? noteName(n) : pcName(n % 12))).join(" ");
  const playedText = notes.map(noteName).join(" ");
  let summary;
  if (!notes.length) summary = `${label}: nothing played`;
  else if (ok) summary = `${label} ✓  (${playedText})`;
  else {
    const fmt = octaveExact ? noteName : pcName;
    const parts = [];
    if (missing.length) parts.push("missing " + missing.map((n) => fmt(n)).join(", "));
    if (extra.length) parts.push("extra " + extra.map((n) => fmt(n)).join(", "));
    summary = `${label} ✗  (${playedText}) — ` + parts.join("; ");
  }
  return { ok, level: "pitch", missing, extra, bass_ok: null, per_note: perNote, summary };
}

/**
 * theory.naming.name_notes: rank plausible chord names for the played notes ([] below two
 * pitch classes). `table` = site/data/app.json "naming": the vocabulary in Python's order.
 */
export function nameNotes(midi, table, top = 3) {
  const notes = uniqSorted(midi);
  const pcs = [...new Set(notes.map((n) => n % 12))].sort(sortNum);
  if (pcs.length < 2) return [];
  const bassPc = notes[0] % 12;
  const ranked = [];
  for (const root of pcs) {
    const rel = new Set(pcs.map((pc) => (((pc - root) % 12) + 12) % 12));
    for (const [quality, ivs] of table.qualities) {
      if (!ivs.every((i) => rel.has(i))) continue;       // every chord tone must be there
      const extras = rel.size - ivs.length;
      const exact = extras === 0;
      const score = ivs.length * 10 - extras * 12 + (exact ? 8 : 0) + (root === bassPc ? 6 : 0)
        + (table.commonness[quality] || 0);
      let name = pcName(root) + quality;
      if (root !== bassPc) name += "/" + pcName(bassPc);
      ranked.push({ name, root_pc: root, quality, score, exact });
    }
  }
  ranked.sort((a, b) => (b.score - a.score) || (a.root_pc - b.root_pc));   // stable, like sorted()
  const seen = new Set();
  const out = [];
  for (const r of ranked) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r);
  }
  return out.slice(0, top);
}
