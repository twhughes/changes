// Sound loader: mounts the browser-side driver the server says is active and
// feeds it the raw `note` firehose. Driver contract (one module per id under
// ./sound/<id>.js):
//
//   export async function create(ac /* AudioContext */, out /* GainNode */)
//     -> { noteOn(note, vel), noteOff(note), allOff(), dispose(),
//          set?(cc, value), values?() }
//
// set / values are optional: a driver whose sound has settings has them (the S-1 twin: its
// controls by CC number, 0..127; values() -> {cc: value} as set now). A driver without
// settings (the E-piano) simply leaves them out, and the header shows no settings button.
//
// mountSound(ctx) -> { current(), setGain(g), driver(), onChange(cb) }: driver() is the live
// driver (null for "off" or while one loads); onChange(cb) calls cb(id) when the chosen sound
// changes and again once its driver is live, and returns an unsubscribe.
//
// "off" mounts nothing here.
// Web Audio needs a user gesture to start: the first click/keydown on the page
// resumes the context, so the selector itself counts. A MIDI keyboard's notes are not
// a gesture, so a note that arrives while the browser still holds the sound back shows
// one line — "Click anywhere to turn on sound" — that goes the moment sound starts.

const BROWSER_DRIVERS = new Set(["samples", "twin"]);

/** A browser driver's module by id. Every importer uses this one URL, so all of them share one module. */
export const loadDriver = (id) => import(`./${id}.js?v=2`);

export function mountSound(ctx) {
  let ac = null, out = null, driver = null, wanted = "off", loads = 0;
  const listeners = new Set();
  const changed = () => { for (const cb of [...listeners]) { try { cb(wanted); } catch { /* a listener's own */ } } };

  function ensureAc() {
    if (ac) return;
    ac = new (window.AudioContext || window.webkitAudioContext)();
    out = ac.createGain();
    out.gain.value = 0.8;
    out.connect(ac.destination);
    ac.onstatechange = () => { if (!held()) showHeld(false); };
  }

  // The browser holds page audio back until a click or key press on the page.
  const held = () => !!ac && (ac.state === "suspended" || ac.state === "interrupted");
  let note = null;
  function showHeld(show) {
    if (typeof document === "undefined" || !document.body) return;
    if (show && !note) {
      note = document.createElement("div");
      note.className = "snd-held";
      note.textContent = "🔇 Click anywhere to turn on sound";
      note.style.cssText = "position:fixed;top:54px;left:50%;transform:translateX(-50%);z-index:20;"
        + "padding:6px 14px;border-radius:999px;background:#2a2412;border:1px solid #6b5a1e;"
        + "color:#f0d48c;font:13px system-ui,-apple-system,sans-serif;pointer-events:none;";
      document.body.append(note);
    }
    if (note) note.hidden = !show;
  }
  const resume = () => { if (ac && ac.state !== "running") ac.resume(); };
  window.addEventListener("pointerdown", resume, { passive: true });
  window.addEventListener("keydown", resume);

  async function use(id) {
    wanted = id;
    const mine = ++loads;               // a newer use() (even of the same id) supersedes this one
    if (driver) { try { driver.allOff(); driver.dispose(); } catch {} driver = null; }
    changed();
    if (!BROWSER_DRIVERS.has(id)) return;
    ensureAc();
    resume();
    let mod;
    try { mod = await loadDriver(id); }
    catch (e) { console.warn(`sound: driver ${id} failed to load`, e); return; }
    if (mine !== loads) return;         // switched again while loading
    const made = await mod.create(ac, out);
    // create() can take a moment (the twin loads an AudioWorklet): a switch meanwhile drops this one
    if (mine !== loads) { try { made.allOff(); made.dispose(); } catch {} return; }
    driver = made;
    changed();
  }

  ctx.on("hello", (m) => use((m.sound && m.sound.driver) || "off"));
  ctx.on("sound", (m) => use(m.driver));
  ctx.on("note", (m) => {
    if (!driver) return;
    if (m.on && held()) showHeld(true);           // a MIDI key, and the browser keeps it silent
    if (m.on) driver.noteOn(m.note, m.vel); else driver.noteOff(m.note);
  });
  ctx.on("_close", () => driver && driver.allOff());

  return {
    current: () => wanted,
    setGain: (g) => { if (out) out.gain.value = g; },
    driver: () => driver,
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
