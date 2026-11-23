/**
 * Two channels: this plugin's own /api over HTTP (GitHub, with the token Hollr put in the URL fragment) and the
 * host relay to `hollr gate sandcastle` on every paired machine (contract B). Without a Hollr host (plain browser)
 * the relay falls back to /api/host/* of this plugin's own machine.
 */
import type { Grill, GrillMode, LogChunk, Project, QueueState, Server, Status, TicketFlags } from "./types";

const KEY = "sc.token";
let token = "";

/** Takes the token from `#token=…` (then drops it from the URL, keeping `#f=…`) or the session. */
export function initToken(): void {
  const m = location.hash.match(/token=([0-9a-f]+)/);
  if (m?.[1]) {
    sessionStorage.setItem(KEY, m[1]);
    const rest = location.hash.replace(/^#/, "").split("&").filter((p) => p && !p.startsWith("token=")).join("&");
    history.replaceState(null, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
  }
  token = sessionStorage.getItem(KEY) ?? "";
}

function expired(): void {
  const el = document.createElement("div");
  el.className = "expired";
  el.textContent = "Sitzung abgelaufen – in Hollr neu öffnen";
  document.body.replaceChildren(el);
}

/** Fire-and-forget POST that survives the page going away (Hollr removes the frame on navigation). */
export function apiKeepalive(path: string, body: unknown): void {
  fetch(path, {
    method: "POST",
    keepalive: true,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    expired();
    throw new Error("Sitzung abgelaufen");
  }
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = data && typeof data === "object" && "error" in data ? String(data.error) : `HTTP ${res.status}`;
    throw new Error(error);
  }
  return data as T;
}

// ---- host relay

interface Reply {
  hollr: 1;
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { hollr?: { postMessage(msg: unknown): void } } };
    /** iOS replies arrive here (evaluateJavaScript) */
    __hollrHost?: (msg: unknown) => void;
  }
}

/** iOS: only the top-level page may post to the handler; desktop: we live in its iframe. */
function hostPost(): ((msg: unknown) => void) | null {
  const wk = window.webkit?.messageHandlers?.hollr;
  if (wk && window.parent === window) return (msg) => wk.postMessage(msg);
  if (window.parent !== window) return (msg) => window.parent.postMessage(msg, "*");
  return null;
}

const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
let seq = 0;

export interface HostTheme {
  dark: boolean;
  vars: Record<string, string>;
}

/** set by app.ts: Hollr pushes the palette when the user switches it, and `open` („Im Board zeigen“) while the page is open */
export const hostEvents = { onTheme: (_t: HostTheme) => {}, onOpen: (_ticket: string) => {} };

function onReply(msg: unknown): void {
  if (!msg || typeof msg !== "object" || !("hollr" in msg)) return;
  const e = msg as { hollr?: unknown; event?: unknown; data?: unknown };
  if (e.hollr === 1 && e.event === "theme" && e.data && typeof e.data === "object") {
    hostEvents.onTheme(e.data as HostTheme);
    return;
  }
  if (e.hollr === 1 && e.event === "open" && e.data && typeof e.data === "object" && "ticket" in e.data) {
    hostEvents.onOpen(String(e.data.ticket));
    return;
  }
  if (!("id" in msg)) return;
  const r = msg as Reply;
  if (r.hollr !== 1 || typeof r.id !== "string") return;
  const p = pending.get(r.id);
  if (!p) return;
  pending.delete(r.id);
  clearTimeout(p.timer);
  if (r.ok) p.resolve(r.data);
  else p.reject(new Error(r.error || "Fehler im Hollr-Host"));
}

// defined before the first call: iOS answers through it
window.__hollrHost = (m) => onReply(typeof m === "string" ? JSON.parse(m) : m);
window.addEventListener("message", (e) => {
  if (e.source === window.parent && window.parent !== window) onReply(e.data);
});

function hostCall<T>(msg: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const post = hostPost();
  if (!post) return Promise.reject(new Error("kein Hollr-Host"));
  const id = `sc${++seq}`;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error("Hollr antwortet nicht"));
  }, timeoutMs);
  pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
  post({ hollr: 1, id, ...msg });
  return promise;
}

/** Hollr's current palette; null outside Hollr or with an app that predates the theme request. */
export async function hostTheme(): Promise<HostTheme | null> {
  if (!hostPost()) return null;
  try {
    return await hostCall<HostTheme>({ type: "theme" }, 3000);
  } catch {
    return null;
  }
}

/** "host" = relay through Hollr; "local" = standalone, only this machine via /api/host/*. Decided by `servers()`. */
let mode: "host" | "local" | null = null;
const openedAt = Date.now();

export const hasHost = () => mode === "host";

let detecting: Promise<Server[]> | null = null;
/** ids of the last `servers()` answer: a cached id from another mode must not reach the wrong machine */
let known = new Set<string>();

/** Paired machines. An old Hollr without the relay never answers → standalone mode. */
export function servers(): Promise<Server[]> {
  detecting ??= detect().finally(() => {
    detecting = null;
  });
  return detecting;
}

async function detect(): Promise<Server[]> {
  let list: Server[] | null = null;
  if (mode !== "local" && hostPost()) {
    try {
      list = await hostCall<Server[]>({ type: "servers" }, 3000);
      mode = "host";
    } catch (err) {
      if (mode === "host") throw err;
    }
  }
  if (!list) {
    mode = "local";
    list = (await api<{ servers: Server[] }>("/api/host/servers")).servers;
  }
  known = new Set(list.map((s) => s.id));
  return list;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One `hollr gate sandcastle` call on a machine (server id exactly as `servers()` returned it). */
export async function gate<T>(server: string, stdin: Record<string, unknown>, timeoutMs = 25_000): Promise<T> {
  // which channel (and which ids) exist is only known after the first servers answer
  if (mode === null) await servers();
  if (!known.has(server)) throw new Error("Rechner unbekannt");
  if (mode !== "host") return api<T>("/api/host/gate", { command: "sandcastle", stdin });
  for (let attempt = 0; ; attempt++) {
    try {
      return await hostCall<T>({ type: "gate", server, command: "sandcastle", stdin }, timeoutMs);
    } catch (err) {
      // desktop loads the plugin's allowlist right after opening and refuses until then
      const early = Date.now() - openedAt < 4000 && attempt < 5;
      if (early && /allowlist|nicht erlaubt/i.test(String(err))) await sleep(400);
      else throw err;
    }
  }
}

export const sc = {
  projects: (server: string, refresh = false) =>
    gate<{ projects: Project[] }>(server, refresh ? { op: "projects", refresh: true } : { op: "projects" }).then((r) => r.projects),
  status: (server: string) => gate<Status>(server, { op: "status" }, 10_000),
  log: (server: string, path: string, offset?: number) =>
    gate<LogChunk>(server, offset === undefined ? { op: "log", path } : { op: "log", path, offset }),
  queue: (server: string, slug: string) => gate<QueueState>(server, { op: "queue", slug }),
  queueSet: (server: string, slug: string, patch: { order?: number[]; tickets?: Record<string, TicketFlags> }) =>
    gate<QueueState>(server, { op: "queue-set", slug, ...patch }),
  start: (server: string, slug: string, config: { agent: string; parallel: number; screencast: boolean; deploy: boolean }) =>
    gate<{ pane: string | null }>(server, { op: "start", slug, config }, 60_000),
  release: (server: string) => gate(server, { op: "release" }),
  grillStart: (server: string, slug: string, g: { n: number; key: string | null; mode: GrillMode; advisor: string | null }) =>
    gate<{ grill: Grill }>(server, { op: "grill-start", slug, ...g }, 60_000).then((r) => r.grill),
};

/** Opens the run's omp session in Hollr. */
export function openSession(server: string, pane: string): void {
  hostPost()?.({ hollr: 1, type: "open-session", server, pane });
}

/** Public links: Hollr Desktop opens them (postMessage from its iframe), iOS catches window.open. */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (window.parent !== window) window.parent.postMessage({ type: "hollr-open-url", url }, "*");
  else window.open(url, "_blank");
}
