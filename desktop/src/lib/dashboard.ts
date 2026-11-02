// Pure rules of the dashboard (DashboardView.swift + the desktop's "what needs me / what am I working on"):
// pooled usage limits, a session's context from its timeline, project grouping and the urgency order.
// State and fetching live in views/dashboard/context.svelte.ts.
import { cleanTitle, workingLabel, type HistoryEvent, type WebPort } from "./agent";
import type { Timeline, TimelineItem, TodoPhase } from "./api";
import type { Space } from "./git";
import { plain, type InboxKind } from "./inbox";

// ------------------------------------------------------------ usage limits

export interface Capacity {
  provider: string;
  window: string;
  meter?: string;
  used: number;
}

/** "5h" → 5, "7d" → 168, "1w" → 168, else months */
export function windowHours(window: string): number {
  const m = /^(\d*)(.*)$/.exec(window);
  const n = Number(m?.[1] || 0);
  const unit = m?.[2] ?? "";
  return n * (unit.startsWith("h") ? 1 : unit.startsWith("d") ? 24 : unit.startsWith("w") ? 168 : 720);
}

/** The quiet line only shows Claude and ChatGPT's main ("chat") meters. */
export const mainCaps = <T extends Capacity>(caps: T[]): T[] =>
  caps.filter((c) => (!c.meter || c.meter === "chat") && (c.provider === "anthropic" || c.provider === "openai-codex"));

/**
 * One value per provider and window: several servers (and the same login on each) report the same limit –
 * the line shows the fullest one, in a stable order (5h before 7d).
 */
export function pooled<T extends Capacity>(caps: T[]): T[] {
  const best = new Map<string, T>();
  for (const c of caps) {
    const key = `${c.provider}|${c.window}`;
    const cur = best.get(key);
    if (!cur || c.used > cur.used) best.set(key, c);
  }
  return [...best.values()].sort(
    (a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : windowHours(a.window) - windowHours(b.window)),
  );
}

// ------------------------------------------------------------ session context

export type Ask = Extract<TimelineItem, { k: "ask" }>;

export interface TodoProgress {
  done: number;
  total: number;
  /** the task in progress (or the next open one) */
  current?: string;
}

/** What a session is about right now – enough to be back in context at a glance. */
export interface SessionContext {
  /** omp's session title */
  title?: string;
  branch?: string;
  folder?: string;
  dirty?: number;
  model?: string;
  todo?: TodoProgress;
  /** what it does this moment: the running tool's intent, else the TODO task in progress */
  step?: string;
  /** the agent's last words (plain text) */
  last?: string;
  /** omp's open question */
  ask?: Ask;
  running: boolean;
  /** when the running turn started (ms) */
  turnStartedAt?: number;
  /** background jobs */
  jobs: number;
}

const closed = (s: string) => s === "completed" || s === "abandoned";

/** Done/total over all phases; nothing once omp cleared the list (everything closed). */
export function todoProgress(todo?: TodoPhase[]): TodoProgress | undefined {
  const tasks = (todo ?? []).flatMap((p) => p.tasks);
  if (!tasks.length || tasks.every((x) => closed(x.status))) return undefined;
  const current = tasks.find((x) => x.status === "in_progress") ?? tasks.find((x) => !closed(x.status));
  return { done: tasks.filter((x) => x.status === "completed").length, total: tasks.length, current: current?.content };
}

/** omp: everything from its timeline. */
export function contextFromTimeline(tl: Timeline): SessionContext {
  const todo = todoProgress(tl.todo);
  const ask = tl.items.findLast((i): i is Ask => i.k === "ask" && !!i.pending);
  const text = tl.items.findLast((i) => i.k === "text");
  const running = !!tl.running;
  return {
    title: cleanTitle(tl.title),
    branch: tl.line?.branch,
    folder: tl.line?.folder,
    dirty: tl.line?.dirty,
    model: tl.line?.model ?? tl.model,
    todo,
    step: running ? (workingLabel(tl) ?? todo?.current) : undefined,
    last: text?.k === "text" ? plain(text.text, 320) || undefined : undefined,
    ask,
    running,
    turnStartedAt: running ? tl.turnStartedAt : undefined,
    jobs: tl.jobs?.length ?? 0,
  };
}

/** Other agents: the session log's last answer and, while working, the latest tool's intent. */
export function contextFromHistory(events: HistoryEvent[], working: boolean): SessionContext {
  const answer = events.findLast((e) => e.t === "answer");
  const tool = events.at(-1);
  return {
    last: answer?.t === "answer" ? plain(answer.text, 320) || undefined : undefined,
    step: working && tool?.t === "tool" ? (tool.intent ?? tool.name) : undefined,
    running: working,
    jobs: 0,
  };
}

// ------------------------------------------------------------ projects

export interface Project {
  /** "serverId|name" */
  key: string;
  name: string;
  branch?: string;
  worktree: boolean;
  /** the space's checkout (for git and ports) */
  root?: string;
  dirty?: number;
}

/** A session's project: its space's repo (worktrees of one repo group together), else its folder. */
export function projectOf(
  server: string,
  ws: { id: string; label: string },
  cwd: string,
  spaces: Space[] | undefined,
  ctx?: SessionContext,
): Project {
  const space = spaces?.find((s) => s.id === ws.id);
  const root = space?.root || cwd || undefined;
  const name = space?.repo || (root ? root.replace(/\/+$/, "").split("/").pop() || root : ws.label);
  return {
    key: `${server}|${name}`,
    name,
    branch: space?.git?.branch ?? ctx?.branch,
    worktree: !!space?.isWorktree,
    root,
    dirty: space?.git?.dirty ?? ctx?.dirty,
  };
}

/** Web ports served from inside `root` (a dev server the session started). */
export const portsIn = (root: string | undefined, ports: WebPort[] | undefined): WebPort[] =>
  !root ? [] : (ports ?? []).filter((p) => !!p.cwd && (p.cwd === root || p.cwd.startsWith(`${root.replace(/\/+$/, "")}/`)));

// ------------------------------------------------------------ urgency

/** inbox kinds plus "long": a turn that runs for a while (worth a look) */
export type FocusKind = InboxKind | "long";

/** a turn counts as long-running after this */
export const LONG_MS = 10 * 60_000;

export const isLong = (ctx: SessionContext | undefined, now: number) =>
  !!ctx?.running && !!ctx.turnStartedAt && now - ctx.turnStartedAt >= LONG_MS;

const URGENCY: Record<FocusKind, number> = { ask: 0, waiting: 0, done: 1, error: 2, long: 3 };

/**
 * What needs you first: questions and waiting agents (longest waiting on top), then finished ones you haven't
 * seen (newest on top), then errors (newest on top), then long-running turns (longest on top).
 */
export function byUrgency(a: { kind: FocusKind; since: number }, b: { kind: FocusKind; since: number }): number {
  const d = URGENCY[a.kind] - URGENCY[b.kind];
  if (d) return d;
  return a.kind === "done" || a.kind === "error" ? b.since - a.since : a.since - b.since;
}

/** FNV-1a over the lowercased name → one of eight hues (Theme.identity): a project keeps its color everywhere. */
export function identityHue(name: string): number {
  const hues = [0.58, 0.76, 0.93, 0.03, 0.09, 0.14, 0.36, 0.47];
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(name.toLowerCase())) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hues[Number(hash % BigInt(hues.length))]! * 360;
}

export const identityColor = (name: string) => `hsl(${identityHue(name)} 60% 62%)`;
