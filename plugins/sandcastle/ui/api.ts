/**
 * Two channels: this plugin's own /api over HTTP (GitHub, with the token Hollr put in the URL fragment) and the
 * host relay to `hollr gate sandcastle` on every paired machine (contract B). Without a Hollr host (plain browser)
 * the relay falls back to /api/host/* of this plugin's own machine.
 */
import { reconnectPolicy } from "./reconnect";
import type {
  Grill,
  GrillMode,
  LogChunk,
  Project,
  QueueState,
  RunConfig,
  RunPreview,
  Server,
  SetupCheck,
  SetupFileInfo,
  SetupFilePath,
  SetupJob,
  Status,
  TicketFlags,
} from "./types";

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

const shouldReopen = reconnectPolicy();

/**
 * A failed fetch can be a blip; the health endpoint (no token) tells whether the server behind our port is gone –
 * the board polls only every 15 s, so waiting for a second failure would leave a dead page standing for long.
 */
async function confirmLost(): Promise<void> {
  try {
    const r = await fetch("/__hollr/health", { signal: AbortSignal.timeout(2500) });
    if (r.ok) return;
  } catch {}
  lostServer("network");
}

/** Inside a host: show „Verbinde neu …“ and let the app reopen us (new port and token, frame reloads). */
function lostServer(kind: "network" | "auth"): void {
  const post = hostPost();
  if (!post) {
    if (kind === "auth") expired();
    return;
  }
  if (!shouldReopen(kind, Date.now())) return;
  const el = document.createElement("div");
  el.className = "expired";
  el.textContent = "Verbinde neu …";
  document.body.replaceChildren(el);
  post({ hollr: 1, type: "reopen" });
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
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof TypeError) void confirmLost();
    throw err;
  }
  if (res.status === 401) {
    lostServer("auth");
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
export const hostEvents = { onTheme: (_t: HostTheme) => {}, onOpen: (_ticket: string, _repo?: string) => {} };

function onReply(msg: unknown): void {
  if (!msg || typeof msg !== "object" || !("hollr" in msg)) return;
  const e = msg as { hollr?: unknown; event?: unknown; data?: unknown };
  if (e.hollr === 1 && e.event === "theme" && e.data && typeof e.data === "object") {
    hostEvents.onTheme(e.data as HostTheme);
    return;
  }
  if (e.hollr === 1 && e.event === "open" && e.data && typeof e.data === "object" && "ticket" in e.data) {
    const d = e.data as { ticket: unknown; repo?: unknown };
    hostEvents.onOpen(String(d.ticket), typeof d.repo === "string" ? d.repo : undefined);
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
  /** `tickets`: flags per issue; null removes an issue's flags */
  queueSet: (server: string, slug: string, patch: { order?: number[]; tickets?: Record<string, TicketFlags | null> }) =>
    gate<QueueState>(server, { op: "queue-set", slug, ...patch }),
  /** appends the numbers the machine's order lacks, on the stored file (merges with other boards' writes) */
  queueAdd: (server: string, slug: string, add: number[]) => gate<QueueState>(server, { op: "queue-add", slug, add }),
  /** takes numbers out of the machine's order, on the stored file */
  queueRemove: (server: string, slug: string, remove: number[]) => gate<QueueState>(server, { op: "queue-remove", slug, remove }),
  /** `tickets`: issue numbers put at the front of the queue before the run starts */
  start: (server: string, slug: string, config: RunConfig, tickets: number[] = []) =>
    gate<{ pane: string | null }>(server, tickets.length ? { op: "start", slug, config, tickets } : { op: "start", slug, config }, 60_000),
  /** the exact skill line `start` would send with the same arguments – starts and writes nothing */
  preview: (server: string, slug: string, config: RunConfig, tickets: number[] = []) =>
    gate<RunPreview>(server, tickets.length ? { op: "preview", slug, config, tickets } : { op: "preview", slug, config }, 60_000),
  release: (server: string) => gate(server, { op: "release" }),
  /** Ctrl-C into the run's session, then frees the lock */
  stop: (server: string) => gate(server, { op: "stop" }),
  /** `note`: why the main checkout stayed behind its upstream (the grill reads the old state) */
  grillStart: (server: string, slug: string, g: { n: number; key: string | null; mode: GrillMode; advisor: string | null }) =>
    gate<{ grill: Grill; note?: string }>(server, { op: "grill-start", slug, ...g }, 120_000),
  // ---- setup of a project on another machine („Maschine wechseln“); file contents only pass through, never kept
  /** checklist of the machine; `expect`: the files the source has (only those are checked) */
  setupCheck: (server: string, slug: string, expect: SetupFilePath[]) => gate<SetupCheck>(server, { op: "setup-check", slug, expect }, 60_000),
  /** starts `gh repo clone` detached; `setupCheck` reports the job */
  setupClone: (server: string, slug: string) => gate<{ path: string; job: SetupJob }>(server, { op: "setup-clone", slug }),
  /** the whitelisted files of the checkout: size and secret key names, no contents */
  setupFiles: (server: string, slug: string) =>
    gate<{ root: string | null; files: SetupFileInfo[] }>(server, { op: "setup-files", slug }).then((r) => r.files),
  setupFilesRead: (server: string, slug: string, paths: SetupFilePath[]) =>
    gate<{ files: { path: SetupFilePath; content: string }[] }>(server, { op: "setup-files-read", slug, paths }).then((r) => r.files),
  setupFilesWrite: (server: string, slug: string, files: { path: SetupFilePath; content: string }[], overwrite: boolean) =>
    gate<{ written: { path: SetupFilePath; size: number; mode: string }[] }>(server, { op: "setup-files-write", slug, files, overwrite }),
  setupInstall: (server: string, slug: string) => gate<{ job: SetupJob }>(server, { op: "setup-install", slug }),
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

/** text editing keeps its own ⌘/Ctrl keys (copy, paste, undo, select all, find) */
const EDITING_KEYS = new Set(["a", "c", "v", "x", "z", "y", "f"]);

// Hollr's shortcuts (⌘K search, ⌘1 overview, ⌘, settings, ⌘N, zoom …) also work while the board has the focus:
// a ⌘/Ctrl key the page didn't use goes to Hollr Desktop, which handles it as if typed there (desktop only –
// iOS has no such shortcuts in a web view)
window.addEventListener("keydown", (e) => {
  if (window.parent === window || e.defaultPrevented || !(e.metaKey || e.ctrlKey)) return;
  // ⌘←, ⌘⌫ … move and delete in text fields: only character keys can be Hollr's shortcuts
  if (e.key.length !== 1) return;
  if (EDITING_KEYS.has(e.key.toLowerCase()) && !e.altKey) return;
  window.parent.postMessage(
    { type: "hollr-key", key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey },
    "*",
  );
  e.preventDefault();
});
