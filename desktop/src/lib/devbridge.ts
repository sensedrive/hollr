// Dev only: lets the frontend run in a normal browser against the backend bridge
// (`cargo run --example bridge -- <data dir>`, then http://localhost:1420/?bridge=7419).
// Commands the bridge doesn't serve (tunnel, live, plugins) resolve to null.
const port = new URLSearchParams(location.search).get("bridge");
if (port && !("__TAURI_INTERNALS__" in window)) {
  let id = 0;
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => ++id,
      async invoke(cmd: string, args: unknown) {
        if (!["servers", "gate"].includes(cmd)) return null;
        const r = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify({ cmd, args }) });
        const data = await r.json();
        if (!r.ok) throw data;
        return data;
      },
    },
  });
}
export {};
