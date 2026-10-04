// samples — a real multisampled electric piano, played in the browser.
//
// Driver contract (see ./index.js):
//   export async function create(ac, out)
//     -> { noteOn(note, vel), noteOff(note), allOff(), dispose() }
//
// It fetches the active sample set's manifest from /api/sound/samples, decodes
// each WAV once, and for every played (note, velocity) plays the nearest-root
// zone in the matching velocity band, pitch-shifted with playbackRate. If no
// set is installed the manifest 404s: we log a warning and return a silent
// driver so the cockpit keeps working.

const BASE = "/api/sound/samples";

const dbToLin = (db) => Math.pow(10, (db || 0) / 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Safari's Web Audio historically only supported the callback form of
// decodeAudioData; modern engines return a promise. Support both.
function decodeAudio(ac, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const maybe = ac.decodeAudioData(arrayBuffer, resolve, reject);
    if (maybe && typeof maybe.then === "function") maybe.then(resolve, reject);
  });
}

const SILENT = { noteOn() {}, noteOff() {}, allOff() {}, dispose() {} };

export async function create(ac, out) {
  let manifest;
  try {
    const r = await fetch(`${BASE}/manifest`, { cache: "no-store" });
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    manifest = await r.json();
  } catch (e) {
    console.warn("sound/samples: no sample set — running silent:", (e && e.message) || e);
    return SILENT;
  }

  const releaseS = typeof manifest.release_s === "number" ? manifest.release_s : 0.4;
  const zones = (manifest.samples || []).map((s) => ({
    file: s.file,
    root: s.note,
    velLo: s.vel_lo == null ? 1 : s.vel_lo,
    velHi: s.vel_hi == null ? 127 : s.vel_hi,
    tuneCents: s.tune_cents || 0,
    gain: dbToLin(s.gain_db),
  }));
  if (!zones.length) {
    console.warn("sound/samples: manifest has no samples — running silent");
    return SILENT;
  }

  // file -> Promise<AudioBuffer|null>, decoded at most once.
  const buffers = new Map();
  function loadBuffer(file) {
    let p = buffers.get(file);
    if (p) return p;
    p = fetch(`${BASE}/file/${file}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`${file} ${r.status}`);
        return r.arrayBuffer();
      })
      .then((ab) => decodeAudio(ac, ab))
      .catch((e) => {
        console.warn("sound/samples: failed to load", file, e);
        return null;
      });
    buffers.set(file, p);
    return p;
  }

  // Pre-warm every unique sample in the background so the first press is instant.
  (async () => {
    for (const f of [...new Set(zones.map((z) => z.file))]) {
      loadBuffer(f);
      await sleep(0); // yield between fetches; don't block the main thread
    }
  })();

  function pickZone(note, vel) {
    let best = null;
    let bestDist = Infinity;
    for (const z of zones) {
      if (vel < z.velLo || vel > z.velHi) continue;
      const d = Math.abs(z.root - note);
      if (d < bestDist) { bestDist = d; best = z; }
    }
    if (best) return best;
    // No velocity band covered vel — fall back to nearest root overall.
    for (const z of zones) {
      const d = Math.abs(z.root - note);
      if (d < bestDist) { bestDist = d; best = z; }
    }
    return best;
  }

  const voices = new Map();   // note -> current voice {src, gain, released}
  const noteSeq = new Map();  // note -> seq that owns it (retrigger/off race guard)
  let seq = 0;
  let disposed = false;

  function releaseVoice(voice) {
    if (!voice || voice.released) return;
    voice.released = true;
    const now = ac.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.setTargetAtTime(0.0001, now, releaseS);
      voice.src.stop(now + releaseS * 4 + 0.05);
    } catch { /* already stopped */ }
  }

  async function noteOn(note, vel) {
    if (disposed) return;
    const mine = ++seq;
    noteSeq.set(note, mine);
    const z = pickZone(note, vel);
    if (!z) return;
    const buf = await loadBuffer(z.file);
    // A newer on/off for this note, an allOff, or dispose ran while we decoded.
    if (disposed || noteSeq.get(note) !== mine || !buf) return;

    releaseVoice(voices.get(note)); // same-note retrigger releases the old voice
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (note - z.root) / 12 + z.tuneCents / 1200);
    const g = ac.createGain();
    const v = Math.max(0, Math.min(127, vel)) / 127;
    g.gain.value = Math.pow(v, 1.5) * z.gain;
    src.connect(g);
    g.connect(out);
    const voice = { src, gain: g, released: false };
    src.onended = () => { try { g.disconnect(); } catch {} };
    voices.set(note, voice);
    src.start();
  }

  function noteOff(note) {
    // Bump the note's seq so any in-flight noteOn for it aborts on resolve.
    noteSeq.set(note, ++seq);
    const voice = voices.get(note);
    if (voice) {
      releaseVoice(voice);
      voices.delete(note);
    }
  }

  function allOff() {
    ++seq;
    for (const n of noteSeq.keys()) noteSeq.set(n, seq); // abort in-flight ons
    for (const voice of voices.values()) releaseVoice(voice);
    voices.clear();
  }

  function dispose() {
    disposed = true;
    allOff();
  }

  return { noteOn, noteOff, allOff, dispose };
}
