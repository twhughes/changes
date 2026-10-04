// twin.js — the S-1 twin as a cockpit sound: a model of the Roland S-1 running in an AudioWorklet.
// The engine is hq/synth's browser twin, vendored in ./twin/ (canonical home:
// hq/synth/synth/web/static/twin/; re-copy with tools/vendor_twin.py, never edit the copy).
//
// Driver contract (see ./index.js):
//   export async function create(ac, out)
//     -> { noteOn(note, vel), noteOff(note), allOff(), dispose(), set(cc, value), values() }
// set/values are the optional settings members: the S-1 panel (./settings.js) turns knobs with them.
//
// The S-1 plays 4 notes at once. This driver asks the twin for 8 (VOICES), so a two-hand chord of up
// to 8 notes sounds whole; a 9th key takes the oldest voice. PATCH is a soft poly keys sound for chord
// practice (the S-1's own factory sound is a bright square for one-note lines). The S-1 has no
// velocity, so neither does the twin: every key plays at one level. The twin's knob curves are
// uncalibrated guesses at the hardware, so the times and frequencies noted below are approximate.
// Nothing here calls the server: the engine and its curves load from ./twin/, so the driver works the
// same on a static page. The browser's own changes to PATCH (made in the settings panel) live in
// localStorage under STORE_KEY and apply every time a twin is created; without storage, PATCH alone.

import { createTwin } from "./twin/audio.js";

/** Notes at once. The S-1 has 4; the twin offers 4, 8 or 16. */
export const VOICES = 8;

/** A soft poly keys patch, in the S-1's own CC numbers (0..127). Every other control keeps its S-1 default. */
export const PATCH = {
  80: 2,     // Polyphony: Poly, one voice per key (Mono would play one note of the chord)
  14: 2,     // Range: 16', the keys as played
  20: 48,    // Saw level
  19: 30,    // Square level: under the saw, for body
  15: 25,    // Pulse width: a 41% pulse, a little hollow
  21: 0,     // Sub: off
  23: 0,     // Noise: off
  74: 70,    // Cutoff: about 815 Hz at middle C, warm but not muffled
  71: 12,    // Resonance: a touch
  26: 64,    // Key follow: half an octave per octave, so high notes stay clear
  24: 22,    // Envelope to cutoff: about an octave brighter on the attack
  25: 0,     // LFO to cutoff: off
  13: 0,     // Vibrato: off
  28: 1,     // Volume shape: the envelope (not the gate)
  73: 30,    // Attack: about 6 ms, soft but immediate
  75: 100,   // Decay: about 1 s
  30: 70,    // Sustain: about 55%
  72: 82,    // Release: about 0.4 s
  93: 2,     // Chorus: type 2, for width
  91: 30,    // Reverb level: a small room's worth
  89: 70,    // Reverb time: about 2 s
  92: 0,     // Delay: off
  31: 0,     // Glide: off
  65: 0,     // Glide switch: off
};

/** Where this browser keeps its changes to PATCH: {cc: value}, as JSON. */
export const STORE_KEY = "music.twin.changes.v1";

const asLevel = (v) => Math.max(0, Math.min(127, Math.round(Number(v) || 0)));

let visit = {};   // this visit's changes: what a browser that keeps no storage still has until a reload

/** The saved changes, cleaned to integer CCs and values 0..127: storage's, else this visit's. */
export function savedChanges() {
  let obj = visit;
  try { obj = JSON.parse(globalThis.localStorage.getItem(STORE_KEY) || "{}"); } catch { /* no storage, or junk */ }
  const out = {};
  for (const [cc, v] of Object.entries(obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {})) {
    const c = Number(cc), n = Number(v);
    if (Number.isInteger(c) && c >= 0 && c <= 127 && Number.isInteger(n) && n >= 0 && n <= 127) out[c] = n;
  }
  return out;
}

/** Keep {cc: value} as this browser's changes ({} forgets them). Without storage: this visit only. */
export function saveChanges(changes) {
  visit = { ...(changes || {}) };
  try {
    if (!Object.keys(visit).length) globalThis.localStorage.removeItem(STORE_KEY);
    else globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(visit));
  } catch { /* no storage: the visit keeps them */ }
}

/** How long a disposed twin keeps sounding its release and reverb tails before it closes (ms). */
export const TAIL_MS = 2500;

const SILENT = { noteOn() {}, noteOff() {}, allOff() {}, dispose() {} };

export async function create(ac, out) {
  let twin;
  try {
    twin = await createTwin({ curves: "bundled", context: ac, voices: VOICES, destination: out });
  } catch (e) {
    console.warn("sound/twin: the twin did not start — running silent:", (e && e.message) || e);
    return SILENT;
  }
  const vals = { ...PATCH, ...savedChanges() };     // the patch, then this browser's changes
  twin.setAll(vals);
  let disposed = false;
  return {
    noteOn(note, vel = 100) { if (!disposed) twin.noteOn(note, vel); },
    noteOff(note) { if (!disposed) twin.noteOff(note); },
    allOff() { if (!disposed) twin.allOff(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      twin.allOff();
      // Let the release and reverb ring out, then end the processor so it stops costing CPU.
      setTimeout(() => { twin.close().catch(() => {}); }, TAIL_MS);
    },
    /** Turn one S-1 control (its CC number, 0..127), live. */
    set(cc, value) {
      if (disposed) return;
      const c = Number(cc), v = asLevel(value);
      vals[c] = v;
      twin.set(c, v);
    },
    /** What this twin's controls are set to: PATCH, the saved changes, every set() since. */
    values() { return { ...vals }; },
  };
}
