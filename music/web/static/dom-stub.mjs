// dom-stub.mjs — the DOM that songs.check.mjs and practice.check.mjs run views in
// (node has none). Nodes keep real children, parents, text and classes, and
// innerHTML is parsed into a real (tiny) tree, so a createElement view (songs.js,
// practice.js) and a template view (trainer.js) both work. installDom() puts
// document, window, localStorage, a hand-cranked setInterval and a skewable clock
// on globalThis and hands back the knobs a check turns. Test-only; no view imports it.

const VOID = new Set(["input", "img", "br", "hr", "meta", "link", "source"]);
const ENTITIES = { "&nbsp;": " ", "&middot;": "·", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"" };
const decode = (s) => s.replace(/&[a-z]+;/g, (e) => ENTITIES[e] ?? e);

export function installDom() {
  const idMap = new Map();
  let active = null;
  const counters = { innerHTML: 0 };

  function textNode(s) {
    return { nodeType: 3, parentNode: null, _t: String(s),
      get textContent() { return this._t; }, set textContent(v) { this._t = String(v); } };
  }

  function parseInto(parent, html) {
    const stack = [parent];
    for (const m of String(html).matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)) {
      const top = stack[stack.length - 1];
      if (m[3] !== undefined) {
        const t = decode(m[3]);
        if (t.trim()) top.append(t);
        continue;
      }
      if (m[0].startsWith("</")) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const node = makeEl(m[1]);
      for (const a of m[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
        const [, k, v] = a;
        if (k === "hidden") node.hidden = true;
        else if (k === "disabled") node.disabled = true;
        else node.setAttribute(k, v === undefined ? "" : decode(v));
      }
      top.append(node);
      if (!VOID.has(m[1].toLowerCase()) && !m[0].endsWith("/>")) stack.push(node);
    }
  }

  function makeEl(tag) {
    const el = {
      nodeType: 1, tagName: String(tag).toUpperCase(), childNodes: [], parentNode: null,
      attrs: {}, listeners: {}, _class: "",
      style: { setProperty(k, v) { this[k] = v; } },
      value: "", type: "", title: "", placeholder: "", hidden: false, disabled: false, checked: false,
      src: "", href: "", alt: "", files: null, selectionStart: 0, selectionEnd: 0,
      get children() { return this.childNodes.filter((n) => n.nodeType === 1); },
      get className() { return this._class; },
      set className(v) { this._class = String(v); },
      get id() { return this.attrs.id || ""; },
      set id(v) { this.setAttribute("id", v); },
      get textContent() { return this.childNodes.map((n) => n.textContent).join(""); },
      set textContent(v) { this.replaceChildren(); if (String(v) !== "") this.append(String(v)); },
      get innerHTML() { return this._html || ""; },
      set innerHTML(v) {
        counters.innerHTML += 1;
        this.replaceChildren();
        this._html = String(v);
        parseInto(this, v);
      },
      setAttribute(k, v) {
        this.attrs[k] = String(v);
        if (k === "id") idMap.set(String(v), this);
        if (k === "class") this._class = String(v);
      },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      hasAttribute(k) { return k in this.attrs; },
      append(...kids) {
        for (const k of kids) {
          const node = typeof k === "object" && k ? k : textNode(k);
          if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter((c) => c !== node);
          node.parentNode = this;
          this.childNodes.push(node);
        }
      },
      replaceChildren(...kids) {
        for (const c of this.childNodes) c.parentNode = null;
        this.childNodes = [];
        this._html = "";
        this.append(...kids);
      },
      remove() {
        if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
        this.parentNode = null;
      },
      addEventListener(t, f) { (this.listeners[t] ||= new Set()).add(f); },
      removeEventListener(t, f) { if (this.listeners[t]) this.listeners[t].delete(f); },
      click() {
        if (this.disabled) return;
        const ev = { type: "click", target: this, preventDefault() {}, stopPropagation() {} };
        if (this.onclick) this.onclick(ev);
        for (const f of this.listeners.click || []) f(ev);
      },
      focus() { active = this; },
      blur() { if (active === this) active = null; if (this.onblur) this.onblur({ target: this }); },
      select() {}, setSelectionRange() {}, scrollIntoView() {}, setPointerCapture() {},
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) { return walk(this).filter((n) => matches(n, sel)); },
    };
    el.classList = {
      list() { return el._class.split(/\s+/).filter(Boolean); },
      add(...c) { const s = new Set(this.list()); c.forEach((x) => s.add(x)); el._class = [...s].join(" "); },
      remove(...c) { el._class = this.list().filter((x) => !c.includes(x)).join(" "); },
      toggle(c, force) {
        const on = force === undefined ? !this.contains(c) : !!force;
        if (on) this.add(c); else this.remove(c);
        return on;
      },
      contains(c) { return this.list().includes(c); },
    };
    return el;
  }

  // "#id", ".class", "tag" — enough for the views' own lookups.
  function matches(n, sel) {
    if (sel.startsWith("#")) return n.getAttribute("id") === sel.slice(1);
    if (sel.startsWith(".")) return n.classList.contains(sel.slice(1));
    return n.tagName === sel.toUpperCase();
  }

  const docListeners = {};
  const winListeners = {};
  globalThis.document = {
    createElement: makeEl,
    createElementNS: (_ns, tag) => makeEl(tag),
    createTextNode: textNode,
    getElementById: (id) => idMap.get(id) || null,
    head: makeEl("head"),
    body: makeEl("body"),
    get activeElement() { return active || this.body; },
    elementFromPoint: () => null,
    addEventListener(t, f) { (docListeners[t] ||= new Set()).add(f); },
    removeEventListener(t, f) { if (docListeners[t]) docListeners[t].delete(f); },
  };
  globalThis.window = {
    addEventListener(t, f) { (winListeners[t] ||= new Set()).add(f); },
    removeEventListener(t, f) { if (winListeners[t]) winListeners[t].delete(f); },
    scrollTo() {},
  };

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  // A hand-cranked interval (import rows tick once a second) and a skewable clock.
  const intervals = new Map();
  let nextInterval = 1;
  globalThis.setInterval = (fn) => { intervals.set(nextInterval, fn); return nextInterval++; };
  globalThis.clearInterval = (n) => { intervals.delete(n); };
  const realNow = Date.now.bind(Date);
  const clock = { skew: 0 };
  Date.now = () => realNow() + clock.skew;

  const listenerCount = (bag) => Object.values(bag).reduce((n, s) => n + s.size, 0);
  return {
    makeEl, idMap, store, intervals, clock, counters, docListeners, winListeners,
    pumpIntervals: () => { for (const f of [...intervals.values()]) f(); },
    fireWin: (type, ev) => { for (const f of [...(winListeners[type] || [])]) f({ type, ...ev }); },
    fireDoc: (type, ev) => { for (const f of [...(docListeners[type] || [])]) f({ type, ...ev }); },
    domListeners: () => listenerCount(docListeners) + listenerCount(winListeners),
  };
}

// ── tree helpers ──────────────────────────────────────────────────────────
export const walk = (node, out = []) => {
  for (const c of node.children) { out.push(c); walk(c, out); }
  return out;
};
export const byClass = (node, cls) => walk(node).filter((n) => n.classList.contains(cls));
export const one = (node, cls) => byClass(node, cls)[0] || null;
export const button = (node, label) => walk(node).find((n) => n.tagName === "BUTTON"
  && (label instanceof RegExp ? label.test(n.textContent) : n.textContent === label)) || null;
export const evt = (extra = {}) => ({ prevented: false, preventDefault() { this.prevented = true; }, ...extra });
export const tick = () => new Promise((r) => setTimeout(r, 0));
export const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

/** A fake cockpit ctx: on/send like ws.js, plus fire() and a count of live handlers. */
export function fakeCtx() {
  const handlers = new Map();
  const sent = [];
  const ctx = {
    on(type, cb) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(cb);
      return () => handlers.get(type).delete(cb);
    },
    send(obj) { sent.push(obj); },
  };
  return {
    ctx, sent,
    fire: (msg) => { for (const cb of [...(handlers.get(msg.type) || [])]) cb(msg); },
    live: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
    lastSent: () => sent[sent.length - 1],
  };
}

/**
 * A failed assertion would otherwise print its `actual` with util.inspect — and a
 * stub node drags the whole circular tree (piano included) along. Message only.
 */
export function failFast(name) {
  const fail = (err) => {
    console.error(`${name}: FAIL — ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.error(String(err.stack).split("\n").slice(1, 4).join("\n"));
    process.exit(1);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
}
