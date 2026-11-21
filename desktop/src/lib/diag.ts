// Webview diagnostics into the app's log (diag.rs): uncaught errors and moments the UI stood still – what is
// needed when Hollr "froze" or "was gone". A 1 s timer that fires much later means the page was blocked.
import { invoke } from "@tauri-apps/api/core";

const send = (line: string) => void invoke("diag_log", { line }).catch(() => {});

export function startDiagnostics() {
  window.addEventListener("error", (e) => send(`JS ${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    send(`PROMISE ${r instanceof Error ? `${r.message} ${r.stack?.split("\n")[1] ?? ""}` : String(r)}`);
  });
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    // hidden windows get throttled timers: only stalls of a visible window count
    if (now - last > 5000 && document.visibilityState === "visible")
      send(`STALL ${Math.round(now - last)} ms, heap ${Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6)} MB, route ${location.hash}`);
    last = now;
  }, 1000);
  send("webview start");
}
