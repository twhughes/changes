// staff.test.mjs — `node --test music/web/static/staff.test.mjs`
//
// Engraving is easy to get subtly wrong, so these pin the facts a reader would
// notice: where a note lands, how many ledger lines it gets, which accidental
// the key picks, and that the CLI still speaks JSON in / SVG out.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { rgbOf } from "./colors.js";
import {
  chordRootPc, grandStaffSVG, keyInfo, keySignature, layoutNotes, leadSheetSVG, spell, staffSVG,
} from "./staff.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "staff-cli.mjs");

/** default metrics: width 320, height 160 → gap 16, top 48, bottom 112 */
const GAP = 16, TOP = 48, BOTTOM = 112;

const count = (s, re) => (s.match(re) || []).length;
const one = (pitches, opts = {}) => layoutNotes({ pitches, ...opts }).notes[0];

// ── vertical placement ──────────────────────────────────────────────────────

test("treble: C4 hangs one ledger line below the staff", () => {
  const n = one([60], { clef: "treble" });
  assert.equal(n.y, BOTTOM + GAP);
  assert.equal(n.ledgerBelow, 1);
  assert.equal(n.ledgerAbove, 0);
  assert.equal(n.name, "C4");
});

test("treble: E4 sits on the bottom line, F5 on the top line", () => {
  assert.equal(one([64], { clef: "treble" }).y, BOTTOM);
  assert.equal(one([77], { clef: "treble" }).y, TOP);
  assert.equal(one([64], { clef: "treble" }).ledgerBelow, 0);
});

test("bass: F2 sits in the space below the bottom line", () => {
  const n = one([41], { clef: "bass" });
  assert.equal(n.name, "F2");
  assert.equal(n.y, BOTTOM + GAP / 2);
  assert.equal(n.ledgerBelow, 0);
});

test("bass: C4 is the ledger line above the staff (middle C both ways)", () => {
  const n = one([60], { clef: "bass" });
  assert.equal(n.y, TOP - GAP);
  assert.equal(n.ledgerAbove, 1);
  // middle C is one ledger line off either staff, on opposite sides
  assert.equal(one([60], { clef: "treble" }).ledgerBelow, 1);
});

test("ledger lines are counted and drawn per note", () => {
  assert.equal(one([84], { clef: "treble" }).ledgerAbove, 2);        // C6
  assert.equal(one([53], { clef: "treble" }).ledgerBelow, 3);        // F3
  assert.equal(one([36], { clef: "bass" }).ledgerBelow, 2);          // C2
  const L = layoutNotes({ clef: "treble", pitches: [53] });
  assert.equal(L.ledgers.length, 3);
  assert.equal(count(staffSVG({ clef: "treble", pitches: [53] }), /class="ledger"/g), 3);
});

// ── spelling and accidentals ────────────────────────────────────────────────

test("default spelling is sharps except Eb/Ab/Bb", () => {
  assert.equal(spell(60, "C").name, "C4");
  assert.equal(spell(61, "C").name, "C#4");
  assert.equal(spell(63, "C").name, "Eb4");
  assert.equal(spell(70, "C").name, "Bb4");
});

test("the key picks the accidental: Eb in C, D# in D, nothing in Eb", () => {
  assert.equal(one([63], { key: "C" }).accidental, "♭");
  assert.equal(one([63], { key: "C" }).name, "Eb4");
  assert.equal(one([63], { key: "D" }).accidental, "♯");
  assert.equal(one([63], { key: "D" }).name, "D#4");
  assert.equal(one([63], { key: "Eb" }).accidental, null);           // the signature has it
});

test("a note outside a flat key gets a natural sign", () => {
  assert.equal(one([64], { key: "Db" }).accidental, "♮");            // E natural against Eb
  assert.equal(one([64], { key: "C" }).accidental, null);
  assert.equal(count(staffSVG({ pitches: [64], key: "Db" }), /class="accidental"/g), 1);
});

// ── key signatures ──────────────────────────────────────────────────────────

test("key signature sizes: G=1♯, F=1♭, Db=5♭, C#=7♯, C=none", () => {
  assert.equal(keySignature("G").length, 1);
  assert.equal(keySignature("G")[0].glyph, "♯");
  assert.equal(keySignature("F").length, 1);
  assert.equal(keySignature("F")[0].glyph, "♭");
  assert.equal(keySignature("Db").length, 5);
  assert.equal(keySignature("C#").length, 7);
  assert.equal(keySignature("C").length, 0);
});

test("key signature glyphs land in the SVG, one <text> each", () => {
  assert.equal(count(staffSVG({ pitches: [], key: "G" }), /class="keysig"/g), 1);
  assert.equal(count(staffSVG({ pitches: [], key: "F" }), /class="keysig"/g), 1);
  assert.equal(count(staffSVG({ pitches: [], key: "Db" }), /class="keysig"/g), 5);
  assert.equal(count(staffSVG({ pitches: [], key: "C" }), /class="keysig"/g), 0);
});

test("key signature positions: F# on the top line (treble), a third lower on bass", () => {
  assert.equal(keySignature("G", "treble")[0].pos, 0);               // F#5, top line
  assert.equal(keySignature("G", "bass")[0].pos, 2);                 // F#3, 2nd line down
  assert.deepEqual(keySignature("B", "treble").map((m) => m.pos), [0, 3, -1, 2, 5]);
  assert.deepEqual(keySignature("Db", "treble").map((m) => m.pos), [4, 1, 5, 2, 6]);
});

test("minor keys borrow the relative major's signature", () => {
  assert.equal(keyInfo("Am").count, 0);
  assert.equal(keySignature("Em").length, 1);
  assert.equal(keySignature("Em")[0].glyph, "♯");
  assert.equal(keySignature("Dm").length, 1);
  assert.equal(keySignature("Dm")[0].glyph, "♭");
  assert.equal(keyInfo("nonsense").name, "C");
});

// ── chords and dyads ────────────────────────────────────────────────────────

test("a second offsets the upper note by a notehead; a third does not", () => {
  const second = layoutNotes({ clef: "treble", pitches: [60, 62] }).notes;
  assert.equal(second[0].offset, false);
  assert.equal(second[1].offset, true);
  assert.ok(second[1].x > second[0].x + second[0].rx);
  const third = layoutNotes({ clef: "treble", pitches: [60, 64] }).notes;
  assert.equal(third[1].offset, false);
  assert.equal(third[0].x, third[1].x);
});

test("a triad stacks in thirds, one notehead per pitch", () => {
  const L = layoutNotes({ clef: "treble", pitches: [67, 60, 64] });   // unsorted in
  assert.deepEqual(L.notes.map((n) => n.midi), [60, 64, 67]);
  assert.equal(L.notes[0].y - L.notes[1].y, GAP);
  assert.equal(count(staffSVG({ clef: "treble", pitches: [60, 64, 67] }), /class="note"/g), 3);
});

test("clashing accidentals get their own column", () => {
  const L = layoutNotes({ clef: "treble", pitches: [61, 63], key: "C" });
  assert.deepEqual(L.notes.map((n) => n.accidental), ["♯", "♭"]);    // C#4 then Eb4
  assert.notEqual(L.notes[0].accX, L.notes[1].accX);                 // two columns, no overlap
});

// ── grand staff ─────────────────────────────────────────────────────────────

test("grand staff splits at middle C by default", () => {
  const G = layoutNotes({ clef: "grand", pitches: [48, 59, 60, 64] });
  assert.equal(G.clef, "grand");
  assert.deepEqual(G.staves[0].notes.map((n) => n.midi), [60, 64]);
  assert.deepEqual(G.staves[1].notes.map((n) => n.midi), [48, 59]);
  assert.equal(G.staves[0].clef, "treble");
  assert.equal(G.staves[1].clef, "bass");
});

test("the split option moves the hand-off point", () => {
  const G = layoutNotes({ clef: "grand", pitches: [60, 64], split: 65 });
  assert.deepEqual(G.staves[0].notes.map((n) => n.midi), []);
  assert.deepEqual(G.staves[1].notes.map((n) => n.midi), [60, 64]);
});

test("grandStaffSVG draws a brace, two staves and both clefs", () => {
  const svg = grandStaffSVG({ pitches: [48, 64], key: "F" });
  assert.equal(count(svg, /class="brace"/g), 1);
  assert.equal(count(svg, /class="staffline"/g), 10);
  assert.equal(count(svg, /class="note"/g), 2);
  assert.equal(count(svg, /class="keysig"/g), 2);                    // one flat per staff
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
});

test("staffSVG with clef 'grand' delegates to the grand staff", () => {
  const svg = staffSVG({ clef: "grand", pitches: [60] });
  assert.ok(svg.includes('class="brace"'));
  assert.equal(count(svg, /class="staffline"/g), 10);
});

// ── lead sheet ──────────────────────────────────────────────────────────────

const BARS = [
  { chord: "Cmaj7", beats: 4, label: "A" }, { chord: "A7", beats: 4 },
  { chord: "Dm7", beats: 4 }, { chord: "G7", beats: 4 },
  { chord: "Em7", beats: 4, label: "bridge" }, { chord: "A7b9", beats: 4 },
];

test("lead sheet draws one bar and one chord symbol per bar", () => {
  const svg = leadSheetSVG({ bars: BARS, barsPerLine: 4, width: 800 });
  assert.equal(count(svg, /class="bar"/g), 6);
  assert.equal(count(svg, /class="chord"/g), 6);
  assert.equal(count(svg, /class="label"/g), 2);
  assert.equal(count(svg, /class="staffline"/g), 2);                 // two rows of 4
  assert.ok(svg.includes("Cmaj7") && svg.includes("A7b9"));
});

test("lead sheet colours the chord text by root pitch class", () => {
  const svg = leadSheetSVG({ bars: [{ chord: "Db7", beats: 4 }], width: 400 });
  assert.equal(chordRootPc("Db7"), 1);
  assert.ok(svg.includes(`rgb(${rgbOf(1).join(",")})`));
  const plain = leadSheetSVG({ bars: [{ chord: "Db7", beats: 4 }], width: 400, colorChords: false });
  assert.ok(!plain.includes(`rgb(${rgbOf(1).join(",")})`));
});

test("the cursor rect lands inside the bar and beat it names", () => {
  const svg = leadSheetSVG({ bars: BARS, barsPerLine: 4, width: 800, cursor: { bar: 5, beat: 2 } });
  const bar = svg.match(/class="bar" data-bar="5" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/);
  const cur = svg.match(/class="cursor" data-bar="5" data-beat="2" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/);
  assert.ok(bar && cur, "both rects present");
  const [bx, bw] = [+bar[1], +bar[2]], [cx, cw] = [+cur[1], +cur[2]];
  assert.ok(cx >= bx && cx + cw <= bx + bw + 0.01, "cursor inside its bar");
  assert.ok(Math.abs(cx - (bx + bw / 2)) < 0.01, "beat 2 of 4 is the bar's midpoint");
  assert.ok(Math.abs(cw - bw / 4) < 0.01, "cursor is one beat wide");
  assert.equal(count(leadSheetSVG({ bars: BARS }), /class="cursor"/g), 0);
});

// ── options ─────────────────────────────────────────────────────────────────

test("sizes scale from width/height and colours are overridable", () => {
  const L = layoutNotes({ clef: "treble", pitches: [64], width: 640, height: 320 });
  assert.equal(L.gap, 32);
  assert.equal(L.notes[0].y, 96 + 4 * 32);
  const svg = staffSVG({ clef: "treble", pitches: [64], color: "#ff0000", bg: "#101014", label: "E4" });
  assert.ok(svg.includes('stroke="#ff0000"'));
  assert.ok(svg.includes('fill="#101014"'));
  assert.ok(svg.includes(">E4</text>"));
  assert.ok(svg.includes('viewBox="0 0 320 160"'));
});

// ── the CLI ─────────────────────────────────────────────────────────────────

const cli = (job) => spawnSync(process.execPath, [CLI],
  { input: typeof job === "string" ? job : JSON.stringify(job), encoding: "utf8" });

test("CLI round trip: a staff job in, an SVG out, exit 0", () => {
  const r = cli({ kind: "staff", clef: "treble", pitches: [64], key: "C" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith("<svg"));
  assert.ok(r.stdout.includes('class="note"'));
});

test("CLI renders grand and leadsheet jobs too", () => {
  const g = cli({ kind: "grand", pitches: [48, 64], key: "F" });
  assert.equal(g.status, 0, g.stderr);
  assert.ok(g.stdout.includes('class="brace"'));
  const l = cli({ kind: "leadsheet", bars: [{ chord: "Dm7", beats: 4 }], width: 400 });
  assert.equal(l.status, 0, l.stderr);
  assert.ok(l.stdout.includes("Dm7"));
});

test("CLI rejects a bad job with exit 2 and a JSON error on stderr", () => {
  for (const job of ["", "not json", '{"kind":"nope","pitches":[60]}', '{"kind":"staff"}',
    '{"kind":"staff","pitches":[600]}', '{"kind":"leadsheet"}', "[1,2]"]) {
    const r = cli(job);
    assert.equal(r.status, 2, `expected exit 2 for ${job}`);
    assert.equal(r.stdout, "");
    assert.ok(JSON.parse(r.stderr).error, `error message for ${job}`);
  }
});
