// Cockpit shell: the views from /api/views, one dynamically imported ES module per
// view (CONTRACTS.md §5), a shared socket handed to each as ctx. One view (Practice)
// means no tab bar: the header keeps the brand, 🔈 sound (⚙ adjusts the S-1 twin),
// 🧠 review, 🎹 musical typing and the keyboard chip. No dialogs: a refused switch
// reverts its menu and says why in the tooltip.
//
// The static page (CONTRACTS.md §12): when index.html carries
// <meta name="music-static" content="1"> (tools/build_site.py adds it), there is no
// server. offline/runtime.js then answers /api/ and stands in for the socket with the
// same {on, send, close} shape, so every view runs unchanged; ctx.static tells the
// few that must say "this needs the local app" instead of offering it.

import { connect } from "./ws.js";
import { mountSound } from "./sound/index.js";
import { mountTwinSettings } from "./sound/settings.js";
import { mountTyping } from "./typing.js";
import { mountSrs } from "./srs.js";

const root = document.getElementById("view-root");
const tabs = document.getElementById("tabs");
const chip = document.getElementById("port-chip");
const STATIC = !!document.querySelector('meta[name="music-static"]');

let ws;
if (STATIC) {
  try {
    ws = await (await import("./offline/runtime.js")).boot();
  } catch (e) {
    console.error("static boot failed:", e);
    root.textContent = "The page could not load its data. Reload to try again.";
    throw e;
  }
} else {
  ws = connect();
}
const ctx = { ws, on: ws.on, send: ws.send, static: STATIC };

function setPort(name) {
  chip.textContent = name || "no keyboard";
  chip.className = "chip " + (name ? "on" : "off");
}

ws.on("hello", (m) => setPort(m.status && m.status.midi_port));

// ── 🔈 sound: what /api/sound offers (the E-piano by default, the S-1 twin, off) ──
const sound = mountSound(ctx);
// ⚙ beside it: the S-1 twin's settings, there only while the twin is the chosen sound
mountTwinSettings(sound, document.getElementById("twin-btn"));
const soundSel = document.getElementById("sound-sel");
const SOUND_TIP = soundSel.title;
async function refreshSound() {
  let st;
  try {
    st = await (await fetch("/api/sound")).json();
  } catch {
    soundSel.disabled = true;
    return;
  }
  soundSel.disabled = false;
  soundSel.replaceChildren(...(st.drivers || []).map((d) => {
    const o = document.createElement("option");
    o.value = d.id;
    // A select is as wide as its longest option: a short label, the reason in the tip.
    o.textContent = d.available ? d.label : `${d.label} (unavailable)`;
    o.title = d.available ? "" : d.note || "";
    o.disabled = !d.available;
    return o;
  }));
  soundSel.value = st.driver;
}
soundSel.onchange = async () => {
  let detail = "";
  try {
    const r = await fetch("/api/sound/driver", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ driver: soundSel.value }) });
    if (!r.ok) detail = ((await r.json().catch(() => ({}))).detail) || "that sound could not start";
  } catch {
    detail = "the music server is not answering";
  }
  await refreshSound();
  soundSel.title = detail || SOUND_TIP;
  soundSel.blur();                         // hand the keys back to musical typing
};
ws.on("sound", (m) => { soundSel.value = m.driver; });
mountTyping(ctx, document.getElementById("typing-btn"));
// 🧠 review backend (CONTRACTS.md §10): Built-in by default, Anki optional.
mountSrs(ctx, document.getElementById("srs-sel"));
refreshSound();
ws.on("midi", (m) => setPort(m.connected ? m.port : null));
ws.on("_close", () => {
  chip.textContent = "disconnected";
  chip.className = "chip off";
});

let unmount = null;

async function show(id, button) {
  for (const b of tabs.children) b.classList.toggle("active", b === button);
  if (unmount) unmount();
  unmount = null;
  root.replaceChildren();
  const mod = await import(`./views/${id}.js`);
  unmount = mod.mount(root, ctx) || null;
}

const views = await (await fetch("/api/views")).json();
tabs.hidden = views.length < 2;            // one view: nothing to switch between
views.forEach((view, i) => {
  const button = document.createElement("button");
  button.textContent = view.title;
  button.onclick = () => show(view.id, button);
  tabs.append(button);
  if (i === 0) show(view.id, button);
});
