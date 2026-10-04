// The header's 🧠 selector: which review backend schedules the flashcards
// (CONTRACTS.md §10) — Built-in by default, Anki when it is open. Same shape as
// the 🔈 sound selector: the server owns the choice, the menu shows and changes
// it, and a WS {type: "srs"} keeps every open tab in step.
//
//   mountSrs(ctx, select) -> { refresh() }
//
// No dialogs: a refused switch reverts the menu and says why in its tooltip.

const TIP = "where review cards live — Built-in (no setup) or Anki";

export function mountSrs(ctx, select) {
  if (!select) return { refresh: async () => {} };
  select.title = TIP;

  async function refresh() {
    let st;
    try {
      const r = await fetch("/api/srs", { cache: "no-store" });
      st = await r.json();
      if (!r.ok || !st || !Array.isArray(st.backends)) throw new Error("no backends");
    } catch {
      select.disabled = true;
      select.title = "review backends unavailable";
      return;
    }
    select.disabled = false;
    select.replaceChildren(...st.backends.map((b) => {
      const o = document.createElement("option");
      o.value = b.id;
      // A select is as wide as its longest option: keep the label short, the reason in the tip.
      o.textContent = b.available ? b.label : `${b.label} (closed)`;
      o.title = b.note || "";
      o.disabled = !b.available;
      return o;
    }));
    select.value = st.backend;
    select.title = TIP;
  }

  select.onchange = async () => {
    const want = select.value;
    let detail = "";
    try {
      const r = await fetch("/api/srs/backend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: want }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        detail = (body && body.detail) || `could not switch to ${want}`;
      }
    } catch {
      detail = "the music server is not answering";
    }
    await refresh();
    if (detail) select.title = detail;
    select.blur();                       // hand the keys back to musical typing
  };

  ctx.on("srs", (m) => {
    if (m && m.backend) select.value = m.backend;
    refresh();
  });
  refresh();
  return { refresh };
}
