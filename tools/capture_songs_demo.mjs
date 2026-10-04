#!/usr/bin/env node
/* Songs explainer — the REAL cockpit, driven by scripted input, captured headless.

   One command (from the repo root):
       node tools/capture_songs_demo.mjs              → tools/songs-demo.gif + tools/songs-demo.mp4
   Flags:
       --keep           keep the work dir (raw frames, timeline) and the server's temp data
       --encode <dir>   re-encode a kept work dir without capturing again
       --out <dir>      where the .gif/.mp4 go (default: tools/)
       --gif-quality N  gifski quality (default 90)

   Storyboard (Practice tab, CONTRACTS.md §9–§11): the sidebar → Very Early → ① check the
   page (flags beside the scan, the form chips) → Looks right → ② Add to review → Play
   through (keys lit, then Blind) → Phrases (one wrong chord) → "Review works without Anki".
   Captions are built from what the app reports (flags, cue, grade), never typed in.

   Nothing here touches Tyler's browser, MIDI or data: tools/songs_demo_server.py serves a
   scratch cockpit on :8996 (FakeMidiWorld, a temp copy of songs/, a temp review store,
   Anki offline); Chrome runs headless with a throwaway profile on CDP :9334, audio muted.
   Chords go in as `note_in` on /ws/state — the cockpit's own virtual keys, the same path
   as its on-screen piano. Captions and the pointer are an overlay injected into the page
   (Runtime.evaluate); the app's source is untouched. Only the PIDs this script spawns are
   ever killed. The phrase deck is shuffled: if the first card has no cue chord or more
   than 4 chords, the deck is restarted off camera (a cut) until a 4-chord cued line leads.

   Recipe: tools/capture_demo.js (CDP over node's global WebSocket, throwaway profile).  */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PY = path.join(REPO, ".venv", "bin", "python");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP_PORT = 8996, CDP_PORT = 9334;
const APP = `http://127.0.0.1:${APP_PORT}`;
const VW = 1470, VH = 760, SCALE = 2;          // Tyler's 13" Air at 100 %, captured at 2x
const SHOT_MS = 66;                             // capture cadence (~15 fps)
const GIF_W = 1200, GIF_FPS = 12, MP4_FPS = 30;
const SONG_ID = "very-early";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const OUT = path.resolve(opt("--out", path.join(REPO, "tools")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a);

// ── processes we own (and only these get killed) ────────────────────────────
const owned = [];
function killOwned() {
  for (const child of owned) {
    try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); } catch { /* gone */ }
  }
}
process.on("exit", killOwned);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killOwned(); process.exit(130); });

async function portBusy(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); return true; }
  catch (e) { return e.name === "TimeoutError"; }
}

async function startServer() {
  if (await portBusy(APP_PORT)) throw new Error(`port ${APP_PORT} is already in use — not touching it`);
  const args = [path.join(REPO, "tools", "songs_demo_server.py"), "--port", String(APP_PORT)];
  if (flag("--keep")) args.push("--keep");
  const srv = spawn(PY, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  owned.push(srv);
  let out = "";
  srv.stdout.on("data", (d) => { out += d; });
  srv.stderr.on("data", (d) => { out += d; });
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    if (srv.exitCode !== null) break;
    try { if ((await fetch(APP + "/api/health")).ok) { log("server", srv.pid, out.trim()); return srv; } } catch { /* not yet */ }
  }
  throw new Error("demo server never came up:\n" + out);
}

async function startChrome(profile) {
  if (await portBusy(CDP_PORT)) throw new Error(`CDP port ${CDP_PORT} is already in use`);
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    `--window-size=${VW},${VH}`, "--hide-scrollbars", "--mute-audio", "--lang=en-US",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "about:blank",
  ], { stdio: "ignore" });
  owned.push(chrome);
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) { log("chrome", chrome.pid); return { chrome, wsUrl: page.webSocketDebuggerUrl }; }
    } catch { /* not up yet */ }
  }
  throw new Error("headless Chrome never came up");
}

// ── CDP ─────────────────────────────────────────────────────────────────────
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.waiting = new Map(); this.subs = []; this.errors = []; }
  async open() {
    this.sock = new WebSocket(this.url);
    await new Promise((res, rej) => { this.sock.onopen = res; this.sock.onerror = rej; });
    this.sock.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)(m); this.waiting.delete(m.id); return; }
      if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") this.errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
      for (const cb of this.subs) cb(m);
    };
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const n = ++this.id;
      this.waiting.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
      this.sock.send(JSON.stringify({ id: n, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n  in: ${expr.slice(0, 160)}`);
    return r.result.value;
  }
  /** The next CDP event named `method` (e.g. Page.fileChooserOpened). */
  once(method, timeout = 8000) {
    return new Promise((res, rej) => {
      const cb = (m) => { if (m.method === method) { this.subs.splice(this.subs.indexOf(cb), 1); res(m.params); } };
      this.subs.push(cb);
      setTimeout(() => { const i = this.subs.indexOf(cb); if (i >= 0) { this.subs.splice(i, 1); rej(new Error(`no ${method}`)); } }, timeout);
    });
  }
  async waitFor(expr, timeout = 8000, what = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = await this.eval(expr); if (v) return v; } catch { /* page mid-render */ }
      await sleep(80);
    }
    throw new Error(`timed out waiting for ${what.slice(0, 160)}`);
  }
  close() { try { this.sock.close(); } catch { /* closed */ } }
}

// ── the recorder: timestamped screenshots + a speed map ─────────────────────
class Recorder {
  constructor(cdp, dir) { this.cdp = cdp; this.dir = dir; this.frames = []; this.segs = []; this.captions = []; this.on = false; }
  now() { return (performance.now() - this.t0) / 1000; }
  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.t0 = performance.now();
    this.on = true;
    this.paused = false;
    this.seg("preroll", 0);
    this.loop = (async () => {
      let k = 0;
      while (this.on) {
        if (this.paused) { await sleep(4); continue; }
        const t1 = performance.now();
        let shot;
        try {
          this.inflight = this.cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
          shot = await this.inflight;
        } catch { await sleep(20); continue; } finally { this.inflight = null; }
        const t2 = performance.now();
        const file = path.join(this.dir, `${String(k++).padStart(5, "0")}.png`);
        fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
        this.frames.push({ file, t: ((t1 + t2) / 2 - this.t0) / 1000 });
        const wait = SHOT_MS - (performance.now() - t1);
        if (wait > 0) await sleep(wait);
      }
    })();
  }
  /** Run `fn` between screenshots. Headless Chrome drops CDP mouse events that land
      while a Page.captureScreenshot is in flight, so input waits for a gap. */
  async hold(fn) {
    this.paused = true;
    try {
      if (this.inflight) await this.inflight.catch(() => {});
      return await fn();
    } finally { this.paused = false; }
  }
  /** A segment that starts at an earlier time `t` (kept in time order) — for a cut decided late. */
  segAt(t, label, speed) {
    this.segs.push({ t, speed, label });
    this.segs.sort((a, b) => a.t - b.t);
    log(`  ▸ ${label}${speed === 1 ? "" : speed ? ` (×${speed})` : " (cut)"} from ${t.toFixed(1)} s`);
  }
  /** From now on the footage plays at `speed` (1 = real time, 6 = six times faster, 0 = cut). */
  seg(label, speed = 1) { this.segs.push({ t: this.now(), speed, label }); log(`  ▸ ${label}${speed === 1 ? "" : speed ? ` (×${speed})` : " (cut)"}`); }
  async stop() { this.seg("end", 0); this.on = false; await this.loop; }
}

/** Resample the captured frames onto a constant-fps timeline that honours the speed map. */
function timeline(frames, segs, fps) {
  const out = [];
  let j = 0;
  for (let i = 0; i < segs.length - 1; i++) {
    const { t: a, speed } = segs[i];
    const b = segs[i + 1].t;
    if (!speed || b <= a) continue;
    const n = Math.round(((b - a) / speed) * fps);
    for (let k = 0; k < n; k++) {
      const ts = a + (k * speed) / fps;
      while (j + 1 < frames.length && frames[j + 1].t <= ts) j++;
      while (j > 0 && frames[j].t > ts) j--;
      out.push(frames[j].file);
    }
  }
  return out;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed:\n${String(r.stderr).slice(-1500)}`);
  return String(r.stdout);
}

/** Source seconds → seconds in the finished video (cut segments vanish, sped ones shrink). */
function outTime(segs, t) {
  let out = 0;
  for (let i = 0; i < segs.length - 1; i++) {
    const { t: a, speed } = segs[i];
    const b = segs[i + 1].t;
    if (t <= a) break;
    if (speed) out += (Math.min(t, b) - a) / speed;
  }
  return out;
}

function encode(work) {
  const { frames, segs, captions = [] } = JSON.parse(fs.readFileSync(path.join(work, "capture.json"), "utf8"));
  log("storyboard (time in the finished video):");
  for (const s of segs.filter((x) => x.speed !== 1)) log(`  ${outTime(segs, s.t).toFixed(1).padStart(5)} s  [${s.label}${s.speed ? `, ×${s.speed}` : ", cut"}]`);
  for (const c of captions) log(`  ${outTime(segs, c.t).toFixed(1).padStart(5)} s  ${c.step}: ${c.text}`);
  fs.mkdirSync(OUT, { recursive: true });
  const link = (files, dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    files.forEach((f, k) => fs.symlinkSync(f, path.join(dir, `${String(k).padStart(5, "0")}.png`)));
  };
  // MP4: the capture's own 2x pixels (2940×1520) — crisp on a Retina screen.
  const mp4Seq = path.join(work, "seq-mp4");
  link(timeline(frames, segs, MP4_FPS), mp4Seq);
  const mp4 = path.join(OUT, "songs-demo.mp4");
  run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(MP4_FPS), "-i", path.join(mp4Seq, "%05d.png"),
    "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "slow",
    "-crf", "18", "-tune", "animation", "-movflags", "+faststart", mp4]);
  // GIF: resample at GIF_FPS, Lanczos down to GIF_W, then gifski.
  const gifSeq = path.join(work, "seq-gif");
  link(timeline(frames, segs, GIF_FPS), gifSeq);
  const small = path.join(work, "gif-png");
  fs.rmSync(small, { recursive: true, force: true });
  fs.mkdirSync(small);
  run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(GIF_FPS), "-i", path.join(gifSeq, "%05d.png"),
    "-vf", `scale=${GIF_W}:-2:flags=lanczos`, path.join(small, "%05d.png")]);
  const pngs = fs.readdirSync(small).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(small, f));
  const gif = path.join(OUT, "songs-demo.gif");
  // motion/lossy at 100: gifski's temporal shortcuts otherwise leave faint ghosts of a moved
  // caption band on the near-black ground (#0d0d10 vs #111 reads as "unchanged").
  run("gifski", ["--fps", String(GIF_FPS), "--quality", opt("--gif-quality", "90"),
    "--motion-quality", "100", "--lossy-quality", "100", "-o", gif, ...pngs]);
  const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(2);
  log(`gif  ${gif}  ${mb(gif)} MB  ${pngs.length} frames @ ${GIF_FPS} fps = ${(pngs.length / GIF_FPS).toFixed(1)} s`);
  log(`mp4  ${mp4}  ${mb(mp4)} MB`);
}

// ── voicings from the real kernel ───────────────────────────────────────────
// Close voicings around middle C: the root (or slash bass) in the left hand,
// the rest stacked close in the right, the stack whose centre sits nearest F4.
// Every voicing is checked against the kernel's own loose match; the "near
// miss" moves one note a semitone (maj7↔7, or the 3rd) and must NOT match.
const VOICE_PY = String.raw`
import json, sys
from music.theory import Level, match, name_notes, parse_chord

def voice(sym, center=65.0):
    c = parse_chord(sym)
    bass_pc = c.expected_bass_pc
    bass = 48 + bass_pc
    if bass > 55:
        bass -= 12
    upper = sorted({(c.root_pc + i) % 12 for i in c.intervals} - {bass_pc})
    if len(upper) < 3:
        upper = sorted(set(upper) | {c.root_pc})
    best = None
    for start in upper:
        rot = upper[upper.index(start):] + upper[:upper.index(start)]
        for base in range(55, 70):
            if base % 12 != start:
                continue
            notes, n = [base], base
            for pc in rot[1:]:
                n += (pc - n) % 12 or 12
                notes.append(n)
            score = abs(sum(notes) / len(notes) - center)
            if best is None or score < best[0]:
                best = (score, notes)
    out = [bass] + best[1]
    assert match(frozenset(out), c, Level.LOOSE).ok, (sym, out)
    return out

def near_miss(sym, notes):
    c = parse_chord(sym)
    by_iv = {(n - c.root_pc) % 12: n for n in notes[1:]}
    for iv, step in ((11, -1), (10, 1), (4, -1), (3, 1)):
        if iv in by_iv:
            out = [n + step if n == by_iv[iv] else n for n in notes]
            break
    else:
        out = notes[:-1] + [notes[-1] + 1]
    assert not match(frozenset(out), c, Level.LOOSE).ok, (sym, out)
    names = name_notes(sorted(out), top=1)
    return {"notes": out, "name": names[0].name if names else None}

syms = json.load(sys.stdin)
notes = {s: voice(s) for s in syms}
print(json.dumps({"notes": notes, "wrong": {s: near_miss(s, notes[s]) for s in syms}}))
`;

function voicings(symbols) {
  const r = spawnSync(PY, ["-c", VOICE_PY], { cwd: REPO, input: JSON.stringify(symbols) });
  if (r.status !== 0) throw new Error("voicing helper failed:\n" + r.stderr);
  return JSON.parse(String(r.stdout));
}

// ── the keys: a second socket on /ws/state, like the on-screen piano ────────
class Keys {
  constructor(url) { this.url = url; this.waiters = []; this.seen = []; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "held" || m.type === "note") return;
      this.seen.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(m); }
    };
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  next(pred, timeout = 6000, what = "event") {
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); rej(new Error(`timed out waiting for ${what}`)); } }, timeout);
    });
  }
  async chord(notes, hold = 650, gap = 380) {
    for (const n of notes) this.send({ type: "note_in", on: true, note: n, vel: 84 });
    await sleep(hold);
    for (const n of notes) this.send({ type: "note_in", on: false, note: n, vel: 0 });
    await sleep(gap);
  }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}

// ── overlay: caption band + a pointer that shows where scripted clicks land ──
const OVERLAY_CSS = `
  #demo-cap { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000; pointer-events: none;
    display: flex; align-items: center; gap: 18px; padding: 15px 30px 16px;
    background: #0d0d10; border-top: 1px solid #2f2f37;
    font: 500 21px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #ececf0;
    opacity: 0; transform: translateY(6px); transition: opacity .35s ease, transform .35s ease; }
  #demo-cap.top { top: 0; bottom: auto; border-top: 0; border-bottom: 1px solid #2f2f37; }
  #demo-cap.show { opacity: 1; transform: none; }
  #demo-cap .step { color: #7aa2f7; font-size: 14px; font-weight: 650; letter-spacing: .1em;
    text-transform: uppercase; white-space: nowrap; min-width: 112px; }
  #demo-cap .text { flex: 1; }
  #demo-cap .text b { color: #fff; font-weight: 650; }
  #demo-cap .text .warn { color: #eab308; font-weight: 650; }
  #demo-cap .text .dim { color: #8b8b95; font-weight: 500; }
  #demo-cap .tag { color: #8b8b95; font-size: 13px; white-space: nowrap; }
  #demo-ptr { position: fixed; left: 0; top: 0; z-index: 2147483001; pointer-events: none;
    transform: translate(-60px, -60px); transition: transform .5s cubic-bezier(.3, .75, .25, 1); }
  #demo-ptr svg { filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .6)); }
  .demo-ring { position: fixed; z-index: 2147483000; pointer-events: none; width: 34px; height: 34px;
    margin: -17px 0 0 -17px; border-radius: 50%; border: 2px solid #7aa2f7;
    animation: demo-ring .55s ease-out forwards; }
  @keyframes demo-ring { from { transform: scale(.3); opacity: .95; } to { transform: scale(1.25); opacity: 0; } }
`;
const OVERLAY_HTML = {
  cap: '<span class="step"></span><span class="text"></span><span class="tag">real app · scripted keys</span>',
  ptr: '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 23 L7.5 17.8 L11.6 26.5 ' +
       'L15.2 24.8 L11.2 16.4 L19 16.2 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};
const OVERLAY_JS = `(() => {
  if (document.getElementById("demo-cap")) return true;
  const css = document.createElement("style");
  css.id = "demo-style";
  css.textContent = ${JSON.stringify(OVERLAY_CSS)};
  document.head.append(css);
  const cap = document.createElement("div");
  cap.id = "demo-cap";
  cap.innerHTML = ${JSON.stringify(OVERLAY_HTML.cap)};
  document.body.append(cap);
  const ptr = document.createElement("div");
  ptr.id = "demo-ptr";
  ptr.innerHTML = ${JSON.stringify(OVERLAY_HTML.ptr)};
  document.body.append(ptr);
  window.__demo = {
    caption(step, html, pos) {
      cap.classList.toggle("top", pos === "top");
      cap.querySelector(".step").textContent = step || "";
      cap.querySelector(".text").innerHTML = html;
      cap.classList.add("show");
    },
    point(x, y) { ptr.style.transform = "translate(" + x + "px," + y + "px)"; },
    ring(x, y) {
      const r = document.createElement("div");
      r.className = "demo-ring"; r.style.left = x + "px"; r.style.top = y + "px";
      document.body.append(r); setTimeout(() => r.remove(), 700);
    },
  };
  return true;
})()`;

function makePage(cdp, rec) {
  const page = {
    cdp,
    async overlay() { await cdp.eval(OVERLAY_JS); },
    async caption(step, html, pos = "bottom") {
      await page.overlay();
      rec.captions.push({ t: rec.now(), step, text: html.replace(/<[^>]+>/g, "") });
      await cdp.eval(`window.__demo.caption(${JSON.stringify(step)}, ${JSON.stringify(html)}, ${JSON.stringify(pos)})`);
    },
    /** Center of the first element matching `sel` (optionally whose text includes `text`). */
    async center(sel, text = null) {
      const r = await cdp.waitFor(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
          .filter((e) => ${JSON.stringify(text)} === null || e.textContent.trim().includes(${JSON.stringify(text)}));
        const e = els.find((e) => e.getBoundingClientRect().width > 0);
        if (!e) return null;
        e.scrollIntoView({ block: "nearest" });
        const b = e.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`, 8000, `${sel} ${text || ""}`);
      return r;
    },
    async pointTo(x, y) {
      await page.overlay();
      await cdp.eval(`window.__demo.point(${x}, ${y})`);
      await sleep(540);
    },
    async click(sel, text = null, opts = {}) {
      const { x, y } = await page.center(sel, text);
      await page.clickAt(x, y, opts);
    },
    async hover(sel, text = null) {
      const { x, y } = await page.center(sel, text);
      await page.pointTo(x, y);
      await rec.hold(() => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }));
    },
    async parkPointer() { await cdp.eval("window.__demo && window.__demo.point(-60, -60)"); },
    async clickAt(x, y, { dwell = 120 } = {}) {
      await page.pointTo(x, y);
      await sleep(dwell);
      await cdp.eval(`window.__demo.ring(${x}, ${y})`);
      await rec.hold(async () => {
        page.clickedAt = rec.now();          // when the press lands (a late cut can start here)
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      });
      await sleep(120);
    },
    /** Wait until a section/screen of the view is showing. */
    async shown(sel, timeout = 8000) {
      await cdp.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
        return !!e && !e.hidden && e.getBoundingClientRect().height > 0; })()`, timeout, `${sel} to show`);
    },
  };
  return page;
}

// Same display rule as the Songs view (songs.js `pretty`): Bb7(#11) → B♭7(♯11).
const pretty = (t) => String(t ?? "").replace(/#/g, "♯").replace(/(^|\/)([A-G])b/g, "$1$2♭").replace(/b(?=\d)/g, "♭");

/** Play a card's chords in order (a phrase, or a stretch of the play-through); `wrongAt` = the step
    that gets one near miss first. */
async function playSteps(keys, steps, V, { wrongAt = -1, pause = 350, hold = 650, gap = 380, onStep = null } = {}) {
  for (let i = 0; i < steps.length; i++) {
    const sym = steps[i].play;
    if (i === wrongAt) {
      const miss = keys.next((m) => m.type === "attempt", 4000, "the wrong attempt");
      await keys.chord(V.wrong[sym].notes, hold, gap);
      const a = await miss;
      if (a.verdict.ok) throw new Error(`near miss for ${sym} graded ok`);
      if (onStep) await onStep(i, "wrong");
      await sleep(850);
    }
    const graded = keys.next((m) => m.type === "step" || m.type === "passed" || (m.type === "attempt" && !m.verdict.ok),
      4000, `the ${sym} verdict`);
    await keys.chord(V.notes[sym], hold, gap);
    const m = await graded;
    if (m.type === "attempt") throw new Error(`${sym} voicing ${V.notes[sym]} graded wrong`);
    if (onStep) await onStep(i, m.type);
    await sleep(pause);
  }
}

// ── the storyboard ──────────────────────────────────────────────────────────
/** "A and B" / "A, B and C". */
const andList = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** What the check screen will show, in plain words, from the song JSON's live flags. */
function flagWords(song) {
  const per = new Map();
  for (const f of song.flags || []) {
    const sec = String(f.addr).split(".")[0];
    per.set(sec, (per.get(sec) || 0) + 1);
  }
  const barsIn = (label) => (song.sections.find((x) => x.label === label)?.lines || [])
    .reduce((n, l) => n + l.bars.length, 0);
  const clean = song.sections.map((x) => x.label).filter((l) => !per.has(l));
  const agree = clean.length === song.sections.length
    ? "They agree on every bar. Nothing is flagged."
    : clean.length ? `They agree on every bar of ${andList(clean.map((l) => `<b>${l}</b>`))}.` : "";
  const parts = [...per].map(([sec, n]) => {
    const name = sec === "Ending" ? "ending" : sec;
    return n === barsIn(sec) ? `all <b>${n} ${name} bars</b>` : `<b>${n} bar${n === 1 ? "" : "s"}</b> of the ${name}`;
  });
  const differ = per.size ? `They differ on ${andList(parts)}, so those bars are flagged beside the scan.` : "";
  return { agree, differ, count: (song.flags || []).length };
}

/**
 * Practice tab → the song → ① check the page (flags beside the scan, the form) → Looks
 * right → ② Add to review → Play through (keys lit, then Blind) → Phrases (one wrong
 * chord) → "Review works without Anki". Every caption is built from what the app shows.
 */
async function practiceStory({ page, cdp, keys, rec }) {
  const song = await (await fetch(`${APP}/api/songs/${SONG_ID}`)).json();
  const V = voicings([...new Set(song.phrases.flatMap((p) => p.steps).map((x) => x.play))]);
  log(`  song ${song.id}: ${song.phrases.length} phrases, ${song.runs.all.length}-chord play-through, `
    + `${(song.flags || []).length} flags, checked=${song.checked || "no"}`);
  const mode = (v) => `.sg-modebar button[data-v="${v}"]`;
  await cdp.waitFor(`!!document.querySelector('.pr-side .pr-item')`, 10000, "the practice sidebar");
  await page.overlay();
  await sleep(300);

  // ── 0 · one tab ────────────────────────────────────────────────────────
  rec.seg("open");
  await page.caption("Practice", "<b>Practice</b>: chords and songs in one place.", "top");
  await page.hover(".pr-group", "Chords");
  await sleep(500);
  await page.hover(".pr-group", "Songs");
  await sleep(400);
  await page.click(".pr-item", song.title);
  await page.shown(".sg-song");
  await page.caption("Song", "A new song takes three steps: check the page, add it to review, practice.", "top");
  await page.hover('.sg-stp[data-step="check"]');
  await sleep(1500);

  // ── 1 · check the page ─────────────────────────────────────────────────
  await page.click('.sg-stp[data-step="check"]');
  await page.shown(".sg-check");
  const words = flagWords(song);
  await page.caption("Check", `Claude read the page twice, blind. ${words.agree}`, "top");
  await sleep(2000);
  if (words.count) {
    await page.caption("Check", words.differ, "top");
    const end = await cdp.eval(`(() => { const i = document.querySelector('.sg-img'); const r = i.getBoundingClientRect();
      const k = Math.min(r.width / i.naturalWidth, r.height / i.naturalHeight), w = i.naturalWidth * k, h = i.naturalHeight * k;
      return { x: r.left + (r.width - w) / 2 + 0.3 * w, y: r.top + 0.89 * h }; })()`);
    await page.pointTo(end.x, end.y);
    await sleep(600);
    await page.hover(".sg-chip");
    await sleep(1500);
  }
  const form = Array.isArray(song.form) ? song.form.join(" ") : String(song.form || "");
  await page.caption("Check", `The form chips set the play order: <b>${form}</b>.`, "top");
  await page.hover(".sg-form-row .sg-form-lbl", "Form");      // the label, not a chip's ×
  await sleep(1600);
  await page.caption("Check", "<b>Looks right ✓</b> ticks step one. <span class=\"dim\">This demo skips fixing the flags.</span>", "top");
  await page.click(".sg-check .sg-head button", "Looks right");
  await page.shown(".sg-song");
  await sleep(700);

  // ── 2 · add to review ──────────────────────────────────────────────────
  await page.caption("Review", `<b>Add to review</b> puts its ${song.phrases.length} phrase cards in the built-in scheduler.`, "top");
  await page.click('.sg-stp[data-step="review"]');
  await cdp.waitFor(`/ready|In review/.test(document.querySelector('.sg-steps').innerText)`, 6000, "the stepper to tick");
  await page.hover('.pr-item[data-key="review"]');
  await sleep(1500);

  // ── 3 · play through ───────────────────────────────────────────────────
  await page.caption("Play through", "<b>Play through</b>: the chord now, the next two beside it, its keys lit.", "top");
  await page.click(mode("play"));
  const first = keys.next((m) => m.type === "prompt", 5000, "the play-through prompt");
  await page.click(".sg-modebar button", "Start");
  await first;
  await page.parkPointer();
  const run = song.runs.all;
  const lit = { notes: Object.fromEntries(run.map((st) => [st.play, st.notes])) };   // play the lit keys
  let at = 0;
  const play = async (n) => { await playSteps(keys, run.slice(at, at + n), lit, { pause: 90, hold: 520, gap: 230 }); at += n; };
  await play(6);
  await page.caption("Play through", "<b>Blind</b> hides the names and the keys. Play from memory.", "top");
  await page.click(".sg-toggle", "Blind");
  await page.parkPointer();
  await sleep(300);
  await play(3);
  await sleep(300);
  await page.click(".sg-modebar button", "Stop");
  await sleep(200);

  // ── 4 · phrases ────────────────────────────────────────────────────────
  await page.caption("Phrases", "<b>Phrases</b>: one printed line from memory, after its cue.", "top");
  await page.click(mode("phrases"));
  await sleep(250);
  const phraseByRef = new Map(song.phrases.map((x) => [`song:${SONG_ID}:phrase:${x.id}`, x]));
  // The deck is shuffled. A line with no cue ("from the top") or more than 4 chords (B line 4,
  // the flagged ending) is restarted off camera: the cut starts as the Start press lands, so
  // no frame of that card is kept.
  // SONGS_DEMO_RETAKE=1 forces one retake (to test this path).
  let phrase = null, clickedAt = 0;
  for (let take = 0; take < 6 && !phrase; take++) {
    const prompt = keys.next((m) => m.type === "prompt", 5000, "a phrase prompt");
    if (take === 0) {
      await page.click(".sg-modebar button", "Start");
      clickedAt = page.clickedAt;
    } else {
      await cdp.eval(`[...document.querySelectorAll('.sg-modebar button')].find((b) => b.textContent.trim() === 'Stop').click()`);
      await sleep(500);
      await cdp.eval(`[...document.querySelectorAll('.sg-modebar button')].find((b) => b.textContent.trim() === 'Start').click()`);
    }
    const p = phraseByRef.get((await prompt).ref);
    const forced = take === 0 && process.env.SONGS_DEMO_RETAKE === "1";
    if (p && p.steps.length <= 4 && p.cue && !forced) phrase = p;
    else {
      log(`  retake: ${p ? `${p.name} (${p.steps.length} chords, cue ${p.cue || "none"})` : "?"}${forced ? " (forced)" : ""}`);
      if (take === 0) rec.segAt(clickedAt + 0.04, "retake", 0);
    }
  }
  if (!phrase) throw new Error("no 4-chord cued line came up in 6 takes");
  if (rec.segs.at(-1).speed === 0) {
    await sleep(250);                       // let the page draw the new card first
    rec.seg("phrase card");
  }
  await page.parkPointer();
  const cue = phrase.cue ? `after ${pretty(phrase.cue)}` : "from the top";
  await page.caption("Phrases", `Cue: <b>${phrase.name}, ${cue}</b>. Play its ${phrase.steps.length} chords.`, "top");
  await sleep(900);
  const passed = keys.next((m) => m.type === "passed", 20000, "the phrase to pass");
  await playSteps(keys, phrase.steps, V, {
    wrongAt: Math.min(2, phrase.steps.length - 1), pause: 140, hold: 580, gap: 280,
    onStep: async (i, kind) => {
      if (kind === "wrong") await page.caption("Phrases", "A wrong chord shows the answer in <span class=\"warn\">amber</span>.", "top");
    },
  });
  const g = (await passed).grade;
  const acc = g ? g.accuracy : null;
  await page.caption("Phrases", g ? `The card passes, graded <b>${g.label}</b>: ${acc.wrong} wrong chord${acc.wrong === 1 ? "" : "s"}, ${acc.notes_off} notes off.`
    : "The card passes.", "top");
  await sleep(1500);
  await page.click(".sg-modebar button", "Stop");
  await sleep(200);

  // ── 5 · no Anki needed ─────────────────────────────────────────────────
  await page.caption("Review", "Review works without Anki · Anki is optional.", "bottom");
  await page.hover("#srs-sel");
  await sleep(2600);
  rec.seg("tail", 0);
}

// ── main ────────────────────────────────────────────────────────────────────
async function capture() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "songs-demo-capture-"));
  const profile = path.join(work, "chrome-profile");
  log("work dir", work);
  let cdp = null, keys = null;
  try {
    await startServer();
    const { wsUrl } = await startChrome(profile);
    cdp = new CDP(wsUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: SCALE, mobile: false });
    await cdp.send("Page.navigate", { url: APP + "/" });
    await cdp.waitFor(`document.querySelectorAll('nav#tabs button').length > 3`, 15000, "the cockpit tabs");
    await sleep(600);

    keys = new Keys(`ws://127.0.0.1:${APP_PORT}/ws/state`);
    await keys.open();

    const rec = new Recorder(cdp, path.join(work, "raw"));
    rec.start();
    await practiceStory({ page: makePage(cdp, rec), cdp, keys, rec });
    await rec.stop();
    fs.writeFileSync(path.join(work, "capture.json"), JSON.stringify({ frames: rec.frames, segs: rec.segs, captions: rec.captions }));
    if (cdp.errors.length) log("page errors:\n  " + cdp.errors.join("\n  "));
    log(`captured ${rec.frames.length} frames over ${rec.frames.at(-1)?.t.toFixed(1)} s`);
  } catch (e) {
    // leave evidence: what the page looked like, and what the keys socket heard
    try {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(work, "fail.png"), Buffer.from(shot.data, "base64"));
      fs.writeFileSync(path.join(work, "fail-events.json"), JSON.stringify(keys?.seen || [], null, 1));
      log("failure evidence in", work, "(fail.png, fail-events.json)");
      if (cdp.errors.length) log("page errors:\n  " + cdp.errors.join("\n  "));
    } catch { /* no page to shoot */ }
    throw e;
  } finally {
    keys?.close();
    cdp?.close();
    killOwned();
    await sleep(800);
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return work;
}

async function main() {
  const work = opt("--encode", null) || (await capture());
  encode(work);
  if (flag("--keep") || opt("--encode", null)) log("kept", work);
  else fs.rmSync(work, { recursive: true, force: true });
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); killOwned(); process.exit(1); });
