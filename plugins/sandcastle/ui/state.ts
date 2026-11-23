/**
 * Shared state of the views plus the last-known data in localStorage, so a reopened board paints at once from the
 * previous answers and only then catches up with the network (no blocking spinner after the first paint).
 */
import { api, apiKeepalive } from "./api";
import type { BoardData, Issue, JiraBoardData, Project, QueueState, Server, Status } from "./types";

export type View = "board" | "runs";
/** What „Board“ shows: JIRA tickets (default) or the GitHub issues of the Werkbank. */
export type Mode = "tickets" | "werkbank";

/** What the Läufe view shows on the right: a ticket's or a run's log. */
export interface LogSelection {
  server: string;
  run: string;
  n: number | null;
  path: string | null;
}

export const state = {
  servers: [] as Server[],
  /** server id → its lul-workr projects (gate `projects`) */
  machineProjects: new Map<string, Project[]>(),
  /** projects of the plugin's own machine (/api/projects), the first source for the select */
  localProjects: [] as Project[],
  slug: "",
  view: "board" as View,
  board: null as BoardData | null,
  /** closed issues loaded with „Ältere laden“ (kept across board polls) */
  olderClosed: [] as Issue[],
  closedOlder: 0,
  statuses: new Map<string, Status>(),
  statusErrors: new Map<string, string>(),
  /** server id → queue file of the selected repo on that machine */
  queues: new Map<string, QueueState>(),
  query: "",
  selection: null as LogSelection | null,
  /** grill shown on the right of „Läufe“ instead of a log (machine + grill id); exclusive with `selection` */
  grillSel: null as { server: string; id: string } | null,
  /** server whose start form the Läufe view should bring into view */
  startFor: null as string | null,
  mode: "tickets" as Mode,
  /** JIRA tickets of the selected project with their GitHub family and drift */
  jira: null as JiraBoardData | null,
  /** no JIRA access stored on this machine (409 jira-missing) */
  jiraMissing: false,
  /** the last JIRA board load failed (no project key, JIRA down …) */
  jiraError: null as string | null,
};

/** All known projects by slug: the own machine's first, then what other machines add. */
export function projects(): Project[] {
  const out = new Map<string, Project>();
  for (const p of state.localProjects) if (!p.error) out.set(p.slug, p);
  for (const list of state.machineProjects.values()) for (const p of list) if (!p.error && !out.has(p.slug)) out.set(p.slug, p);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));
}

export const currentProject = () => projects().find((p) => p.slug === state.slug);

/** The project as checked out on a given machine (root, agents and support differ per machine). */
export const projectOn = (server: string, slug = state.slug) =>
  state.machineProjects.get(server)?.find((p) => p.slug === slug && !p.error);

/** Machines that have the selected repo checked out = the Sandcastle lanes; own machine first. */
export function laneServers(): Server[] {
  return state.servers
    .filter((s) => projectOn(s.id))
    .sort((a, b) => Number(b.self) - Number(a.self) || a.label.localeCompare(b.label, "de"));
}

export const serverLabel = (id: string) => state.servers.find((s) => s.id === id)?.label ?? id;

// ---- render hook (app.ts) and cache

export const hooks = {
  /** re-renders what is visible, incrementally */
  render: () => {},
  reloadBoard: async (): Promise<void> => {},
  reloadStatus: async (): Promise<void> => {},
  reloadQueues: async (): Promise<void> => {},
  show: (_view: View) => {},
  /** switches Tickets | Werkbank (and to „Board“) */
  showMode: (_mode: Mode) => {},
  reloadJira: async (): Promise<void> => {},
  /** Tickets view + the ticket's details */
  openTicket: (_key: string) => {},
};

// ---- settings (project, view, filter, column, start form) – on the plugin server, because the page origin
// changes with every Hollr tunnel and localStorage would start empty each time

let prefs: Record<string, unknown> = {};
let pending: Record<string, unknown> = {};
let prefTimer: ReturnType<typeof setTimeout> | undefined;

/** Before the first paint; a failure keeps the defaults (the board still works). */
export async function loadPrefs(): Promise<void> {
  try {
    prefs = (await api<{ prefs: Record<string, unknown> }>("/api/prefs")).prefs;
  } catch {
    prefs = {};
  }
}

export const prefGet = <T>(key: string): T | null => (prefs[key] as T | undefined) ?? null;

export function prefSet(key: string, value: unknown): void {
  if (JSON.stringify(prefs[key]) === JSON.stringify(value)) return;
  prefs[key] = value;
  pending[key] = value;
  clearTimeout(prefTimer);
  prefTimer = setTimeout(flushPrefs, 200);
}

function flushPrefs(): void {
  clearTimeout(prefTimer);
  if (!Object.keys(pending).length) return;
  const body = pending;
  pending = {};
  apiKeepalive("/api/prefs", body);
}

// the frame may vanish any moment (view switch in Hollr, reload): write what is pending right away
addEventListener("pagehide", flushPrefs);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushPrefs();
});

const PREFIX = "sc.v2.";

export function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function cacheSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // quota or private mode: the cache is only a head start
  }
}

// ---- toast

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, kind: "error" | "info" = "error"): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el?.classList.remove("show"), kind === "error" ? 7000 : 4000);
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
