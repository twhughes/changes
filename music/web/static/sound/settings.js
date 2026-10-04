// settings.js — the S-1 twin's settings. A ⚙ beside the 🔈 menu, shown only while the S-1 twin is the
// chosen sound, opens a panel of the twin's sound-shaping controls, grouped like the S-1's front panel.
//
//   mountTwinSettings(sound /* mountSound(ctx), ./index.js */, button /* #twin-btn */)
//     -> { open(), close(), isOpen() }
//
// The controls come from the vendored schema (./twin/schema.json): the LFO, OSC, FILTER, AMP, ENV and EFX
// sections, in that (front-panel) order. Each section shows its front-panel knobs and switches, the shift
// functions that shape the sound (SHIFT_KEEP) and, in EFX, the chorus from the S-1's menu. CONTROLLER
// (polyphony, glide, chord voices), MIDI and the system settings stay off, so the driver keeps Poly. A
// control the browser twin cannot play (supportOf: OSC DRAW, CHOP, noise mode, ...) stays off too.
// A continuous control is a slider with its value (0..127, the S-1's CC). A discrete one is a row of
// buttons when its labels are short, else a menu. Each tooltip is the schema's description.
//
// A change plays at once (the driver's optional set(cc, value), ./index.js) and stays in this browser on
// top of the driver's PATCH (twin.js saveChanges), so every twin created later starts with it: after a
// reload too, and on the static page. Reset returns to PATCH. ✕, Esc or the ⚙ closes the panel. After
// each change, a slider or menu gives the keys back to musical typing.
//
// "Open in S-1 twin ↗" (Tyler: "is there any way to use my new S-1 twin page to sync the sound to the
// music page?") opens the S-1 twin's own page — the synth app on this Mac when it answers on :8766,
// else the published one — in a window of its own with "#sync=music". That page (hq/synth
// core/opener-sync.js) sends its whole sound, then every knob it turns; here each one plays and is
// saved like a change made on this panel. Only the window opened here, from tylerwhughes.com or this
// Mac, is listened to, and only the sound sections (never CONTROLLER: Poly stays). Closing that
// window stops it; the sound stays as it was left.

import { loadDriver } from "./index.js";

/** The S-1's sound sections, in front-panel order. CONTROLLER (Poly, glide, chord voices) stays off. */
const SECTIONS = ["LFO", "OSC", "FILTER", "AMP", "ENV", "EFX"];
/** The shift functions that change the sound: Pulse Width, Key Follow, Env Mode, Reverb Time, Delay Time. */
const SHIFT_KEEP = new Set([15, 26, 28, 89, 90]);
/** From the S-1's menu: Chorus. */
const MENU_KEEP = new Set([93]);
/** A discrete control whose labels fit in this many characters is a row of buttons; a longer one, a menu. */
const SEGMENT_CHARS = 24;

/**
 * The panel's controls, [{name, params}] by section in front-panel order (each section's own order, the
 * menu's chorus last). `audible(cc)` says whether the browser twin plays a control (twin/audio.js supportOf).
 */
export function pickControls(schema, audible) {
  const menu = (schema.menu || []).filter((p) => MENU_KEEP.has(p.cc));
  const shown = (p) => (p.access === "panel" || SHIFT_KEEP.has(p.cc) || MENU_KEEP.has(p.cc)) && audible(p.cc);
  return SECTIONS
    .map((name) => (schema.sections || []).find((s) => s.name === name))
    .filter(Boolean)
    .map((s) => ({ name: s.name, params: [...s.params, ...menu.filter((p) => p.section === s.name)].filter(shown) }))
    .filter((s) => s.params.length > 0);
}

let assets = null;   // {twin, defaults, sections}: loaded on the first open, once per page
function loadAssets() {
  if (assets) return assets;
  assets = (async () => {
    const [twin, audio, schema] = await Promise.all([
      loadDriver("twin"),                    // the driver's own module: PATCH and the saved changes
      import("./twin/audio.js"),
      fetch(new URL("./twin/schema.json", import.meta.url)).then((r) => {
        if (!r.ok) throw new Error(`schema.json: HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    const curves = await audio.loadCurves("bundled");
    const defaults = new Map();
    for (const p of [...(schema.sections || []).flatMap((s) => s.params), ...(schema.menu || [])]) {
      defaults.set(p.cc, p.default);
    }
    // What the S-1 twin page may change here: every control of the sound sections (and the menu's
    // ones that sit in them), shown on this panel or not — so the twin sounds like that page.
    const syncable = new Set([
      ...(schema.sections || []).filter((s) => SECTIONS.includes(s.name)).flatMap((s) => s.params.map((p) => p.cc)),
      ...(schema.menu || []).filter((p) => SECTIONS.includes(p.section)).map((p) => p.cc),
    ]);
    return { twin, defaults, syncable,
      sections: pickControls(schema, (cc) => audio.supportOf(cc, curves) !== null) };
  })();
  assets.catch(() => { assets = null; });   // a failed load tries again on the next open
  return assets;
}

export function mountTwinSettings(sound, button) {
  if (!button || !sound || typeof sound.onChange !== "function") return null;
  addCss();
  let panel = null, body = null, resetBtn = null, followBtn = null;
  let opened = false, model = null, values = {};
  const rows = new Map();                     // cc -> paint(value, changed)

  /** The live driver, when it has settings (an E-piano, a silent twin or a loading one has none). */
  const live = () => {
    const d = sound.driver();
    return d && typeof d.set === "function" && typeof d.values === "function" ? d : null;
  };
  const base = (cc) => (cc in model.twin.PATCH ? model.twin.PATCH[cc] : model.defaults.get(cc));
  function changes() {
    const out = {};
    for (const [cc, v] of Object.entries(values)) {
      const b = base(Number(cc));
      if (b !== undefined && v !== b) out[cc] = v;
    }
    return out;
  }

  function paint() {
    const changed = changes();
    for (const [cc, show] of rows) show(cc in values ? values[cc] : base(cc), cc in changed);
    resetBtn.disabled = Object.keys(changed).length === 0;
  }
  /** What the twin plays now: the live driver's values, else PATCH and the saved changes. */
  function load() {
    const d = live();
    values = d ? d.values() : { ...model.twin.PATCH, ...model.twin.savedChanges() };
  }
  /** Show what the twin plays now. */
  function refresh() {
    if (!model) return;
    load();
    paint();
  }
  async function ensureModel() {
    if (model) return true;
    try { model = await loadAssets(); return true; } catch { return false; }
  }
  function apply(cc, v) {
    values[cc] = v;
    const d = live();
    if (d) d.set(cc, v);
    model.twin.saveChanges(changes());
    paint();
  }
  function reset() {
    const d = live();
    for (const cc of Object.keys(changes()).map(Number)) {
      values[cc] = base(cc);
      if (d) d.set(cc, values[cc]);
    }
    model.twin.saveChanges({});
    paint();
  }

  function control(section, p) {
    const label = `${section} ${p.name}`;
    const row = el("div", { class: "ts-row", title: p.description || "", "data-cc": p.cc },
      el("span", { class: "ts-name", text: p.name }));
    const labels = Object.entries(p.labels || {});
    let show;
    if (p.type === "continuous" || labels.length === 0) {
      const input = el("input", { type: "range", min: p.min, max: p.max, step: 1, "aria-label": label });
      const val = el("span", { class: "ts-val" });
      input.oninput = () => apply(p.cc, Number(input.value));
      input.onchange = () => input.blur();          // the keys go back to musical typing
      row.append(input, val);
      show = (v) => {
        if (input.value !== String(v)) input.value = String(v);
        val.textContent = String(v);
      };
    } else if (labels.reduce((n, [, t]) => n + String(t).length, 0) <= SEGMENT_CHARS) {
      const choices = labels.map(([v, t]) => {
        const b = el("button", { type: "button", text: t, "data-value": v });
        b.onclick = () => { apply(p.cc, Number(v)); b.blur(); };
        return b;
      });
      row.append(el("span", { class: "ts-seg", role: "group", "aria-label": label }, ...choices));
      show = (v) => {
        for (const b of choices) {
          const on = Number(b.getAttribute("data-value")) === v;
          b.classList.toggle("on", on);
          b.setAttribute("aria-pressed", String(on));
        }
      };
    } else {
      const menu = el("select", { "aria-label": label },
        ...labels.map(([v, t]) => el("option", { value: v, text: t })));
      menu.onchange = () => { apply(p.cc, Number(menu.value)); menu.blur(); };
      row.append(menu);
      show = (v) => { menu.value = String(v); };
    }
    rows.set(p.cc, (v, changed) => { show(v); row.classList.toggle("changed", changed); });
    return row;
  }

  function build() {
    // The whole S-1 twin, followed live (Tyler: "why doesnt s1 twin link to the tylerwhughes.com/s1-twin
    // page?", then "is there any way … to sync the sound to the music page?").
    followBtn = el("button", { type: "button", class: "ts-follow" });
    followBtn.onclick = () => { openTwin(); followBtn.blur(); };
    showFollow();
    resetBtn = el("button", { type: "button", text: "Reset", disabled: true,
      title: "back to the cockpit's soft keys patch" });
    resetBtn.onclick = () => { reset(); resetBtn.blur(); };
    const closeBtn = el("button", { type: "button", class: "ts-close", text: "✕", title: "close (Esc)" });
    closeBtn.onclick = () => close();
    body = el("div", { class: "ts-body" });
    panel = el("div", { class: "ts-panel", role: "dialog", "aria-label": "S-1 twin settings", hidden: true },
      el("div", { class: "ts-head" },
        el("span", { class: "ts-title", text: "S-1 twin",
          title: "Each change plays at once and stays in this browser." }),
        followBtn, resetBtn, closeBtn),
      body);
    document.body.append(panel);
  }
  function fill() {
    rows.clear();
    body.replaceChildren(...model.sections.map((s) =>
      el("section", { class: "ts-sec" }, el("h4", { text: s.name }), ...s.params.map((p) => control(s.name, p)))));
  }

  const onKey = (ev) => {
    if (ev.key !== "Escape" || ev.defaultPrevented) return;   // a field's own Esc goes first
    ev.preventDefault();
    close();
  };
  async function open() {
    if (opened) return;
    opened = true;
    if (!panel) build();
    panel.hidden = false;
    button.classList.add("on");
    button.setAttribute("aria-expanded", "true");
    window.addEventListener("keydown", onKey);
    if (!rows.size) {
      try {
        if (!model) model = await loadAssets();
        if (!rows.size) fill();
      } catch (e) {
        body.replaceChildren(el("p", { class: "ts-error",
          text: `The S-1 settings did not load (${(e && e.message) || e}). Close and open them to try again.` }));
        return;
      }
    }
    if (opened) refresh();
  }
  function close() {
    if (!opened) return;
    opened = false;
    panel.hidden = true;
    button.classList.remove("on");
    button.setAttribute("aria-expanded", "false");
    window.removeEventListener("keydown", onKey);
  }

  // ── follow the S-1 twin page ────────────────────────────────────────────────
  let twinWin = null, following = false, watch = 0, followNote = "";
  function showFollow() {
    if (!followBtn) return;
    followBtn.textContent = following ? "● Following the S-1 twin" : "Open in S-1 twin ↗";
    followBtn.classList.toggle("on", following);
    followBtn.title = followNote || (following
      ? "knobs you turn on the S-1 twin page play here — close that page to stop"
      : "open the S-1 twin: shape the sound there, and it plays here");
  }
  /** The synth app on this Mac when it answers, else the published S-1 twin. */
  async function twinPage() {
    if (/^(localhost|127\.0\.0\.1)$/.test(String(globalThis.location?.hostname))) {
      try { await fetch(LOCAL_TWIN_URL, { mode: "no-cors", cache: "no-store" }); return LOCAL_TWIN_URL; }
      catch { /* the synth app is not running */ }
    }
    return FULL_TWIN_URL;
  }
  function stopFollowing() {
    clearInterval(watch);
    twinWin = null;
    following = false;
    showFollow();
  }
  function openTwin() {
    if (twinWin && !twinWin.closed) { twinWin.focus(); return; }
    twinWin = window.open("", "s1-twin");        // here, in the click: a pop-up blocker allows it
    if (!twinWin) {
      followNote = "the browser blocked the window — allow pop-ups for this page";
      showFollow();
      return;
    }
    followNote = "";
    following = false;
    showFollow();
    twinPage().then((url) => {
      try { twinWin.location.href = `${url}#sync=music`; } catch { /* closed meanwhile */ }
    });
    clearInterval(watch);
    watch = setInterval(() => { if (!twinWin || twinWin.closed) stopFollowing(); }, 1000);
  }
  /** Knob values from the S-1 twin page: play each, save it like a change made here. */
  function take(entries) {
    if (!Object.keys(values).length) load();
    const d = live();
    let n = 0;
    for (const [k, v] of entries) {
      const cc = Number(k), val = Number(v);
      if (!model.syncable.has(cc) || !Number.isInteger(val) || val < 0 || val > 127 || values[cc] === val) continue;
      values[cc] = val;
      if (d) d.set(cc, val);
      n += 1;
    }
    if (n) {
      model.twin.saveChanges(changes());
      if (opened) paint();
    }
  }
  window.addEventListener("message", async (ev) => {
    if (!twinWin || ev.source !== twinWin || !TWIN_PEER.test(String(ev.origin))) return;
    const m = ev.data;
    if (!m || m.v !== 1 || (m.type !== "s1-twin:values" && m.type !== "s1-twin:param")) return;
    const entries = m.type === "s1-twin:values" ? Object.entries(m.values || {}) : [[m.cc, m.value]];
    if (!(await ensureModel())) return;
    take(entries);
    if (!following) { following = true; showFollow(); }
  });

  button.onclick = () => {
    if (opened) close(); else open();
    button.blur();                            // hand the keys back to musical typing
  };
  // The ⚙ is there only while the twin is the chosen sound; once its driver is live, show what it plays.
  function sync() {
    const twin = sound.current() === "twin";
    button.hidden = !twin;
    if (!twin) close();
    else if (opened) refresh();
  }
  sound.onChange(sync);
  sync();
  return { open, close, isOpen: () => opened, openTwin, isFollowing: () => following };
}

/** The S-1 twin's own page (hq/synth, published as s1-twin). */
export const FULL_TWIN_URL = "https://tylerwhughes.com/s1-twin/";
/** The synth app on this Mac (hq/synth's cockpit, PORTS.md :8766): the same page, with a real S-1 linked. */
export const LOCAL_TWIN_URL = "http://localhost:8766/";
/** Who may send the S-1 twin's knobs here: the published page, or a page on this Mac. */
export const TWIN_PEER = /^(https:\/\/tylerwhughes\.com|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "role" || k.includes("-")) node.setAttribute(k, String(v));
    else node[k] = v;
  }
  if (kids.length) node.append(...kids);
  return node;
}

function addCss() {
  if (document.getElementById("twin-settings-css")) return;
  const style = document.createElement("style");
  style.id = "twin-settings-css";
  style.textContent = `
.sound #twin-btn { padding: .15rem .35rem; margin: 0 .35rem 0 -.15rem; }
.ts-panel { position: fixed; top: 50px; right: 14px; z-index: 30; width: min(860px, calc(100vw - 28px));
  max-height: calc(100vh - 62px); overflow: auto; overscroll-behavior: contain; padding: 10px 16px 12px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 14px 40px rgba(0, 0, 0, .55); font-size: 13px; }
.ts-panel[hidden] { display: none; }
.ts-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.ts-title { flex: 1; font-weight: 600; color: var(--accent); letter-spacing: .04em; }
.ts-follow.on { color: var(--good); border-color: var(--good); }
.ts-head button, .ts-seg button { background: #111; color: inherit; border: 1px solid #333; border-radius: 4px;
  padding: 2px 8px; font: inherit; cursor: pointer; }
.ts-head button:hover:not(:disabled), .ts-seg button:hover { border-color: #666; }
.ts-head button:disabled { opacity: .4; cursor: default; }
.ts-body { columns: 3 240px; column-gap: 24px; }
.ts-sec { break-inside: avoid; -webkit-column-break-inside: avoid; margin: 0 0 10px; }
.ts-sec h4 { margin: 0 0 4px; font-size: 11px; font-weight: 600; letter-spacing: .12em; color: var(--dim); }
.ts-row { display: grid; grid-template-columns: 80px 1fr 28px; align-items: center; column-gap: 8px; min-height: 25px; }
.ts-name { color: #c9c9d1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ts-row.changed .ts-name { color: var(--accent); }
.ts-row input[type=range] { width: 100%; margin: 0; accent-color: var(--accent); }
.ts-val { text-align: right; color: var(--dim); font-variant-numeric: tabular-nums; }
.ts-seg, .ts-row select { grid-column: 2 / 4; justify-self: start; }
.ts-seg { display: inline-flex; }
.ts-seg button { padding: 1px 5px; margin-left: -1px; border-radius: 0; font-size: 12px; }
.ts-seg button:first-child { margin-left: 0; border-radius: 4px 0 0 4px; }
.ts-seg button:last-child { border-radius: 0 4px 4px 0; }
.ts-seg button.on { position: relative; border-color: var(--accent); color: var(--accent); }
.ts-row select { padding: 2px 6px; font-size: 12.5px; background: #111; border-color: #333; border-radius: 4px; }
.ts-error { margin: 4px 0; color: var(--warn); }
`;
  document.head.append(style);
}
