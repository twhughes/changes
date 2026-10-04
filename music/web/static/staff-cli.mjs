#!/usr/bin/env node
/* staff-cli.mjs — one JSON job on stdin, one SVG on stdout.
 *
 *   echo '{"kind":"staff","clef":"treble","pitches":[64],"key":"C"}' \
 *     | node music/web/static/staff-cli.mjs > front.svg
 *
 * kind: "staff" | "grand" | "leadsheet"; the rest of the object is passed
 * straight through as the renderer's options (see staff.js). Exit 0 with the
 * SVG on stdout; exit 2 with {"error": "..."} on stderr for a bad job.
 */

import { grandStaffSVG, leadSheetSVG, staffSVG } from "./staff.js";

const KINDS = { staff: staffSVG, grand: grandStaffSVG, leadsheet: leadSheetSVG };

function fail(message) {
  process.stderr.write(JSON.stringify({ error: message }) + "\n");
  process.exit(2);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const text = await readStdin();
if (!text.trim()) fail("empty job on stdin");

let job;
try {
  job = JSON.parse(text);
} catch (e) {
  fail(`bad JSON: ${e.message}`);
}
if (!job || typeof job !== "object" || Array.isArray(job)) fail("job must be a JSON object");

const kind = job.kind || "staff";
const render = KINDS[kind];
if (!render) fail(`unknown kind ${JSON.stringify(kind)} (want staff|grand|leadsheet)`);

if (kind === "leadsheet") {
  if (!Array.isArray(job.bars)) fail("leadsheet job needs a `bars` array");
} else {
  if (!Array.isArray(job.pitches)) fail(`${kind} job needs a \`pitches\` array`);
  if (job.pitches.some((p) => !Number.isInteger(p) || p < 0 || p > 127)) {
    fail("pitches must be MIDI integers 0-127");
  }
  if (kind === "staff" && job.clef && !["treble", "bass", "grand"].includes(job.clef)) {
    fail(`unknown clef ${JSON.stringify(job.clef)}`);
  }
}

let svg;
try {
  svg = render(job);
} catch (e) {
  fail(`render failed: ${e.message}`);
}
process.stdout.write(svg + "\n");
