// Helpers for the session view (AgentView & co): extra gate wrappers, omp formatting rules,
// terminal key mapping and link/URL handling. Mirrors the iPhone app (AgentSession, Timeline, BrowserView).
import { gate } from "./api";
import type { Timeline, TimelineItem, TodoPhase } from "./api";

// ------------------------------------------------------------ gate wrappers

/** Events from an agent's session log (non-omp agents' chat history). */
export type HistoryEvent =
  | { t: "delegation"; text: string }
  | { t: "user"; text: string }
  | { t: "tool"; name: string; intent?: string }
  | { t: "answer"; text: string; final: boolean };

export const history = (s: string, pane: string, limit = 80) =>
  gate<{ events?: HistoryEvent[]; status?: string }>(s, `history ${pane} ${limit}`);

/** Web pages listening on the server's loopback (server/src/ports.ts). */
export interface WebPort {
  port: number;
  title?: string;
  process?: string;
  cwd?: string;
}
export const ports = (s: string) => gate<{ ports: WebPort[] }>(s, "ports").then((r) => r.ports ?? []);
export const portLabel = (p: WebPort) => p.title ?? p.cwd?.split("/").filter(Boolean).pop() ?? p.process ?? `Port ${p.port}`;

// ------------------------------------------------------------ timeline (Model/Timeline.swift)

/** Items as omp's transcript shows them: todo updates live only in the pinned TODO tree. */
export function visibleItems(tl: Timeline): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const item of tl.items) {
    if (item.k !== "tools") {
      out.push(item);
      continue;
    }
    const calls = item.calls.filter((c) => c.name !== "todo");
    if (calls.length) out.push(calls.length === item.calls.length ? item : { ...item, calls });
  }
  return out;
}

/** What omp shows in its working row: the intent of the latest running tool call. */
export function workingLabel(tl: Timeline): string | undefined {
  for (let i = tl.items.length - 1; i >= 0; i--) {
    const item = tl.items[i];
    if (item?.k !== "tools") continue;
    const c = [...item.calls].reverse().find((c) => c.status === "running");
    if (c) return c.label;
  }
  return undefined;
}

export const cleanTitle = (title?: string) => title?.replace(/^[^\p{L}\p{N}]+/u, "") || undefined;

const closed = (s: string) => s === "completed" || s === "abandoned";
/** omp clears the TODO once everything is closed. */
export const openPhase = (tl: Timeline): TodoPhase | undefined => tl.todo?.find((p) => p.tasks.some((x) => !closed(x.status)));
export const hudVisible = (tl: Timeline) => tl.running || tl.jobs.length > 0 || !!openPhase(tl);
export const phaseDone = (p: TodoPhase) => p.tasks.filter((x) => x.status === "completed").length;

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
export function phaseName(p: TodoPhase, all: TodoPhase[]): string {
  if (all.length < 2) return p.name;
  const i = all.findIndex((x) => x.name === p.name);
  return (i >= 0 && i < ROMAN.length ? `${ROMAN[i]}. ` : "") + p.name;
}

export function todoColor(status: string): string {
  return (
    { completed: "var(--green)", in_progress: "var(--orange)", abandoned: "var(--red)", blocked: "var(--yellow)" }[status] ??
    "var(--dim)"
  );
}

/** omp's format: 850ms, 12.3s, 6m10s, 2h5m, 3d4h */
export function duration(ms: number): string {
  ms = Math.max(ms, 0);
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return s < 10 ? `${s.toFixed(1)}s` : `${Math.floor(s)}s`;
  const t = Math.floor(s);
  if (t < 3600) return `${Math.floor(t / 60)}m${t % 60}s`;
  if (t < 86400) return `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m`;
  return `${Math.floor(t / 86400)}d${Math.floor((t % 86400) / 3600)}h`;
}

/** Thinking as omp shows it: prose only, code blocks dropped ("..." where one was). */
export function thinkingProse(text: string): string {
  const out: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (!fence && out.length) out[out.length - 1] += "...";
      fence = !fence;
      continue;
    }
    if (!fence && line.trim()) out.push(line);
  }
  return out.join("\n");
}

export const shortPath = (p?: string) => (p ?? "").replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");

export function toolIcon(name: string): string {
  switch (name) {
    case "bash": return "❯";
    case "edit": case "write": return "✎";
    case "read": return "≡";
    case "grep": case "glob": return "⌕";
    case "task": return "⇶";
    case "todo": return "☑";
    case "ask": return "?";
    case "wait": case "hub": return "⚙";
    case "web_search": case "browser": return "◍";
    case "eval": return "λ";
    default: return "•";
  }
}

export function toolTitle(name: string): string {
  if (name === "web_search") return "Search";
  if (name.startsWith("mcp__")) return name.split("_").pop() || name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ------------------------------------------------------------ terminal screen

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "").replace(/\r/g, "");

/** Nerd-Font / powerline glyphs (private use area) – no desktop font draws them. */
const PUA = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFF}]/gu;

/** Screen as a card in the chat: frames, status bars and empty lines dropped (AgentSession.cleanScreen). */
export const cleanScreen = (s: string) =>
  stripAnsi(s)
    .split("\n")
    .map((l) => l.replace(PUA, "").replace(/[│┃╭╮╰╯]/g, "").trimEnd())
    .filter((l) => l.trim() && !/^[─━═-]+$/.test(l.trim()))
    .join("\n");

/** Screen for the terminal view: layout kept, only undrawable glyphs blanked. */
export const terminalScreen = (s: string) =>
  stripAnsi(s)
    .split("\n")
    .map((l) => l.replace(PUA, " ").trimEnd())
    .join("\n");

/**
 * Maps a keydown to the key name `hollr gate keys` hands to `herdr … send-keys`.
 * Returns undefined for keys that should stay with the app (Cmd shortcuts, lone modifiers).
 */
export function herdrKey(e: KeyboardEvent): string | undefined {
  if (e.metaKey || e.isComposing) return undefined;
  const named: Record<string, string> = {
    Enter: "enter", Escape: "esc", Tab: "tab", Backspace: "backspace", Delete: "delete",
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", Insert: "insert", " ": "space",
  };
  let k = named[e.key];
  if (!k && /^F([1-9]|1[0-2])$/.test(e.key)) k = e.key.toLowerCase();
  if (!k && e.key.length === 1) {
    if (e.ctrlKey || e.altKey) {
      // Ctrl/Alt combos use the base key (Alt+n on a Mac keyboard produces "~" otherwise)
      const base = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.code.startsWith("Digit") ? e.code.slice(5) : e.key.toLowerCase();
      k = base;
    } else return e.key;
  }
  if (!k) return undefined;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && k.length > 1 && "shift"].filter(Boolean);
  return [...mods, k].join("+");
}

/** Text → key names (paste / typing into the terminal). */
export const textKeys = (text: string) =>
  [...text.replace(/\r\n?/g, "\n")].map((c) => (c === " " ? "space" : c === "\n" ? "enter" : c === "\t" ? "tab" : c)).filter((c) => c.trim());

// ------------------------------------------------------------ links / browser

/** Addresses only the server can reach (opened through the SSH tunnel). */
export function isLoopback(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(h) || h.endsWith(".localhost");
}
export const urlPort = (url: URL) => Number(url.port) || (url.protocol === "https:" ? 443 : 80);

/** "example.com" → https, "localhost:3000" / "3000" → http, other text → search. */
export function urlFrom(input: string): URL | undefined {
  const text = input.trim();
  if (!text) return undefined;
  try {
    const u = new URL(text);
    if (u.protocol === "http:" || u.protocol === "https:") return u;
  } catch {}
  const n = Number(text.replace(/^:+|:+$/g, ""));
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return new URL(`http://localhost:${n}`);
  const local = /^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)/.test(text);
  if (!text.includes(" ") && (text.includes(".") || text.includes(":"))) {
    try {
      return new URL((local ? "http://" : "https://") + text);
    } catch {}
  }
  const s = new URL("https://duckduckgo.com/");
  s.searchParams.set("q", text);
  return s;
}

/** localhost:3000/x → 127.0.0.1:<local>/x */
export function viaTunnel(url: URL, localPort: number): string {
  const u = new URL(url.href);
  u.protocol = "http:";
  u.hostname = "127.0.0.1";
  u.port = String(localPort);
  return u.href;
}

export const displayUrl = (url: URL) => (isLoopback(url) ? url.href.replace(/^http:\/\//, "") : url.href);

const RECENT = "hollr.browser.recent";
export function recentUrls(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]");
  } catch {
    return [];
  }
}
export function rememberUrl(url: string) {
  try {
    localStorage.setItem(RECENT, JSON.stringify([url, ...recentUrls().filter((x) => x !== url)].slice(0, 12)));
  } catch {}
}
