// Dev only: lets the frontend run in a normal browser against the backend bridge
// (`cargo run --example bridge -- <data dir>`, then http://localhost:1420/?bridge=7419).
// Commands the bridge doesn't serve (tunnel, plugins) resolve to null. Events the bridge emits
// (the live terminal's `hollr-term`, omp /live's `live`) arrive as server-sent events from /events.
const port = new URLSearchParams(location.search).get("bridge");
if (port && !("__TAURI_INTERNALS__" in window)) {
  let id = 0;
  const callbacks = new Map<number, (v: unknown) => void>();
  /** event name → its listeners' callback ids */
  const listeners = new Map<string, Set<number>>();
  let events: EventSource | undefined;
  const subscribe = () => {
    const source = new EventSource(`http://127.0.0.1:${port}/events`);
    source.onmessage = (m) => {
      const { event, payload } = JSON.parse(m.data) as { event: string; payload: unknown };
      for (const h of listeners.get(event) ?? []) callbacks.get(h)?.({ event, id: h, payload });
    };
    return source;
  };
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: (cb: (v: unknown) => void) => {
        callbacks.set(++id, cb);
        return id;
      },
      async invoke(cmd: string, args: unknown) {
        if (cmd === "plugin:event|listen") {
          const { event, handler } = args as { event: string; handler: number };
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(handler);
          events ??= subscribe();
          return handler;
        }
        const bridged = ["servers", "gate", "term_start", "term_write", "term_resize", "term_stop", "live_start", "live_stop", "live_mute", "live_speaker", "live_headphones"];
        if (!bridged.includes(cmd)) return null;
        const r = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify({ cmd, args }) });
        const data = await r.json();
        if (!r.ok) throw data;
        return data;
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener(event: string, handler: number) {
        listeners.get(event)?.delete(handler);
        callbacks.delete(handler);
      },
    },
  });
}
export {};
