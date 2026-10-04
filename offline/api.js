// offline/api.js — the static page's answer to every fetch("/api/…") the views make
// (CONTRACTS.md §12). handle(method, path, body) → {status, body} mirrors the server's routers
// (web/server.py, trainer/router.py, songs/router.py, srs/router.py, sound/router.py) over the
// in-browser runtime; what only the local app can do answers one calm sentence instead.
// installFetch() puts it in front of window.fetch: only /api/ URLs are answered here — the
// page's own files (data, samples, modules) pass straight through. Pure except installFetch.

export const LOCAL_ONLY = "This needs the local app — see the README.";
export const IMPORT_LOCAL_ONLY = "Importing a Real Book page needs the local app — see the README.";
export const EDIT_LOCAL_ONLY = "Editing a chart needs the local app — see the README.";

const ok = (body) => ({ status: 200, body });
const fail = (status, detail, extra = {}) => ({ status, body: { detail, ...extra } });

/** rt: the runtime (offline/runtime.js createRuntime). */
export function createApi(rt) {
  const routes = [
    ["GET", /^\/api\/health$/, () => ok({ ok: true, static: true })],
    ["GET", /^\/api\/views$/, () => ok(rt.app.views)],
    ["GET", /^\/api\/practice$/, () => ok(rt.practiceMenu())],

    // trainer (trainer/router.py) — no lesson gate: the page has no Lessons tab (§8).
    ["GET", /^\/api\/trainer\/status$/, () => ok(rt.trainer.status())],
    ["GET", /^\/api\/trainer\/decks$/, () => ok(rt.trainer.deckNames())],
    ["POST", /^\/api\/trainer\/seed$/, (m, body) => {
      const name = String((body && body.builtin) || "");
      try {
        return ok({ builtin: name, ...rt.trainer.seedBuiltin(name) });
      } catch (e) {
        if (e && e.status) return fail(e.status, e.detail);
        throw e;
      }
    }],

    // review backends (srs/router.py): the built-in scheduler is the only one here.
    ["GET", /^\/api\/srs$/, () => ok(rt.srsStatus())],
    ["POST", /^\/api\/srs\/backend$/, (m, body) => {
      const want = String((body && body.backend) || "");
      if (want !== rt.review.id) {
        return fail(400, want === "anki" ? "Anki needs the local app — see the README."
          : `unknown backend '${want}'`);
      }
      return ok(rt.srsStatus());
    }],

    // sound (sound/router.py + samples_api.py): browser drivers only.
    ["GET", /^\/api\/sound$/, () => ok(rt.soundStatus())],
    ["POST", /^\/api\/sound\/driver$/, (m, body) => {
      const id = String((body && body.driver) || "");
      return rt.setSound(id) ? ok({ driver: id }) : fail(404, `no driver '${id}'`);
    }],
    ["POST", /^\/api\/sound\/logic$/, () => fail(503, "Logic Pro needs the local app — see the README.")],

    // songs (songs/router.py): read, the dial, review, receipts. Static paths first.
    ["GET", /^\/api\/songs$/, () => ok(rt.songs.summaries())],
    ["POST", /^\/api\/songs\/import$/, () => fail(501, IMPORT_LOCAL_ONLY)],
    ["GET", /^\/api\/songs\/imports$/, () => ok([])],
    ["GET", /^\/api\/songs\/imports\/[^/]+$/, () => fail(404, "no import jobs on this page")],
    ["GET", /^\/api\/songs\/([^/]+)$/, (m) => {
      const doc = rt.songs.song(m[1]);
      return doc ? ok(doc) : fail(404, `no song '${m[1]}'`);
    }],
    ["GET", /^\/api\/songs\/([^/]+)\/text$/, (m) => {
      const text = rt.songs.text(m[1]);
      return text === null ? fail(404, `no song '${m[1]}'`) : ok({ text });
    }],
    ["PATCH", /^\/api\/songs\/([^/]+)$/, (m, body) => {
      const id = m[1];
      if (!rt.songs.songs[id]) return fail(404, `no song '${id}'`);
      const b = body || {};
      const edits = Object.keys(b).filter((k) => k !== "grade" && b[k] !== null && b[k] !== undefined);
      if (edits.length) return fail(422, EDIT_LOCAL_ONLY, { errors: [EDIT_LOCAL_ONLY] });
      if (b.grade === null || b.grade === undefined) return ok(rt.songs.song(id));
      if (!rt.songs.songs[id].dials[b.grade]) {
        const detail = `grade must be one of ${Object.keys(rt.songs.songs[id].dials).join(", ")}`;
        return fail(422, detail, { errors: [detail] });
      }
      return ok(rt.songs.patchGrade(id, b.grade));
    }],
    ["POST", /^\/api\/songs\/([^/]+)\/seed$/, (m) => {
      if (!rt.songs.songs[m[1]]) return fail(404, `no song '${m[1]}'`);
      return ok(rt.songs.seed(m[1]));
    }],
    ["GET", /^\/api\/songs\/([^/]+)\/runs$/, (m) => ok(rt.songs.runs(m[1]))],
    ["PUT", /^\/api\/songs\/([^/]+)\/(text|bar\/.+)$/, () => fail(422, EDIT_LOCAL_ONLY, { errors: [EDIT_LOCAL_ONLY] })],
    ["POST", /^\/api\/songs\/([^/]+)\/reread$/, () => fail(501, IMPORT_LOCAL_ONLY)],
    ["DELETE", /^\/api\/songs\/([^/]+)$/, () => fail(501, EDIT_LOCAL_ONLY)],
  ];

  function handle(method, path, body) {
    const verb = String(method || "GET").toUpperCase();
    const clean = String(path).split("?")[0].split("#")[0];
    for (const [want, re, fn] of routes) {
      if (want !== verb) continue;
      const m = re.exec(clean);
      if (!m) continue;
      const decoded = m.map((part, i) => (i === 0 || part === undefined ? part : safeDecode(part)));
      return fn(decoded, body);
    }
    return fail(404, LOCAL_ONLY);
  }

  return { handle };
}

function safeDecode(part) {
  try { return decodeURIComponent(part); } catch { return part; }
}

/**
 * Put the API in front of fetch. Only "/api/…" (or this origin's /api/) is answered here;
 * the sample set is served from the page's own files (samplesBase: URL of its folder).
 */
export function installFetch(api, { samplesBase, realFetch = globalThis.fetch.bind(globalThis) } = {}) {
  const apiPath = (input) => {
    const raw = typeof input === "string" ? input : input && (input.href || input.url) || "";
    if (raw.startsWith("/api/")) return raw;
    try {
      const u = new URL(raw, globalThis.location.href);
      if (u.origin === globalThis.location.origin && u.pathname.startsWith("/api/")) return u.pathname + u.search;
    } catch { /* not a URL: not ours */ }
    return null;
  };

  globalThis.fetch = async (input, init = {}) => {
    const path = apiPath(input);
    if (path === null) return realFetch(input, init);
    const clean = path.split("?")[0];
    if (clean === "/api/sound/samples/manifest" || clean.startsWith("/api/sound/samples/file/")) {
      if (!samplesBase) return new Response(JSON.stringify({ detail: "no sample set" }), { status: 404 });
      const rel = clean === "/api/sound/samples/manifest" ? "manifest.json"
        : clean.slice("/api/sound/samples/file/".length);
      return realFetch(new URL(rel, samplesBase).href);
    }
    const method = (init && init.method) || (input && typeof input === "object" && input.method) || "GET";
    let body = null;
    if (init && typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = null; }
    }
    let reply;
    try {
      reply = api.handle(method, path, body);
    } catch (e) {
      console.error("static api:", e);
      reply = { status: 500, body: { detail: String((e && e.message) || e) } };
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "content-type": "application/json" } });
  };
}
