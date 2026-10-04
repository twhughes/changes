// The one socket: /ws/state, JSON in and out, dispatched by event type.
// Auto-reconnects with a flat 1 s backoff — the cockpit is localhost, a drop
// means the server restarted, not that the network is congested.

export function connect(path = "/ws/state") {
  const subs = new Map(); // type -> Set(callback)
  let socket = null;
  let closed = false;

  function emit(type, msg) {
    const set = subs.get(type);
    if (set) for (const cb of [...set]) cb(msg);
  }

  function open() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${proto}//${location.host}${path}`);
    socket.onopen = () => emit("_open", {});
    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      emit(msg.type, msg);
      emit("*", msg);
    };
    socket.onclose = () => {
      emit("_close", {});
      if (!closed) setTimeout(open, 1000);
    };
    socket.onerror = () => socket && socket.close();
  }
  open();

  return {
    // on(type, cb) -> unsubscribe()
    on(type, cb) {
      if (!subs.has(type)) subs.set(type, new Set());
      subs.get(type).add(cb);
      return () => subs.get(type).delete(cb);
    },
    send(obj) {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
    },
    close() {
      closed = true;
      if (socket) socket.close();
    },
  };
}
