// Trainer view: pick a deck, play the prompted chord, watch the verdict land.
//
// Sight-reading decks send a `staff` payload instead of a chord name (see
// trainer/service.py `_on_engine_event`): {clef, pitches, key}. Those items paint
// engraved notes in the same slot the chord name uses, so the eye reads the staff
// and the hands answer — the prompt line underneath is unchanged.
//
// mount(el, ctx, opts) — the Practice tab (views/practice.js) mounts this view
// in its right pane:
//   opts.deck      preselect a deck (embedded: the pane's one deck)
//   opts.embedded  hide the deck picker and show opts.title + opts.blurb instead;
//                  only drill events of a drill this pane started (or resumed)
//                  are drawn — a pane never paints another deck's prompt
//   opts.idle      the card's text before Start
//   opts.seedable  false: a cram-only deck, nothing to add to review
//   opts.inReview  true: its cards are already in review, nothing left to add
//   opts.onChange  () after "Add to review" succeeds (the host's due counts moved)
// With no opts it is the standalone Trainer, unchanged: every drill is drawn.
//
// "Add to review" puts the deck's cards in the active review backend (CONTRACTS.md
// §10: Built-in by default, Anki optional); review sessions are `review` and
// `review:<theme>` (the old `anki-due` / `anki:<theme>` names still work).
//
// "Show keys" (off by default, remembered per browser) lights the card's voicing —
// `prompt.notes`, then `step.notes` for a progression's next chord — on the piano, the
// same hint the song pane gives. A card without one (a phrase in Review, a staff
// card: notes null) hides the switch.

import { makePiano } from "../keyboard.js";
import { staffSVG } from "../staff.js";
import { pretty, prettyWords } from "./songs.js";   // the song pane's ♭/♯ rule, one home

const STAFF_W = 360;
const STAFF_H = 170;
const BACKEND_NAMES = { local: "Built-in", anki: "Anki" };
const isReview = (name) => /^(review|anki)(:|-|$)/.test(String(name || ""));
const KEYS_KEY = "music.trainer.showKeys";
const KEYS_TIP = "light the chord's keys on the piano — a hint; any voicing passes";

export const id = "trainer";
export const title = "Trainer";

export function mount(el, ctx, opts = {}) {
  const embedded = !!opts.embedded;
  const fixedDeck = opts.deck || null;
  el.innerHTML = `
    <div class="t-head" id="t-head" hidden style="margin:0 0 12px">
      <div id="t-title" style="font-size:20px;font-weight:600;letter-spacing:-.01em"></div>
      <div id="t-blurb" class="prompt-line" style="margin-top:3px"></div>
    </div>
    <div class="row">
      <select id="deck"></select>
      <button class="btn primary" id="start">Start</button>
      <button class="btn" id="skip" disabled>Skip</button>
      <button class="btn" id="stop" disabled>Stop</button>
      <label class="t-toggle" id="keys-lbl" title="${KEYS_TIP}"><input type="checkbox" id="keys"> Show keys</label>
      <button class="btn" id="seed" title="add this deck's cards to your review deck">Add to review</button>
    </div>
    <div class="card">
      <div class="chord idle" id="chord">pick a deck and press Start</div>
      <div class="prompt-line" id="prompt"></div>
      <div class="verdict" id="verdict"></div>
      <div class="grade" id="grade"></div>
      <div class="t-progress" id="progress"></div>
    </div>
    <div class="piano-wrap" id="piano"></div>
    <div class="card summary" id="summary" hidden></div>`;

  const $ = (sel) => el.querySelector(sel);
  const deck = $("#deck");
  const seedBtn = $("#seed");
  const chord = $("#chord");
  const prompt = $("#prompt");
  const verdict = $("#verdict");
  const gradeEl = $("#grade");
  const progress = $("#progress");             // a thin bar: how far through the session
  const summary = $("#summary");
  const piano = makePiano($("#piano"), { low: 36, high: 96,
    onPlay: (note, on, vel) => ctx.send({ type: "note_in", on, note, vel }) });

  // Show keys. cardNotes: undefined = nothing to say yet (idle, an older server),
  // null = this card has no voicing, [midi…] = the voicing to light.
  const keysBox = $("#keys");
  const keysLbl = $("#keys-lbl");
  let showKeys = false;
  try { showKeys = localStorage.getItem(KEYS_KEY) === "1"; } catch { /* no storage: off */ }
  keysBox.checked = showKeys;
  let cardNotes;
  const notesOf = (m) => (Array.isArray(m && m.notes) ? m.notes : m && m.notes === null ? null : undefined);
  function syncKeys() {
    keysLbl.hidden = cardNotes === null;
    piano.setHint(showKeys && Array.isArray(cardNotes) ? cardNotes : []);
  }
  keysBox.onchange = () => {
    showKeys = !!keysBox.checked;
    try { localStorage.setItem(KEYS_KEY, showKeys ? "1" : "0"); } catch { /* this visit only */ }
    keysBox.blur();                          // hand the letters back to musical typing
    syncKeys();
  };
  syncKeys();

  const deckName = () => fixedDeck || deck.value;
  // Standalone draws every drill; an embedded pane only the drill it started or resumed.
  let owned = !embedded;
  let prompted = false;            // a prompt arrived since this pane's Start
  const matches = (active) => !!active && (active === fixedDeck || (isReview(fixedDeck) && isReview(active)));

  if (embedded) {
    deck.hidden = true;
    $("#t-head").hidden = false;
    $("#t-title").textContent = opts.title || fixedDeck || "Practice";
    $("#t-blurb").textContent = opts.blurb || "";
    $("#t-blurb").hidden = !opts.blurb;            // no blurb, no empty line
  }
  if (opts.idle) chord.textContent = opts.idle;

  // "Add to review" names the backend it writes to; a review session has nothing to add.
  let backends = [];
  const backendLabel = (backendId) => {
    const b = backends.find((x) => x.id === backendId);
    return (b && b.label) || BACKEND_NAMES[backendId] || backendId || "review";
  };
  let activeBackend = null;
  function syncSeed() {
    seedBtn.hidden = isReview(deckName()) || opts.seedable === false || opts.inReview === true;
    seedBtn.title = `add this deck's cards to review — ${backendLabel(activeBackend)}`;
  }
  function loadBackend() {
    fetch("/api/srs", { cache: "no-store" })
      .then((r) => r.json())
      .then((st) => {
        if (!st || !st.backend) return;
        backends = Array.isArray(st.backends) ? st.backends : [];
        activeBackend = st.backend;
        syncSeed();
      })
      .catch(() => { /* no review seam: the button still works, unnamed */ });
  }
  deck.onchange = syncSeed;
  syncSeed();
  loadBackend();

  // One slot, two faces: a staff for pitch items, the chord name for everything
  // else. `staff` is null on chord decks, so the old path is untouched.
  // Names read with real flats and sharps (Dbm7b5 → D♭m7♭5); the raw text stays in
  // data-raw for anything that reads it back.
  function setText(node, raw, words) {
    node.textContent = words ? prettyWords(raw) : pretty(raw);
    node.setAttribute("data-raw", String(raw ?? ""));
  }

  function showPrompt(staff, text) {
    if (staff && staff.pitches && staff.pitches.length) {
      chord.innerHTML = staffSVG({
        clef: staff.clef, pitches: staff.pitches, key: staff.key || "C",
        width: STAFF_W, height: STAFF_H,
      });
      chord.className = "chord staff";
      return;
    }
    setText(chord, text, true);
    chord.className = "chord";
  }

  function setProgress(idx, total) {
    progress.style.width = total ? `${Math.min(100, (Number(idx) / total) * 100).toFixed(1)}%` : "0%";
  }

  function running(active) {
    $("#start").disabled = active;
    $("#skip").disabled = !active;
    $("#stop").disabled = !active;
    deck.disabled = active;
  }

  $("#start").onclick = () => {
    summary.hidden = true;
    verdict.textContent = "";
    gradeEl.textContent = "";
    owned = true;
    prompted = false;
    ctx.send({ type: "start", deck: deckName() });
  };
  $("#skip").onclick = () => ctx.send({ type: "skip" });
  $("#stop").onclick = () => ctx.send({ type: "stop" });
  // A deck whose lesson is unfinished answers 409 (CONTRACTS.md §8). The gate is
  // a nudge, not a lock: the miss offers a Force link that re-posts with force.
  async function seedDeck(force) {
    const name = deckName().replace(/^(anki|review):/, "");
    const body_ = force ? { builtin: name, force: true } : { builtin: name };
    let r;
    let body = {};
    try {
      r = await fetch("/api/trainer/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body_),
      });
      body = (await r.json()) || {};
    } catch {
      verdict.textContent = "the music server is not answering";
      verdict.className = "verdict no";
      return;
    }
    if (r.ok) {
      const label = backendLabel(body.backend || activeBackend);
      const added = body.added || 0;
      const updated = body.updated || 0;
      verdict.textContent = `${name} → review (${label}): ${added} added`
        + (updated ? `, ${updated} updated` : "")
        + (body.unchanged ? `, ${body.unchanged} already there` : "");
      verdict.className = "verdict ok";
      if (typeof opts.onChange === "function") opts.onChange();
      return;
    }
    if (r.status === 409 && body.lesson) {
      verdict.innerHTML =
        `finish lesson '${body.lesson}' first (Lessons tab) — or ` +
        `<a href="#" id="seed-force" style="color:inherit">force</a>`;
      verdict.className = "verdict no";
      const link = verdict.querySelector("#seed-force");
      if (link) link.onclick = (ev) => { ev.preventDefault(); seedDeck(true); };
      return;
    }
    verdict.textContent = r.status === 503
      ? "Anki is closed — open it, or pick Built-in in the 🧠 menu"
      : body.detail || "could not add to review";
    verdict.className = "verdict no";
  }
  seedBtn.onclick = () => seedDeck(false);

  // grade tiers → traffic-light classes (mirrors learn/grading.py)
  const TIER = {
    clean: "t-good", slip: "t-warn", rough: "t-bad", fail: "t-bad",
    fast: "t-good", ok: "t-good", slow: "t-warn", crawl: "t-bad",
    Easy: "t-good", Good: "t-good", Hard: "t-warn", Again: "t-bad",
  };
  function renderGrade(g) {
    const acc = g.accuracy, spd = g.speed;
    const accText = acc.tier === "clean" ? "clean"
      : `${acc.tier} (${acc.wrong} wrong, ${acc.notes_off} notes off)`;
    gradeEl.innerHTML =
      `<span class="ease ${TIER[g.label]}">${g.label}</span> ` +
      `&nbsp;speed <span class="${TIER[spd.tier]}">${spd.tier} ${spd.latency_s.toFixed(1)}s</span>` +
      ` &middot; accuracy <span class="${TIER[acc.tier]}">${accText}</span>`;
  }

  const decksLoaded = embedded ? Promise.resolve() : fetch("/api/trainer/decks")
    .then((r) => r.json())
    .then((names) => {
      deck.replaceChildren(
        ...names.map((name) => {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          return opt;
        }),
      );
      if (fixedDeck) deck.value = fixedDeck;
    });
  decksLoaded
    .then(() => fetch("/api/trainer/status").then((r) => r.json()))
    // A view mounted mid-drill (reload, tab switch) picks the session back up.
    .then((status) => {
      if (!embedded && status.drill.deck) deck.value = status.drill.deck;
      syncSeed();
      resume(status.drill);
    })
    .catch(() => { /* the trainer API is down: the controls stay idle */ });

  // Render the in-flight item for a client that missed the live prompt event.
  function resume(drill) {
    if (embedded) {
      if (!drill || !drill.active || !matches(drill.deck)) return;
      owned = true;
      prompted = true;
    }
    running(drill && drill.active);
    if (!drill || !drill.active || !drill.prompt) return;
    showPrompt(drill.staff, drill.chord || drill.prompt);
    setText(prompt, drill.prompt, true);
    verdict.textContent = "";
    verdict.className = "verdict";
    setProgress(drill.idx, drill.total);
    cardNotes = notesOf(drill);
    syncKeys();
  }

  const offs = [
    ctx.on("hello", (m) => resume(m.status && m.status.drill)),
    ctx.on("held", (m) => piano.setHeld(m.notes)),
    ctx.on("srs", () => loadBackend()),
    ctx.on("prompt", (m) => {
      if (!owned) return;
      prompted = true;
      running(true);
      cardNotes = notesOf(m);
      syncKeys();
      showPrompt(m.staff, m.chord || m.prompt);
      setText(prompt, m.prompt, true);
      verdict.textContent = "";
      verdict.className = "verdict";
      setProgress(m.idx, m.total);
    }),
    ctx.on("step", (m) => {
      if (!owned) return;
      // progression: next chord in the same card. A recall card (a song
      // phrase) sends chord: null — the next chord is the answer, so keep the
      // prompt up and only count the step.
      if (m.chord) {
        setText(chord, m.chord, false);
        chord.className = "chord";
      }
      if ("notes" in m) {                     // the next chord's voicing (null on a recall card)
        cardNotes = notesOf(m);
        syncKeys();
      }
      verdict.textContent = m.chord
        ? `✓ step ${m.step}/${m.of} — next: ${pretty(m.chord)}`
        : `✓ chord ${m.step} of ${m.of} — next one from memory`;
      verdict.className = "verdict ok";
    }),
    ctx.on("attempt", (m) => {
      if (!owned) return;
      verdict.textContent = m.verdict.summary;
      verdict.className = "verdict " + (m.verdict.ok ? "ok" : "no");
      piano.flash(m.verdict.per_note);
    }),
    ctx.on("passed", (m) => {
      if (!owned) return;
      // Every pass shows its grade: why the card came out Easy, Good, Hard or Again.
      if (m.grade) renderGrade(m.grade);
    }),
    ctx.on("done", (m) => {
      if (!owned) return;
      running(false);
      cardNotes = undefined;                   // done or stopped: no card, no hint
      syncKeys();
      chord.textContent = "session over";
      chord.className = "chord idle";
      prompt.textContent = "";
      setProgress(0, 0);
      const mean = m.summary.mean_latency_s;
      summary.hidden = false;
      summary.innerHTML =
        `<h3>${(embedded && opts.title) || m.deck || "session"}</h3>` +
        `Passed <b>${m.summary.passed}</b> of <b>${m.summary.total}</b>` +
        (mean === null ? "" : ` &middot; mean latency <b>${mean.toFixed(2)}s</b>`);
      if (embedded) owned = false;
    }),
    ctx.on("error", (m) => {
      if (!owned) return;
      verdict.textContent = m.message;
      verdict.className = "verdict no";
      if (embedded && !prompted) owned = false;   // the start failed: nothing here is running
    }),
  ];

  return () => offs.forEach((off) => off());
}
