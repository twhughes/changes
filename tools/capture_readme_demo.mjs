#!/usr/bin/env node
/* README hero — the STATIC page (no server), driven by scripted keys, captured headless.

   One command (from the repo root):
       node tools/capture_readme_demo.mjs        → docs/images/practice.gif + docs/images/practice.png
   Flags:
       --build          rebuild site/ first (python tools/build_site.py)
       --keep           keep the work dir (raw frames + timeline) and print its path
       --encode <dir>   re-encode a kept work dir without capturing again
       --out <dir>      where practice.gif / practice.png go (default: docs/images/)
       --gif-quality N  gifski quality (default 80)    --fps N  GIF frame rate (default 10)

   The page is served the way GitHub Pages serves it — under a sub-path: a temp dir holds a
   symlink `changes` → site/, and `python3 -m http.server` (127.0.0.1, a free port) serves it;
   Chrome opens http://127.0.0.1:<port>/changes/. Only the demo songs ship in site/ (no
   scans). Chrome runs headless with a throwaway profile (so review state in localStorage
   starts empty), audio muted, viewport 1470×760 captured at 2×.

   Storyboard: Play, where the page opens (a Cmaj7, then C6 — Am7/C, named as held) → the sidebar
   (Chords, Progressions) → Advanced → Start → Show keys → a jazz chord played off the lit keys →
   the Songs group → I Got Rhythm → Play through (the
   hinted keys lit gold, 6 chords) → Blind (2 chords) → Phrases: A line 2 · 2nd ending after its
   cue, one wrong chord (the answer shows amber), the "✓ A line …" done line → Add to review →
   the song's due badge and the Review badge. A second Play through (not in the GIF) gives the 2× still: chord 11/50, keys lit.
   Notes go in through the page's test hook window.__musicStatic (noteOn/noteOff — the path
   the on-screen piano and Web MIDI take); the voicing played is the one the page lights.
   Drill events come back over a CDP binding tapped onto the runtime's socket. The phrase
   deck is shuffled: until that line leads, the deck is restarted off camera (a cut). A pill caption, a "scripted keys" tag and a pointer
   (where the scripted clicks land) are an overlay; the app's files are untouched.
   Only the PIDs this script spawns are ever killed.

   CDP driver adapted from tools/capture_songs_demo.mjs (recipe: tools/capture_demo.js).  */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(REPO, "site");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VW = 1470, VH = 760, SCALE = 2;          // Tyler's 13" Air at 100 %, captured at 2x
const SHOT_MS = 66;                             // capture cadence (~15 fps)
const GIF_W = 1200;
const SONG_ID = "i-got-rhythm";
const RESERVED = new Set([8768, 8995, 8996, 8999]);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const OUT = path.resolve(opt("--out", path.join(REPO, "docs", "images")));
const GIF_FPS = Number(opt("--fps", "10"));
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

async function freePort() {
  for (;;) {
    const port = await new Promise((res, rej) => {
      const srv = net.createServer();
      srv.once("error", rej);
      srv.listen(0, "127.0.0.1", () => { const { port: p } = srv.address(); srv.close(() => res(p)); });
    });
    if (!RESERVED.has(port)) return port;
  }
}

async function serveSite(work) {
  const www = path.join(work, "www");
  fs.mkdirSync(www);
  fs.symlinkSync(SITE, path.join(www, "changes"));
  const port = await freePort();
  const srv = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", www],
    { stdio: "ignore" });
  owned.push(srv);
  const url = `http://127.0.0.1:${port}/changes/`;
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (srv.exitCode !== null) break;
    try { if ((await fetch(url)).ok) { log("serving", url, "pid", srv.pid); return url; } } catch { /* not yet */ }
  }
  throw new Error("python3 -m http.server never came up");
}

/** Remove the served dir: unlink the `changes` symlink itself (never what it points at). */
function unserve(work) {
  const link = path.join(work, "www", "changes");
  try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* not made */ }
  try { fs.rmdirSync(path.join(work, "www")); } catch { /* not made, or not empty: leave it */ }
}

async function startChrome(profile) {
  const port = await freePort();
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${VW},${VH}`, "--hide-scrollbars", "--mute-audio", "--lang=en-US",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "about:blank",
  ], { stdio: "ignore" });
  owned.push(chrome);
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) { log("chrome pid", chrome.pid, "cdp", port); return page.webSocketDebuggerUrl; }
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
  async waitFor(expr, timeout = 8000, what = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = await this.eval(expr); if (v) return v; } catch { /* page mid-render */ }
      await sleep(60);
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
  /** From now on the footage plays at `speed` (1 = real time, 0 = cut). */
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

/** Source seconds → seconds in the finished GIF (cut segments vanish). */
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

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed:\n${String(r.stderr).slice(-1500)}`);
  return String(r.stdout);
}

function encode(work) {
  const { frames, segs, captions = [] } = JSON.parse(fs.readFileSync(path.join(work, "capture.json"), "utf8"));
  log("storyboard (time in the finished GIF):");
  for (const s of segs.filter((x) => x.speed !== 1)) log(`  ${outTime(segs, s.t).toFixed(1).padStart(5)} s  [${s.label}${s.speed ? `, ×${s.speed}` : ", cut"}]`);
  for (const c of captions) log(`  ${outTime(segs, c.t).toFixed(1).padStart(5)} s  ${c.text}`);
  fs.mkdirSync(OUT, { recursive: true });
  const seq = path.join(work, "seq-gif");
  fs.rmSync(seq, { recursive: true, force: true });
  fs.mkdirSync(seq, { recursive: true });
  timeline(frames, segs, GIF_FPS).forEach((f, k) => fs.symlinkSync(f, path.join(seq, `${String(k).padStart(5, "0")}.png`)));
  const small = path.join(work, "gif-png");
  fs.rmSync(small, { recursive: true, force: true });
  fs.mkdirSync(small);
  run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(GIF_FPS), "-i", path.join(seq, "%05d.png"),
    "-vf", `scale=${GIF_W}:-2:flags=lanczos`, path.join(small, "%05d.png")]);
  const pngs = fs.readdirSync(small).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(small, f));
  const gif = path.join(OUT, "practice.gif");
  // motion/lossy at 100: gifski's temporal shortcuts otherwise leave faint ghosts of moved
  // overlay text on the near-black ground.
  run("gifski", ["--fps", String(GIF_FPS), "--quality", opt("--gif-quality", "80"),
    "--motion-quality", "100", "--lossy-quality", "100", "-o", gif, ...pngs]);
  const still = path.join(work, "still.png");
  if (fs.existsSync(still)) fs.copyFileSync(still, path.join(OUT, "practice.png"));
  const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(2);
  log(`gif  ${gif}  ${mb(gif)} MB  ${pngs.length} frames @ ${GIF_FPS} fps = ${(pngs.length / GIF_FPS).toFixed(1)} s`);
  if (fs.existsSync(still)) log(`png  ${path.join(OUT, "practice.png")}  ${mb(still)} MB`);
}

// ── the hands: the page's test hook in, the runtime's socket out ───────────
class Hands {
  constructor(cdp) { this.cdp = cdp; this.waiters = []; this.seen = []; }
  async open() {
    await this.cdp.send("Runtime.addBinding", { name: "__demoEmit" });
    this.cdp.subs.push((m) => {
      if (m.method !== "Runtime.bindingCalled" || m.params.name !== "__demoEmit") return;
      const ev = JSON.parse(m.params.payload);
      this.seen.push(ev);
      for (const w of [...this.waiters]) if (w.pred(ev)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(ev); }
    });
    await this.cdp.eval(`(() => {
      if (!window.__demoTap) window.__demoTap = window.__musicStatic.runtime.socket.on("*", (m) => {
        if (m.type !== "held" && m.type !== "note") __demoEmit(JSON.stringify(m));
      });
      return true; })()`);
  }
  next(pred, timeout = 6000, what = "event") {
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); rej(new Error(`timed out waiting for ${what}`)); } }, timeout);
    });
  }
  async chord(notes, hold = 650, gap = 300) {
    await this.cdp.eval(`${JSON.stringify(notes)}.forEach((n) => window.__musicStatic.noteOn(n, 84)); true`);
    await sleep(hold);
    await this.cdp.eval(`${JSON.stringify(notes)}.forEach((n) => window.__musicStatic.noteOff(n)); true`);
    await sleep(gap);
  }
  target() { return this.cdp.eval("window.__musicStatic.target()"); }
}

const pcsOf = (notes) => new Set(notes.map((n) => ((n % 12) + 12) % 12));
const covers = (notes, req) => { const have = pcsOf(notes); return req.every((pc) => have.has(pc)); };

/** One note a semitone off (top voice first) so a required pitch class goes missing. */
function nearMiss(notes, req) {
  for (let i = notes.length - 1; i >= 1; i--) {
    for (const d of [-1, 1]) {
      const out = notes.map((n, k) => (k === i ? n + d : n));
      if (!covers(out, req)) return out;
    }
  }
  throw new Error(`no near miss for ${notes}`);
}

/** Play steps in order with the voicing the page lights (`notes`); `wrongAt` gets one near miss first. */
async function playSteps(hands, steps, { wrongAt = -1, hold = 650, gap = 300, pause = 60, onWrong = null } = {}) {
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const t = await hands.target();
    if (!t || !t.chord || t.chord.text !== st.play) throw new Error(`expected ${st.play}, the page asks ${JSON.stringify(t)}`);
    if (!covers(st.notes, t.chord.req)) throw new Error(`${st.play}: ${st.notes} misses a required tone`);
    if (i === wrongAt) {
      const miss = hands.next((m) => m.type === "attempt", 4000, "the wrong attempt");
      await hands.chord(nearMiss(st.notes, t.chord.req), hold, gap);
      if ((await miss).verdict.ok) throw new Error(`the near miss for ${st.play} passed`);
      if (onWrong) await onWrong(st);
      await sleep(600);
    }
    const graded = hands.next((m) => m.type === "step" || m.type === "passed" || (m.type === "attempt" && !m.verdict.ok),
      4000, `the ${st.play} verdict`);
    await hands.chord(st.notes, hold, gap);
    const m = await graded;
    if (m.type === "attempt") throw new Error(`${st.play} (${st.notes}) graded wrong`);
    await sleep(pause);
  }
}

// ── overlay: one pill caption, a "scripted keys" tag, a pointer ─────────────
const OVERLAY_CSS = `
  #demo-cap { position: fixed; left: 50%; top: 560px; z-index: 2147483000; pointer-events: none;
    transform: translate(-50%, 4px); padding: 9px 20px; border-radius: 999px; white-space: nowrap;
    background: rgba(13, 13, 16, 0.94); border: 1px solid #34343d; color: #ececf0;
    font: 500 19px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
    opacity: 0; transition: opacity .3s ease, transform .3s ease; }
  #demo-cap.show { opacity: 1; transform: translate(-50%, 0); }
  #demo-cap b { color: #fff; font-weight: 650; }
  #demo-cap .warn { color: #eab308; font-weight: 650; }
  #demo-tag { position: fixed; right: 14px; bottom: 12px; z-index: 2147483000; pointer-events: none;
    padding: 4px 10px; border-radius: 999px; border: 1px solid #2f2f37; background: rgba(13, 13, 16, 0.9);
    color: #8b8b95; font: 500 12px/1.2 system-ui, -apple-system, sans-serif; }
  #demo-ptr { position: fixed; left: 0; top: 0; z-index: 2147483001; pointer-events: none;
    transform: translate(-60px, -60px); transition: transform .45s cubic-bezier(.3, .75, .25, 1); }
  #demo-ptr svg { filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .6)); }
  .demo-ring { position: fixed; z-index: 2147483000; pointer-events: none; width: 32px; height: 32px;
    margin: -16px 0 0 -16px; border-radius: 50%; border: 2px solid #7aa2f7;
    animation: demo-ring .5s ease-out forwards; }
  @keyframes demo-ring { from { transform: scale(.3); opacity: .95; } to { transform: scale(1.2); opacity: 0; } }
  html.demo-clean #demo-cap, html.demo-clean #demo-tag, html.demo-clean #demo-ptr, html.demo-clean .demo-ring { display: none !important; }
`;
const POINTER_SVG = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 23 L7.5 17.8 L11.6 26.5 ' +
  'L15.2 24.8 L11.2 16.4 L19 16.2 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const OVERLAY_JS = `(() => {
  if (document.getElementById("demo-cap")) return true;
  const css = document.createElement("style");
  css.textContent = ${JSON.stringify(OVERLAY_CSS)};
  document.head.append(css);
  const cap = document.createElement("div");
  cap.id = "demo-cap";
  const tag = document.createElement("div");
  tag.id = "demo-tag";
  tag.textContent = "scripted keys";
  const ptr = document.createElement("div");
  ptr.id = "demo-ptr";
  ptr.innerHTML = ${JSON.stringify(POINTER_SVG)};
  document.body.append(cap, tag, ptr);
  // The pill sits in the pane's empty middle: between the chart and the piano on a song,
  // under the piano elsewhere — never over the UI it explains.
  const place = () => {
    const pane = document.querySelector(".pr-pane");
    const r = pane ? pane.getBoundingClientRect() : { left: 0, width: innerWidth };
    const song = document.querySelector(".sg-song:not([hidden])");
    const chart = song && song.querySelector(".sg-chart");
    const piano = song && song.querySelector(".sg-piano");
    let y = innerHeight - 170;
    if (chart && piano) y = (chart.getBoundingClientRect().bottom + piano.getBoundingClientRect().top) / 2 - 22;
    // Play: the piano fills the bottom, so the pill sits between the chord's notes and the keys.
    const chord = document.querySelector(".pl-chord");
    const playKeys = chord && document.querySelector(".pl .piano-wrap");
    if (chord && playKeys) y = (chord.getBoundingClientRect().bottom + 40 + playKeys.getBoundingClientRect().top) / 2 - 22;
    cap.style.left = (r.left + r.width / 2) + "px";
    cap.style.top = y + "px";
  };
  window.__demo = {
    caption(html) { place(); cap.innerHTML = html; cap.classList.add("show"); },
    hide() { cap.classList.remove("show"); },
    point(x, y) { ptr.style.transform = "translate(" + x + "px," + y + "px)"; },
    ring(x, y) {
      const r = document.createElement("div");
      r.className = "demo-ring"; r.style.left = x + "px"; r.style.top = y + "px";
      document.body.append(r); setTimeout(() => r.remove(), 600);
    },
  };
  return true;
})()`;

function makePage(cdp, rec) {
  const page = {
    async overlay() { await cdp.eval(OVERLAY_JS); },
    async caption(html) {
      await page.overlay();
      rec.captions.push({ t: rec.now(), text: html.replace(/<[^>]+>/g, "") });
      await cdp.eval(`window.__demo.caption(${JSON.stringify(html)})`);
    },
    async hideCaption() { await cdp.eval("window.__demo && window.__demo.hide()"); },
    /** Center of the first visible element matching `sel` (optionally whose text includes `text`). */
    async center(sel, text = null) {
      return cdp.waitFor(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
          .filter((e) => ${JSON.stringify(text)} === null || e.textContent.trim().includes(${JSON.stringify(text)}));
        const e = els.find((e) => e.getBoundingClientRect().width > 0 && !e.disabled);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`, 8000, `${sel} ${text || ""}`);
    },
    async pointTo(x, y) {
      await page.overlay();
      await cdp.eval(`window.__demo.point(${x}, ${y})`);
      await sleep(480);
    },
    async click(sel, text = null) {
      const { x, y } = await page.center(sel, text);
      await page.pointTo(x, y);
      await sleep(90);
      await cdp.eval(`window.__demo.ring(${x}, ${y})`);
      await rec.hold(async () => {
        page.clickedAt = rec.now();          // when the press lands (a late cut can start here)
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      });
      await sleep(110);
    },
    async hover(sel, text = null) {
      const { x, y } = await page.center(sel, text);
      await page.pointTo(x, y);
      await rec.hold(() => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }));
    },
    async parkPointer() { await cdp.eval("window.__demo && window.__demo.point(-60, -60)"); },
    async shown(sel, timeout = 8000) {
      await cdp.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
        return !!e && !e.hidden && e.getBoundingClientRect().height > 0; })()`, timeout, `${sel} to show`);
    },
  };
  return page;
}

// Same display rule as the Songs view (songs.js `pretty`): Bb7(#11) → B♭7(♯11).
const pretty = (t) => String(t ?? "").replace(/#/g, "♯").replace(/(^|\/)([A-G])b/g, "$1$2♭").replace(/b(?=\d)/g, "♭");

// ── the storyboard ──────────────────────────────────────────────────────────
async function story({ page, cdp, hands, rec, url, work }) {
  const data = await (await fetch(new URL(`data/songs/${SONG_ID}.json`, url))).json();
  const song = data.dials[data.grade || "core"].song;
  const run = song.runs.all;
  log(`  ${song.title}: ${run.length}-chord play-through, ${song.phrases.length} phrases`);
  const mode = (v) => `.sg-modebar button[data-v="${v}"]`;
  await page.overlay();
  await sleep(300);

  // 0 · Play: the page opens here — hold anything, it is named. One click first: the browser
  //     starts the page's sound on a click (scripted notes alone would show "Click anywhere").
  await page.click(".pl-stage");
  await page.parkPointer();
  rec.seg("open");
  await page.caption("<b>Play</b>: hold anything — the chord is named as you play.");
  await sleep(500);
  await hands.chord([48, 64, 67, 71], 1100, 250);          // Cmaj7
  await hands.chord([48, 64, 67, 69], 1300, 250);          // C6 — and Am7/C beside it

  // 0a · the menu — chords, progressions, songs
  await page.caption("<b>Practice</b>: chords, progressions and songs.");
  await page.hover(".pr-group", "Chords");
  await sleep(350);
  await page.hover(".pr-group", "Progressions");
  await sleep(350);

  // 0b · the Advanced chords, keys lit (the trainer's prompt carries the hint voicing)
  await page.click('.pr-item[data-key="deck:advanced"]');
  await page.shown("#t-title");
  await page.caption("<b>Advanced</b>: the jazz chords. <b>Show keys</b> lights one voicing.");
  const card = hands.next((m) => m.type === "prompt", 5000, "an Advanced card");
  await page.click("#start");
  let prompt = await card;
  await sleep(350);
  await page.click("#keys-lbl");
  await page.parkPointer();
  await sleep(700);
  for (let i = 0; i < 1; i++) {
    if (!Array.isArray(prompt.notes)) throw new Error(`no hint notes on ${prompt.chord}`);
    const passed = hands.next((m) => m.type === "passed", 5000, `${prompt.chord} to pass`);
    const following = hands.next((m) => m.type === "prompt", 5000, "the next card");
    await hands.chord(prompt.notes, 700, 300);
    await passed;
    prompt = await following;
    await sleep(900);                          // the grade line shows
  }

  // 0c · the songs, in a group that folds (picking one ends the live drill — no Stop needed)
  await page.caption("<b>Songs</b>: every chart in one list that folds away.");
  await page.hover('[data-key="songs-group"]');
  await sleep(400);
  await page.click(`.pr-item[data-key="song:${SONG_ID}"]`);
  await page.shown(".sg-song");
  await sleep(100);

  // 1 · play through, keys lit
  await page.caption("<b>Play through</b>: the chord now, the next two beside it, its keys lit.");
  await page.click(mode("play"));
  const first = hands.next((m) => m.type === "prompt", 5000, "the play-through prompt");
  await page.click(".sg-modebar button", "Start");
  await first;
  await page.parkPointer();
  await sleep(200);
  await playSteps(hands, run.slice(0, 6));

  // 2 · blind
  await page.caption("<b>Blind</b>: no names, no keys. Play from memory.");
  await page.click(".sg-toggle", "Blind");
  await page.parkPointer();
  await sleep(200);
  await playSteps(hands, run.slice(6, 8));
  await sleep(200);
  await page.click(".sg-modebar button", "Stop");

  // 3 · phrases: an A line after its cue, one wrong chord
  await page.caption("<b>Phrases</b>: one printed line from memory, after its cue.");
  await page.click(mode("phrases"));
  const byRef = new Map(song.phrases.map((p) => [`song:${SONG_ID}:phrase:${p.id}`, p]));
  // The deck is shuffled. Anything but the shorter A line with a cue (A line 1 starts "from
  // the top", the 1st ending runs 8 chords, the B lines are two) is restarted off camera: the
  // cut starts as the Start press lands, so no frame of that card is kept.
  // README_DEMO_RETAKE=1 forces one retake (a test of this path).
  let phrase = null, pressedAt = 0;
  for (let take = 0; take < 30 && !phrase; take++) {
    const prompt = hands.next((m) => m.type === "prompt", 5000, "a phrase prompt");
    if (take === 0) {
      await page.click(".sg-modebar button", "Start");
      pressedAt = page.clickedAt;
    } else {
      await cdp.eval(`[...document.querySelectorAll('.sg-modebar button')].find((b) => b.textContent.trim() === 'Stop').click()`);
      await sleep(400);
      await cdp.eval(`[...document.querySelectorAll('.sg-modebar button')].find((b) => b.textContent.trim() === 'Start').click()`);
    }
    const p = byRef.get((await prompt).ref);
    const forced = take === 0 && process.env.README_DEMO_RETAKE === "1";
    if (p && p.section === "A" && p.cue && p.steps.length <= 7 && !forced) phrase = p;
    else {
      log(`  retake: ${p ? `${p.name} (cue ${p.cue || "none"})` : "?"}${forced ? " (forced)" : ""}`);
      if (take === 0) rec.segAt(pressedAt + 0.04, "retake", 0);
    }
  }
  if (!phrase) throw new Error("no cued A line of ≤7 chords came up in 30 takes");
  if (rec.segs.at(-1).speed === 0) {
    await sleep(250);                        // let the page draw the new card first
    rec.seg("phrase card");
  }
  await page.parkPointer();
  await page.caption(`Cue: <b>${phrase.name}, after ${pretty(phrase.cue)}</b>. Its ${phrase.steps.length} chords stay hidden.`);
  await sleep(600);
  const passed = hands.next((m) => m.type === "passed", 30000, "the phrase to pass");
  await playSteps(hands, phrase.steps, {
    wrongAt: 2,
    onWrong: async () => page.caption("A wrong chord shows the answer in <span class=\"warn\">amber</span>."),
  });
  const g = (await passed).grade;
  await page.caption(`✓ <b>${phrase.name}</b> passes, graded <b>${g ? g.label : "—"}</b>.`);
  await sleep(1400);
  await page.click(".sg-modebar button", "Stop");

  // 4 · add to review → the song's due badge, the Review badge
  await page.caption("<b>Add to review</b>: its phrase cards wait in Review.");
  await page.click('.sg-stp[data-step="review"]');
  await cdp.waitFor(`!!document.querySelector('.pr-item[data-key="review"] .pr-due')`, 6000, "the Review badge");
  await page.hover('.pr-item[data-key="review"] .pr-item-title');   // beside the badge, not over it
  await sleep(1600);
  rec.seg("tail", 0);

  // The still (not in the GIF): Play through mid-song, the next chord's keys lit, no overlay.
  await page.click(mode("play"));
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('.sg-toggle')].find((l) => l.textContent.includes('Blind'));
    const box = b && b.querySelector('input'); if (box && box.checked) box.click(); return true; })()`);
  const again = hands.next((m) => m.type === "prompt", 5000, "the play-through prompt (still)");
  await page.click(".sg-modebar button", "Start");
  await again;
  await playSteps(hands, run.slice(0, 10), { hold: 420, gap: 160, pause: 20 });
  await sleep(1000);                         // the green verdict flash fades (800 ms)
  await rec.hold(async () => {
    await cdp.eval(`document.documentElement.classList.add("demo-clean"); true`);
    await sleep(120);
    const { data: png } = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(work, "still.png"), Buffer.from(png, "base64"));
    await cdp.eval(`document.documentElement.classList.remove("demo-clean"); true`);
  });
  log(`  still: Play through at chord 11/${run.length}, ${pretty(run[10].play)} lit`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function capture() {
  if (flag("--build")) {
    const py = fs.existsSync(path.join(REPO, ".venv", "bin", "python")) ? path.join(REPO, ".venv", "bin", "python") : "python3";
    log(run(py, [path.join(REPO, "tools", "build_site.py")]).trim());
  }
  if (!fs.existsSync(path.join(SITE, "index.html"))) throw new Error("no site/ — run with --build");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "readme-demo-"));
  log("work dir", work);
  let cdp = null, hands = null;
  try {
    const url = await serveSite(work);
    cdp = new CDP(await startChrome(path.join(work, "chrome-profile")));
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: SCALE, mobile: false });
    await cdp.send("Page.navigate", { url });
    await cdp.waitFor(`!!document.querySelector('.pr-item[data-key="review"]') && !!window.__musicStatic`, 15000, "the Practice sidebar");
    await sleep(500);
    hands = new Hands(cdp);
    await hands.open();
    const rec = new Recorder(cdp, path.join(work, "raw"));
    rec.start();
    await story({ page: makePage(cdp, rec), cdp, hands, rec, url, work });
    await rec.stop();
    fs.writeFileSync(path.join(work, "capture.json"), JSON.stringify({ frames: rec.frames, segs: rec.segs, captions: rec.captions }));
    const errors = cdp.errors.filter((e) => !/MIDI/i.test(e));
    if (errors.length) log("page errors:\n  " + errors.join("\n  "));
    log(`captured ${rec.frames.length} frames over ${rec.frames.at(-1)?.t.toFixed(1)} s`);
  } catch (e) {
    try {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(work, "fail.png"), Buffer.from(data, "base64"));
      fs.writeFileSync(path.join(work, "fail-events.json"), JSON.stringify(hands?.seen || [], null, 1));
      log("failure evidence in", work, "(fail.png, fail-events.json)");
    } catch { /* no page to shoot */ }
    throw e;
  } finally {
    cdp?.close();
    killOwned();
    await sleep(800);
    fs.rmSync(path.join(work, "chrome-profile"), { recursive: true, force: true });
    unserve(work);
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
