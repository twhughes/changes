#!/usr/bin/env node
/* Smoke test of the static page in a real browser — headless Chrome, scripted hands.

       node tools/smoke_static_site.mjs [--keep] [--out DIR]

   Builds the page (tools/build_site.py) under a /changes/ subpath, the way GitHub Pages serves
   it, serves that with `python3 -m http.server` on a free loopback port, and drives headless
   Chrome over CDP (throwaway profile, audio muted, 1470×760 — Tyler's 13" Air at 100 %):

     1. the page opens on Play (no console errors, no page scroll, no tab bar; 🔈 / 🧠 / chip);
        a held chord is named big, its notes under it
     2. Triads → Start → Show keys lights the chord → it is played → a pass with its grade
     3. the Songs group folds and opens; I Got Rhythm → Play through → Start → four chords in order
     4. Add to review → the song's due badge and Review's count go up
     5. Review shows the due cards → reload → the count is still there (localStorage)
     6. 🔈 → S-1 twin → ⚙ opens its knobs (no page scroll) → Esc closes them

   Notes go in through window.__musicStatic (static page only) — the same path the on-screen
   piano and Web MIDI take. Screenshots land in the work dir (printed; --keep keeps it).
   Never touches Tyler's browser: only the PIDs this script spawns are ever killed.  */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VW = 1470, VH = 760;
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const outArg = argv.indexOf("--out");
const WORK = outArg >= 0 ? path.resolve(argv[outArg + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), "music-smoke-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a);

const owned = [];
function killOwned() {
  for (const child of owned) {
    try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); } catch { /* gone */ }
  }
}
process.on("exit", killOwned);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killOwned(); process.exit(130); });

const freePort = () => new Promise((res, rej) => {
  const srv = net.createServer();
  srv.once("error", rej);
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => res(port)); });
});

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.waiting = new Map(); this.errors = []; }
  async open() {
    this.sock = new WebSocket(this.url);
    await new Promise((res, rej) => { this.sock.onopen = res; this.sock.onerror = rej; });
    this.sock.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)(m); this.waiting.delete(m.id); return; }
      if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") this.errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error") this.errors.push(`${m.params.entry.text} ${m.params.entry.url || ""}`);
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
      try { const v = await this.eval(expr); if (v) return v; } catch { /* mid-render */ }
      await sleep(60);
    }
    throw new Error(`timed out waiting for ${what.slice(0, 160)}`);
  }
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// In-page helpers: click a sidebar item / a button by its text, play the live target.
const HELPERS = `
  window.__smoke = {
    item: (key) => { const b = document.querySelector('.pr-item[data-key="' + key + '"]'); if (!b) throw new Error('no item ' + key); b.click(); },
    button: (label) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === label && !x.disabled && x.offsetParent !== null);
      if (!b) throw new Error('no visible button ' + label);
      b.click();
    },
    due: (key) => { const b = document.querySelector('.pr-item[data-key="' + key + '"] .pr-due'); return b ? Number(b.textContent) : 0; },
    async play(ms = 420) {
      const t = window.__musicStatic.target();
      if (!t) throw new Error('nothing to play');
      const notes = t.pitches ? t.pitches : [36 + t.chord.bass, ...t.chord.req.map((pc) => 60 + pc)];
      notes.forEach((n) => window.__musicStatic.noteOn(n, 96));
      await new Promise((r) => setTimeout(r, ms));
      notes.forEach((n) => window.__musicStatic.noteOff(n));
      await new Promise((r) => setTimeout(r, 140));
      return t.chord ? t.chord.text : t.pitches.join('+');
    },
  };
  true;`;

async function main() {
  const www = path.join(WORK, "www");
  const site = path.join(www, "changes");
  const py = fs.existsSync(path.join(REPO, ".venv", "bin", "python")) ? path.join(REPO, ".venv", "bin", "python") : "python3";
  const built = spawnSync(py, [path.join(REPO, "tools", "build_site.py"), "--out", site], { cwd: REPO, encoding: "utf8" });
  if (built.status !== 0) throw new Error(`build failed:\n${built.stdout}${built.stderr}`);
  log(built.stdout.trim());

  const port = await freePort();
  const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", www],
    { stdio: "ignore" });
  owned.push(server);
  const url = `http://127.0.0.1:${port}/changes/`;
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    try { if ((await fetch(url)).ok) break; } catch { /* not yet */ }
  }
  log("serving", url, "pid", server.pid);

  const cdpPort = await freePort();
  const profile = path.join(WORK, "chrome-profile");
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    `--window-size=${VW},${VH}`, "--hide-scrollbars", "--mute-audio", "--lang=en-US",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "about:blank",
  ], { stdio: "ignore" });
  owned.push(chrome);
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      wsUrl = (list.find((t) => t.type === "page") || {}).webSocketDebuggerUrl || null;
    } catch { /* not up yet */ }
  }
  if (!wsUrl) throw new Error("headless Chrome never came up");
  log("chrome pid", chrome.pid);

  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  const shotsDir = path.join(WORK, "shots");
  fs.mkdirSync(shotsDir, { recursive: true });
  const shot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(data, "base64"));
  };
  const load = async () => {
    await cdp.send("Page.navigate", { url });
    await cdp.waitFor(`!!document.querySelector('.pr-item[data-key="review"]') && !!window.__musicStatic`, 15000, "the Practice sidebar");
    await cdp.eval(HELPERS);
    await sleep(300);
  };

  // 1. the page
  await load();
  const shell = await cdp.eval(`({
    tabs: !!document.getElementById('tabs')?.offsetParent,
    logic: !!document.getElementById('logic-btn'),
    sound: document.getElementById('sound-sel').value,
    sounds: [...document.getElementById('sound-sel').options].map((o) => o.value),
    srs: [...document.getElementById('srs-sel').options].map((o) => o.textContent),
    chip: document.getElementById('port-chip').textContent,
    scroll: [document.documentElement.scrollHeight, document.documentElement.scrollWidth, innerHeight, innerWidth],
    menu: [...document.querySelectorAll('.pr-item')].map((b) => b.dataset.key),
  })`);
  check("one page: no tab bar, no Logic button", !shell.tabs && !shell.logic);
  check("🔈 offers the e-piano (default), the S-1 twin and off", shell.sound === "samples" && shell.sounds.join() === "samples,twin,off", `${shell.sound} of ${shell.sounds.join(", ")}`);
  check("🧠 offers Built-in only", shell.srs.join() === "Built-in", shell.srs.join());
  check("the chip reads 'no keyboard' with no MIDI device", shell.chip === "no keyboard", shell.chip);
  check("the sidebar: Play, Review, 3 chord decks, 5 progressions, + Add song, the songs A–Z", shell.menu.join() ===
    "play,review,deck:triads,deck:sevenths,deck:advanced,deck:two-five-one,deck:minor-two-five-one,deck:turnaround,"
    + "deck:tritone-sub,deck:backdoor,add,song:i-got-rhythm,song:jazz-blues-in-f",
    shell.menu.join(" "));
  check("fits 1470×760 with no page scroll", shell.scroll[0] <= shell.scroll[2] && shell.scroll[1] <= shell.scroll[3], shell.scroll.join(" / "));
  await shot("1-practice");

  // 1b. Play: the landing pane names what you hold
  const landing = await cdp.eval(`({ lit: document.querySelector('.pr-item.on')?.dataset.key,
    hint: document.querySelector('.pl-hint')?.textContent })`);
  await cdp.eval(`[48, 64, 67, 71].forEach((n) => window.__musicStatic.noteOn(n, 90)); true`);
  await cdp.waitFor(`document.querySelector('.pl-name')?.textContent === 'Cmaj7'`, 5000, "the held chord's name");
  const held = await cdp.eval(`({ name: document.querySelector('.pl-name').textContent,
    notes: document.querySelector('.pl-notes').textContent, hint: !document.querySelector('.pl-hint').hidden })`);
  await shot("1b-play");
  await cdp.eval(`[48, 64, 67, 71].forEach((n) => window.__musicStatic.noteOff(n)); true`);
  check("the page opens on Play, and a held chord is named", landing.lit === "play" && /Musical typing/.test(landing.hint || "")
    && held.name === "Cmaj7" && /C3 · E4 · G4 · B4/.test(held.notes) && held.hint === false,
    `${landing.lit}; ${held.name} — ${held.notes}`);

  // 2. a chord deck
  await cdp.eval(`__smoke.item('deck:triads')`);
  await cdp.waitFor(`document.getElementById('start') && !document.getElementById('start').disabled`);
  await cdp.eval(`__smoke.button('Start')`);
  await cdp.waitFor(`!document.getElementById('chord').classList.contains('idle')`, 5000, "the first prompt");
  const asked = await cdp.eval(`document.getElementById('chord').dataset.raw`);
  await cdp.eval(`document.getElementById('keys').click()`);                // Show keys
  await sleep(120);
  // A triad's hint: the bass in octave 3, the other two tones above middle C — 3 keys.
  const lit = await cdp.eval(`[...document.querySelectorAll('#piano rect')]
    .filter((r) => ['#f0d48c', '#8d6c22'].includes(r.getAttribute('fill'))).length`);
  check("Show keys lights the chord on the piano", lit === 3, `${lit} keys lit`);
  await cdp.eval(`document.getElementById('keys').click()`);                // off again (remembered)
  const played = await cdp.eval(`__smoke.play()`);
  await cdp.waitFor(`/speed/.test(document.getElementById('grade').textContent)`, 5000, "the grade");
  const deck = await cdp.eval(`({ grade: document.getElementById('grade').textContent,
    bar: document.getElementById('progress').style.width })`);
  // The pass's verdict clears the moment the next card arrives; its grade stays, and the
  // thin progress bar moves one card of 24.
  check("Triads: the prompted chord passes with a grade", played === asked && /clean/.test(deck.grade)
    && deck.bar === "4.2%",
    `asked ${asked}, played it · ${deck.grade.replace(/\s+/g, " ").trim()} · progress bar ${deck.bar}`);
  await shot("2-triads-pass");
  await cdp.eval(`__smoke.button('Stop')`);

  // 3. the Songs group folds and opens; a song, played through
  const folded = await cdp.eval(`(() => { const f = document.querySelector('[data-key="songs-group"]'); f.click();
    const n = document.querySelectorAll('.pr-item[data-key^="song:"]').length; f.click();
    return [n, document.querySelectorAll('.pr-item[data-key^="song:"]').length]; })()`);
  check("the Songs group folds and opens again", folded[0] === 0 && folded[1] === 2, `${folded[0]} songs folded, ${folded[1]} open`);
  await cdp.eval(`__smoke.item('song:i-got-rhythm')`);
  await cdp.waitFor(`!!document.querySelector('.sg-song:not([hidden]) .sg-title')`);
  await cdp.eval(`__smoke.button('Play through')`);
  await cdp.eval(`__smoke.button('Start')`);
  await cdp.waitFor(`document.querySelector('.sg-big') && !document.querySelector('.sg-big').classList.contains('idle')`, 5000, "the play-through");
  const chords = [];
  for (let i = 0; i < 4; i++) chords.push(await cdp.eval(`__smoke.play()`));
  await sleep(150);
  const song = await cdp.eval(`({ big: document.querySelector('.sg-big').textContent, bar: document.querySelector('.sg-progress').style.width,
    sub: document.querySelector('.sg-sub').textContent, steps: document.querySelector('.sg-steps').textContent,
    lit: document.querySelector('.pr-item.on')?.dataset.key,
    check: [...document.querySelectorAll('button')].some((b) => b.textContent === 'Check page' && b.offsetParent !== null) })`);
  check("I Got Rhythm: four chords played in order", chords.join(" ") === "Bbmaj7 G-7 C-7 F7" && parseFloat(song.bar) > 0,
    `${chords.join(" → ")}; now ${song.big} (${song.sub}; progress bar ${song.bar})`);
  check("the open song is lit in the sidebar", song.lit === "song:i-got-rhythm", song.lit);
  check("the song pane offers no Check page and starts at Add to review", !song.check && !/Check the page/.test(song.steps), song.steps.trim());
  await shot("3-play-through");
  await cdp.eval(`__smoke.button('Stop')`);
  await sleep(200);

  // 4. add to review
  const before = await cdp.eval(`__smoke.due('review')`);
  await cdp.eval(`document.querySelector('.sg-stp[data-step="review"]').click()`);   // the stepper's step ①
  await cdp.waitFor(`/Added to review/.test(document.querySelector('.sg-status')?.textContent || '')`, 5000, "the seed status");
  await cdp.waitFor(`__smoke.due('song:i-got-rhythm') > 0`, 5000, "the song's due badge");
  await sleep(300);
  const after = await cdp.eval(`({ review: __smoke.due('review'), song: __smoke.due('song:i-got-rhythm'),
    lit: document.querySelector('.pr-item.on')?.dataset.key, status: document.querySelector('.sg-status')?.textContent })`);
  check("Add to review fills the built-in scheduler", after.song === 5 && after.review === before + 5,
    `${after.status}; Review ${before} → ${after.review}`);
  check("the song stays lit, now with its cards due", after.lit === "song:i-got-rhythm" && after.song === 5, `${after.lit} · ${after.song} due`);
  await shot("4-added");

  // 5. review, then reload
  await cdp.eval(`__smoke.item('review')`);
  await cdp.waitFor(`/due/.test(document.getElementById('chord')?.textContent || '')`);
  const idle = await cdp.eval(`document.getElementById('chord').textContent`);
  check("Review shows the due cards", /^5 cards due/.test(idle), idle);
  await shot("5-review");
  await load();
  const persisted = await cdp.eval(`({ review: __smoke.due('review'), song: __smoke.due('song:i-got-rhythm'), chord: document.getElementById('chord')?.textContent })`);
  check("a reload keeps the review cards (localStorage)", persisted.review === 5 && persisted.song === 5, `Review ${persisted.review} after reload; ${persisted.chord}`);
  await shot("6-reloaded");

  // 6. the S-1 twin's knobs
  const gearHidden = await cdp.eval(`document.getElementById('twin-btn').hidden`);
  await cdp.eval(`(() => { const s = document.getElementById('sound-sel'); s.value = 'twin'; s.dispatchEvent(new Event('change')); return true; })()`);
  await cdp.waitFor(`!document.getElementById('twin-btn').hidden`, 5000, "the ⚙ button");
  await cdp.eval(`document.getElementById('twin-btn').click()`);
  await cdp.waitFor(`document.querySelectorAll('.ts-panel .ts-row').length > 0`, 5000, "the twin's knobs");
  const panel = await cdp.eval(`({ rows: document.querySelectorAll('.ts-panel .ts-row').length,
    controller: [...document.querySelectorAll('.ts-panel .ts-row')].some((r) => /Polyphony/.test(r.textContent)),
    scroll: document.documentElement.scrollHeight <= innerHeight })`);
  check("⚙ shows only for the S-1 twin and opens its knobs", gearHidden === true && panel.rows >= 20 && !panel.controller && panel.scroll,
    `${panel.rows} controls, no Polyphony, no page scroll`);
  await shot("7-twin-knobs");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(200);
  check("Esc closes the knobs", await cdp.eval(`(() => { const p = document.querySelector('.ts-panel'); return !p || p.hidden || !p.offsetParent; })()`));

  // The server root's /favicon.ico is not the page's (Pages serves the page under /<repo>/).
  const errors = cdp.errors.filter((e) => !/requestMIDIAccess|MIDI/i.test(e) && !/\/favicon\.ico/.test(e));
  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  cdp.sock.close();
}

main().then(() => {
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed; screenshots in ${path.join(WORK, "shots")}`);
  killOwned();
  if (!KEEP && outArg < 0 && failed.length === 0) fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}, (e) => {
  console.error("smoke failed:", e.message);
  killOwned();
  process.exit(1);
});
