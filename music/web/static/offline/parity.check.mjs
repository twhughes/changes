// Parity check for the static page's JS twin — `node offline/parity.check.mjs [vectors.json]`.
//
// Python is the authority (CONTRACTS.md §12): tools/static_vectors.py runs the real matcher,
// match_pitches, name_notes, the grade policy, the SM-2 scheduler, the DrillEngine and whole
// TrainerService + SongsService sessions, and writes what they answered. This replays every
// case through offline/*.js and requires the same answer, field for field. With no argument
// it generates the vectors itself (the repo's .venv python, else python3).
// Exit 0 = every case agreed; exit 1 prints the first disagreement.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { match, matchPitches, nameNotes } from "./theory.js";
import { grade } from "./grading.js";
import { DrillEngine, NoteTracker, normalizeEvent, resolveItem } from "./drill.js";
import { LocalScheduler, memorySlot, parseIso } from "./srs.js";
import { parseFront } from "./songs.js";
import { createRuntime } from "./runtime.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const fail = (msg) => { console.error(`parity.check.mjs: FAIL — ${msg}`); process.exit(1); };
const wire = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function loadVectors() {
  let file = process.argv[2] || process.env.MUSIC_VECTORS;
  if (!file) {
    const venv = path.join(REPO, ".venv", "bin", "python");
    const python = fs.existsSync(venv) ? venv : "python3";
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "music-vectors-")), "vectors.json");
    const r = spawnSync(python, [path.join(REPO, "tools", "static_vectors.py"), "--out", file],
      { cwd: REPO, encoding: "utf8" });
    if (r.status !== 0) fail(`could not generate the vectors:\n${r.stdout}${r.stderr}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function same(actual, expected, what) {
  try {
    assert.deepStrictEqual(wire(actual), expected);
  } catch {
    fail(`${what}\n  python: ${JSON.stringify(expected).slice(0, 900)}\n  js:     ${JSON.stringify(wire(actual)).slice(0, 900)}`);
  }
}

const V = loadVectors();
const chordOf = (text) => ({ text, ...V.chords[text] });
const naming = V.data.app.naming;
const gradePolicy = V.data.app.policies.grade;
const srsPolicy = V.data.app.policies.srs;

// ── match / match_pitches / name_notes / grade / fronts ───────────────────────
V.match.forEach((c, i) => same(match(c.notes, chordOf(c.chord), c.level), c.verdict,
  `match #${i}: ${c.chord} ${c.level} ${JSON.stringify(c.notes)}`));
V.pitches.forEach((c, i) => same(matchPitches(c.notes, c.targets, c.octave_exact), c.verdict,
  `match_pitches #${i}: ${JSON.stringify(c.targets)} ${JSON.stringify(c.notes)} exact=${c.octave_exact}`));
V.naming.forEach((c, i) => same(nameNotes(c.notes, naming, c.top), c.ranked,
  `name_notes #${i}: ${JSON.stringify(c.notes)}`));
V.grading.forEach((c, i) => same(grade(c.attempts, c.latency_s, c.steps, gradePolicy), c.grade,
  `grade #${i}: latency ${c.latency_s} steps ${c.steps}`));
V.fronts.forEach((c, i) => same(parseFront(c.front), c.parsed, `parse_front #${i}: ${JSON.stringify(c.front)}`));

// ── SM-2 walks ────────────────────────────────────────────────────────────────
let srsOps = 0;
V.srs.forEach((walk, w) => {
  let now = 0;
  const sched = new LocalScheduler({ slot: memorySlot(), clock: () => now, policy: srsPolicy });
  walk.ops.forEach((op, k) => {
    srsOps += 1;
    const where = `srs walk ${w} op ${k} (${op.op})`;
    if (op.op === "clock") now = parseIso(op.at);
    else if (op.op === "add") same(sched.add(op.theme, op.specs), op.out, where);
    else if (op.op === "answer") {
      same(sched.answer(op.id, op.ease), op.out, where);
      same(sched.card(op.id), op.card, `${where} card`);
    } else if (op.op === "due") same(sched.due(op.theme), op.out, where);
    else if (op.op === "counts") same(sched.counts(), op.out, where);
    else if (op.op === "cards") same(sched.cards(), op.out, where);
    else fail(`unknown srs op ${op.op}`);
  });
});

// ── DrillEngine traces ────────────────────────────────────────────────────────
let drillEvents = 0;
V.drill.forEach((trace, n) => {
  const events = [];
  const items = trace.items.map((it) => resolveItem(it, V.chords));
  const engine = new DrillEngine(items, (name, payload) => events.push([name, wire(payload)]));
  const tracker = new NoteTracker();
  for (const op of trace.ops) {
    if (op[0] === "start") engine.start(op[1]);
    else if (op[0] === "note") tracker.feed(normalizeEvent(op[2] ? "note_on" : "note_off", op[3], 100, op[1]));
    else if (op[0] === "feed") engine.feed(op[1], tracker);
    else if (op[0] === "skip") engine.skip(op[1]);
  }
  trace.events.forEach((e, k) => same(events[k], e, `drill trace ${n} event ${k} (${e[0]})`));
  if (events.length !== trace.events.length) fail(`drill trace ${n}: ${events.length} events, python ${trace.events.length}`);
  drillEvents += events.length;
});

// ── whole sessions: TrainerService + SongsService ─────────────────────────────
const stripFinished = (e) => {
  const out = wire(e);
  if (out && out.type === "songs" && out.receipt) delete out.receipt.finished;
  return out;
};
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k) };
}

let serviceEvents = 0;
for (const session of V.service) {
  const clock = { t: 0, srs: parseIso("2026-10-04T08:00:00") };
  const rt = createRuntime(V.data, { storage: memoryStorage(), now: () => clock.t,
    wallClock: () => clock.srs, shuffle: (items) => [...items] });
  const seen = [];
  rt.listen((e) => seen.push(stripFinished(e)));
  const expected = session.events.map(stripFinished);
  let checked = 0;
  session.ops.forEach((op, k) => {
    const where = `session ${session.name} op ${k} (${op.op}${op.deck ? ` ${op.deck}` : ""})`;
    const api = (method, url, body) => rt.api.handle(method, url, body);
    let out;
    if ("t" in op) clock.t = op.t;
    switch (op.op) {
      case "notes": rt.tick(op.t, op.events.map(([on, note, vel]) => ({ on, note, vel, t: op.t }))); break;
      case "tick": rt.tick(op.t, []); break;
      case "start": out = rt.trainer.startDrill(op.deck); break;
      case "skip": rt.trainer.skip(); break;
      case "stop": rt.trainer.stopDrill(); break;
      case "seed": {
        const r = api("POST", "/api/trainer/seed", { builtin: op.deck });
        out = { status: r.status, body: r.body };
        break;
      }
      case "seed_song": out = api("POST", `/api/songs/${op.song}/seed`).body; break;
      case "dial": {
        const doc = api("PATCH", `/api/songs/${op.song}`, { grade: op.dial }).body;
        out = { grade: doc.grade, phrases: doc.phrases.length, chords: doc.chords.length };
        break;
      }
      case "clock": clock.srs = parseIso(op.at); break;
      case "status": out = api("GET", "/api/trainer/status").body; break;
      case "song": {
        const doc = api("GET", `/api/songs/${op.song}`).body;
        out = { review: doc.review, grade: doc.grade };
        break;
      }
      case "runs": out = api("GET", `/api/songs/${op.song}/runs`).body.map((r) => {
        const { finished: _f, ...rest } = r;
        return rest;
      }); break;
      default: fail(`unknown session op ${op.op}`);
    }
    if (op.out !== null && op.out !== undefined) same(out, op.out, `${where} answer`);
    for (; checked < op.n; checked++) same(seen[checked], expected[checked], `${where}: event ${checked} (${expected[checked].type})`);
    if (seen.length !== op.n) fail(`${where}: ${seen.length} events so far, python ${op.n} — next js: ${JSON.stringify(seen[op.n] || null).slice(0, 300)}`);
  });
  serviceEvents += seen.length;
}

console.log(`parity.check.mjs: ok — match ${V.match.length}, match_pitches ${V.pitches.length}, `
  + `name_notes ${V.naming.length}, grade ${V.grading.length}, fronts ${V.fronts.length}, `
  + `srs ${V.srs.length} walks/${srsOps} ops, drill ${V.drill.length} traces/${drillEvents} events, `
  + `service ${V.service.length} sessions/${serviceEvents} events`);
