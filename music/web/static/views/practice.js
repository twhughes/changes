// Practice view (CONTRACTS.md §11): one tab for everything Tyler plays and drills.
//
// Left, a sidebar: Play first (just play: no cards, no drill), then a tree from
// GET /api/practice: Review (every due card), the built-in decks in their groups, then
// Songs — a group that folds (▾/▸, open by default, remembered per browser) with
// "+ Add song" and every song A–Z. Every element earns its place: the only numbers are
// cards due. Right, the chosen thing, mounted from its own view module with an options
// object — views/play.js for Play, views/trainer.js for Review and the decks,
// views/songs.js for a song or the add page — after the previous pane is unmounted.
// With nothing remembered (a first visit, blocked storage) the tab lands on Play.
//
// A drill is global (one trainer engine), so the pane follows it: on mount an
// active drill selects its owner (song:<id>:… → that song, review… → Review, else
// that deck), and so does a drill that starts somewhere else (the Lessons
// hand-off). Picking another item while a drill is live stops that drill first: a
// hidden card must not keep grading the hands.

import * as play from "./play.js";
import * as trainer from "./trainer.js";
import * as songs from "./songs.js";

export const id = "practice";
export const title = "Practice";

const LAST_KEY = "music.practice.last";
const SONGS_OPEN_KEY = "music.practice.songsOpen";   // "0" = the Songs group is folded

const CSS = `
main.pr-host { max-width: 1440px; padding: 10px 14px 12px; }
.pr { display: grid; grid-template-columns: 232px minmax(0, 1fr); gap: 16px;
  height: calc(100vh - 74px); min-height: 460px; }
.pr [hidden] { display: none !important; }
.pr-side { min-height: 0; overflow-y: auto; padding: 2px 10px 14px 0; border-right: 1px solid var(--line); }
.pr-group { margin: 12px 8px 3px; font-size: 11px; font-weight: 600; letter-spacing: .08em;
  text-transform: uppercase; color: var(--dim); }
.pr-item { display: flex; align-items: center; gap: 8px; width: 100%; margin: 1px 0; padding: 6px 8px;
  border: 0; border-radius: 7px; background: none; color: var(--ink); font: inherit; font-size: 14px;
  text-align: left; cursor: pointer; }
.pr-item:hover { background: #1c1c21; }
.pr-item.on { background: #232a3a; box-shadow: inset 0 0 0 1px rgba(122,162,247,.35); }
.pr-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pr-item-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-play .pr-item-title, .pr-review .pr-item-title { font-weight: 600; }
.pr-fold { display: flex; align-items: center; gap: 6px; width: calc(100% - 8px); margin: 12px 4px 3px;
  padding: 3px 4px; border: 0; border-radius: 6px; background: none; font-family: inherit; text-align: left;
  cursor: pointer; }
.pr-fold:hover { color: var(--ink); background: #1c1c21; }
.pr-fold.on { color: var(--ink); background: #232a3a; box-shadow: inset 0 0 0 1px rgba(122,162,247,.35); }
.pr-chev { width: 12px; font-size: 14px; line-height: 1; letter-spacing: 0; text-align: center; }
.pr-indent { padding-left: 22px; }
.pr-additem .pr-item-title { color: var(--accent); font-size: 13px; }
.pr-due { flex: none; min-width: 20px; padding: 1px 7px; border-radius: 999px; text-align: center;
  background: rgba(122,162,247,.18); color: var(--accent); font-size: 11px; font-weight: 700;
  font-variant-numeric: tabular-nums; }
.pr-pane { min-width: 0; min-height: 0; overflow: auto; }
.pr-slot { height: 100%; }
.pr-pane .piano-wrap svg.piano { max-width: 820px; margin: 0 auto; }
.pr-note { padding: 6px 8px; font-size: 12px; color: var(--dim); }
.pr-note.err { color: var(--bad); }
`;

function inject() {
  if (document.getElementById("practice-css")) return;
  const style = document.createElement("style");
  style.id = "practice-css";
  style.textContent = CSS;
  document.head.append(style);
}

/** h("div", {class, text, onclick, title, "data-x": 1}, ...children). */
function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") || k === "title" || k === "hidden") node[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid !== null && kid !== undefined && kid !== false && kid !== "") node.append(kid);
  }
  return node;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Which sidebar item owns a running deck: a song, Review, or the deck itself. */
export function ownerOf(deck) {
  const d = String(deck || "");
  if (!d) return null;
  const m = /^song:([^:]+)(:|$)/.exec(d);
  if (m) return `song:${m[1]}`;
  if (/^(review|anki)(:|-|$)/.test(d)) return "review";
  return `deck:${d}`;
}

function remember(key) {
  try { localStorage.setItem(LAST_KEY, key); } catch { /* private mode */ }
}

function recall() {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

/** The Songs group opens by default; a folded one stays folded in this browser. */
function readSongsOpen() {
  try { return localStorage.getItem(SONGS_OPEN_KEY) !== "0"; } catch { return true; }
}

async function getJSON(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export function mount(el, ctx) {
  inject();
  el.classList.add("pr-host");
  let alive = true;
  let menu = null;               // GET /api/practice
  let menuFailed = false;
  let selected = null;           // "play" · "review" · "deck:<id>" · "song:<id>" · "add"
  let songsOpen = readSongsOpen();
  let paneOff = null;
  let live = { active: false, owner: null };    // the trainer's one drill, as far as we know
  let refreshTimer = 0;

  const sideEl = h("nav", { class: "pr-side", "aria-label": "practice menu" });
  const paneEl = h("section", { class: "pr-pane" });
  const root = h("div", { class: "pr" }, sideEl, paneEl);
  el.replaceChildren(root);

  // The tab owns the viewport under the shell header: the sidebar and the song
  // chart scroll inside themselves, the page never does (13" screen).
  function fit() {
    const H = window.innerHeight;
    if (!H || typeof root.getBoundingClientRect !== "function") return;
    const top = root.getBoundingClientRect().top + (window.scrollY || 0);
    if (!(top > 0)) return;
    root.style.height = `${Math.max(460, Math.floor(H - top - 14))}px`;
  }

  // ── the menu ────────────────────────────────────────────────────────────
  const deckInfo = (deckId) => {
    for (const g of (menu && menu.groups) || []) {
      const d = (g.decks || []).find((x) => x.id === deckId);
      if (d) return d;
    }
    return null;
  };
  const songInfo = (songId) => ((menu && menu.songs) || []).find((s) => s.id === songId) || null;
  /** Every song, A–Z by title, whatever case it is written in. */
  const allSongs = () => ((menu && menu.songs) || []).slice()
    .sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id), undefined, { sensitivity: "base" }));

  function setSongsOpen(open) {
    songsOpen = !!open;
    try { localStorage.setItem(SONGS_OPEN_KEY, songsOpen ? "1" : "0"); } catch { /* no storage: this visit only */ }
  }

  function valid(key) {
    if (!key) return false;
    if (key === "play" || key === "review" || key === "add") return true;
    if (!menu) return true;                       // no menu: trust the last choice
    if (key.startsWith("deck:")) return !!deckInfo(key.slice(5));
    if (key.startsWith("song:")) return !!songInfo(key.slice(5));
    return false;
  }

  function item(key, titleText, due, extra = {}) {
    const on = key === (extra.lit || selected);
    return h("button", { class: `pr-item${extra.cls ? ` ${extra.cls}` : ""}${on ? " on" : ""}`,
      "data-key": key, title: extra.tip || undefined, onclick: () => select(key, { user: true }) },
    h("span", { class: "pr-item-main" }, h("span", { class: "pr-item-title", text: titleText })),
    due > 0 ? h("span", { class: "pr-due", text: String(due), title: `${plural(due, "card")} due` }) : null);
  }

  function renderSide() {
    // Play needs no menu: it is there while the menu loads, and when the menu fails.
    const parts = [item("play", "Play", 0, { cls: "pr-play", tip: "just play: the chord you hold, named" })];
    if (!menu) {
      parts.push(h("div", { class: `pr-note${menuFailed ? " err" : ""}`,
        text: menuFailed ? "The practice menu is not answering." : "Loading…" }));
    } else {
      const rv = menu.review || {};
      parts.push(item("review", "Review", Number(rv.due) || 0,
        { cls: "pr-review", tip: "every due card, from every deck and song" }));
      for (const g of menu.groups || []) {
        if (!(g.decks || []).length) continue;
        parts.push(h("div", { class: "pr-group", text: g.title || g.id }));
        for (const d of g.decks) {
          parts.push(item(`deck:${d.id}`, d.title || d.id, d.in_review ? Number(d.due) || 0 : 0,
            { tip: d.blurb || undefined }));
        }
      }
      // Songs: a group like the others, except it folds (100 songs would crowd the rest).
      // Folded over the open song (or the add page), the header lights in its place.
      const inside = selected === "add" || String(selected || "").startsWith("song:");
      parts.push(h("button", { class: `pr-group pr-fold${!songsOpen && inside ? " on" : ""}`,
        "data-key": "songs-group", "aria-expanded": songsOpen ? "true" : "false",
        onclick: () => { setSongsOpen(!songsOpen); renderSide(); } },
      h("span", { class: "pr-chev", "aria-hidden": "true", text: songsOpen ? "▾" : "▸" }), "Songs"));
      if (songsOpen) {
        // + Add song first: under 100 songs it would be a long scroll away.
        parts.push(item("add", "+ Add song", 0, { cls: "pr-indent pr-additem",
          tip: "drop, paste or pick a Real Book page" }));
        for (const s of allSongs()) {
          parts.push(item(`song:${s.id}`, s.title || s.id, Number(s.due) || 0, { cls: "pr-indent" }));
        }
      }
    }
    sideEl.replaceChildren(...parts);
  }

  async function loadMenu() {
    const m = await getJSON("/api/practice");
    if (!alive) return;
    if (m && typeof m === "object") {
      menu = m;
      menuFailed = false;
    } else if (!menu) {
      menuFailed = true;
    }
    renderSide();
  }

  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (alive) loadMenu(); }, 250);
  }

  // ── the pane ────────────────────────────────────────────────────────────

  function mountPane(key, extra = {}) {
    if (paneOff) {
      try { paneOff(); } catch { /* a pane that fails to unmount must not wedge the tab */ }
      paneOff = null;
    }
    const slot = h("div", { class: "pr-slot" });
    paneEl.replaceChildren(slot);
    const onNavigate = (nav) => followPane(nav);
    const onChange = () => refreshSoon();
    if (key === "play") {
      paneOff = play.mount(slot, ctx, {});
    } else if (key === "review") {
      const rv = (menu && menu.review) || {};
      const due = Number(rv.due) || 0;
      paneOff = trainer.mount(slot, ctx, {
        embedded: true, deck: "review", title: "Review", onChange,
        idle: rv.available === false ? `${rv.label || "Anki"} is closed — open it, or pick Built-in in 🧠`
          : due ? `${plural(due, "card")} due — press Start` : "Nothing due right now",
      });
    } else if (key.startsWith("deck:")) {
      const deckId = key.slice(5);
      const d = deckInfo(deckId);
      paneOff = trainer.mount(slot, ctx, {
        embedded: true, deck: deckId, title: (d && d.title) || deckId, blurb: (d && d.blurb) || "",
        idle: "Press Start", seedable: !d || d.seedable !== false, inReview: !!(d && d.in_review), onChange,
      });
    } else if (key.startsWith("song:")) {
      paneOff = songs.mount(slot, ctx, { embedded: true, song: key.slice(5), onNavigate, onChange, ...extra });
    } else {
      paneOff = songs.mount(slot, ctx, { embedded: true, screen: "add", onNavigate, onChange, ...extra });
    }
  }

  function select(key, { user = false, extra } = {}) {
    if (!key || !alive) return;
    if (key === selected && !extra) return;
    // One drill at a time: walking away from a live one ends it.
    if (user && live.active && live.owner !== key) {
      ctx.send({ type: "stop" });
      live = { active: false, owner: null };
    }
    // A song the program picks (the remembered one, a running drill's) must be visible.
    if (!user && key.startsWith("song:")) setSongsOpen(true);
    selected = key;
    remember(key);
    renderSide();
    mountPane(key, extra);
  }

  /** The songs pane moved itself (Check it → after an import, a delete): follow it. */
  function followPane({ song } = {}) {
    const key = song ? `song:${song}` : "add";          // no song left on screen: the add page
    if (song) setSongsOpen(true);
    if (key === selected) { renderSide(); return; }
    selected = key;
    remember(key);
    renderSide();
  }

  /** A drill is running: make sure its owner is the pane on screen. */
  function follow(drill) {
    if (!drill || !drill.active) {
      live = { active: false, owner: null };
      return;
    }
    const owner = ownerOf(drill.deck);
    live = { active: true, owner };
    if (owner && owner !== selected) select(owner);
  }

  // ── drops on a pane that isn't a song: route them to + Add song ─────────
  const songPane = () => selected === "add" || String(selected || "").startsWith("song:");
  const carriesPage = (dt) => {
    const types = dt && dt.types ? [...dt.types] : [];
    return ["Files", "text/uri-list", "application/x-hq-media"].some((t) => types.includes(t));
  };
  function onDragOver(ev) {
    if (songPane() || !carriesPage(ev.dataTransfer)) return;
    ev.preventDefault();                 // or the browser replaces the cockpit with the file
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  }
  function onDrop(ev) {
    if (songPane() || !ev.dataTransfer) return;
    const payload = songs.dropPayload(ev.dataTransfer);    // read before anything async
    if (!payload.files.length && !payload.url) return;
    ev.preventDefault();
    select("add", { user: true, extra: { importNow: payload } });
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  const offs = [
    ctx.on("prompt", (m) => {
      if (!live.active) live = { active: true, owner: live.owner };
      // A new drill (its first card): find its owner — by deck name, never by the
      // card's ref (a Review session drills song phrases too).
      if (Number(m.idx) === 0) {
        getJSON("/api/trainer/status").then((st) => { if (alive && st) follow(st.drill); });
      }
    }),
    ctx.on("done", () => {
      live = { active: false, owner: null };
      refreshSoon();
    }),
    ctx.on("passed", () => refreshSoon()),
    ctx.on("srs", () => refreshSoon()),
    ctx.on("songs", (m) => { if (m.event === "changed" || m.event === "receipt") refreshSoon(); }),
    ctx.on("hello", (m) => follow(m.status && m.status.drill)),
  ];
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  window.addEventListener("resize", fit);

  renderSide();
  fit();
  Promise.all([loadMenu(), getJSON("/api/trainer/status")]).then(([, st]) => {
    if (!alive) return;
    const drill = st && st.drill;
    if (drill && drill.active && ownerOf(drill.deck)) {
      follow(drill);
      if (!selected) select(ownerOf(drill.deck));
      return;
    }
    const last = recall();
    select(valid(last) ? last : "play");      // nothing remembered: just play
  });

  return () => {
    alive = false;
    clearTimeout(refreshTimer);
    offs.forEach((off) => off());
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
    window.removeEventListener("resize", fit);
    if (paneOff) {
      try { paneOff(); } catch { /* already gone */ }
      paneOff = null;
    }
    el.classList.remove("pr-host");
  };
}
