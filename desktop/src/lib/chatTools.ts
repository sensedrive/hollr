// Pure helpers behind the chat's tool cards (components/chat/*): which calls show, how they group,
// diff rows, todo snapshots, grep hits. No DOM / Svelte / Tauri imports, so `bun test` covers them and
// TimelineView can derive everything once per timeline instead of on every render.
import type { DiffHunk, DiffLine, Timeline, TimelineItem, TodoPhase, TodoTask, ToolCall } from "./api";

// ------------------------------------------------------------ visible items & groups

/** Consecutive reads merge into one tree, consecutive todo updates into one card, the rest stand alone. */
export type Piece =
  | { kind: "reads"; id: string; calls: ToolCall[] }
  | { kind: "todo"; id: string; calls: ToolCall[] }
  | { kind: "call"; id: string; call: ToolCall };

/** Where a todo card sits in the session's todo history. */
export interface TodoMark {
  /** state before this card's first update (undefined: first one in view) */
  prev?: TodoPhase[];
  /** the newest todo state of the timeline – shown in full, older ones fold to one line */
  latest: boolean;
}

export interface ChatView {
  items: TimelineItem[];
  /** tools item id → its pieces */
  pieces: Map<string, Piece[]>;
  /** todo piece id → its place in the history */
  todo: Map<string, TodoMark>;
}

/**
 * The timeline as the chat shows it. Todo calls carry the full state after the call (`todo`): they show only
 * when that state changed; calls without it (older servers) stay hidden like before – the HUD has the list.
 * Failed todo calls without a state still show, so the error isn't swallowed.
 */
export function chatView(all: TimelineItem[]): ChatView {
  const items: TimelineItem[] = [];
  const pieces = new Map<string, Piece[]>();
  const todo = new Map<string, TodoMark>();
  let last: TodoPhase[] | undefined;
  let lastKey = "";
  let latestId: string | undefined;
  for (const item of all) {
    if (item.k !== "tools") {
      items.push(item);
      continue;
    }
    const out: Piece[] = [];
    for (const c of item.calls) {
      if (c.name === "todo" && c.todo) {
        const key = JSON.stringify(c.todo);
        if (key === lastKey) continue;
        const run = out.at(-1);
        if (run?.kind === "todo") run.calls.push(c);
        else {
          const id = `t-${c.id}`;
          out.push({ kind: "todo", id, calls: [c] });
          todo.set(id, { prev: last, latest: false });
          latestId = id;
        }
        last = c.todo;
        lastKey = key;
        continue;
      }
      if (c.name === "todo" && c.status !== "error") continue;
      const prev = out.at(-1);
      if (c.name === "read" && prev?.kind === "reads") prev.calls.push(c);
      else if (c.name === "read") out.push({ kind: "reads", id: `r-${c.id}`, calls: [c] });
      else out.push({ kind: "call", id: c.id, call: c });
    }
    if (!out.length) continue;
    pieces.set(item.id, out);
    items.push(item);
  }
  const newest = latestId && todo.get(latestId);
  if (newest) newest.latest = true;
  return { items, pieces, todo };
}

/** Which card renders a call. */
export type CardKind = "bash" | "edit" | "search" | "task" | "links" | "wait" | "compact" | "generic";
export function cardKind(c: ToolCall): CardKind {
  const n = c.name;
  if (n === "bash" || n === "eval") return "bash";
  if (n === "edit" || n === "write" || c.diff) return "edit";
  if (n === "grep" || n === "glob" || n === "find" || n === "ls") return "search";
  if (n === "task") return "task";
  if (n === "web_search" || n === "fetch") return "links";
  if (n === "wait") return "wait";
  if (n === "todo" || n.startsWith("mcp__")) return "compact";
  return "generic";
}

/** Hover text: the agent's own tool name (Claude "MultiEdit" behind "edit"), the intent, the duration. */
export function toolTip(c: ToolCall, duration: (ms: number) => string): string {
  return [c.tool && c.tool.toLowerCase() !== c.name ? c.tool : "", c.label, c.ms !== undefined ? duration(c.ms) : ""]
    .filter(Boolean)
    .join(" · ");
}

// ------------------------------------------------------------ paths

/** macOS: /tmp is /private/tmp – logs and herdr use either spelling. */
const canon = (p: string) => p.replace(/^\/private(?=\/(tmp|var)\/)/, "").replace(/(.)\/+$/, "$1");

/** `p` relative to the space folder, "." for the folder itself; undefined when it lies outside (or no root). */
export function underRoot(p: string, root?: string): string | undefined {
  if (!root || !p.startsWith("/")) return undefined;
  const r = canon(root);
  const q = canon(p);
  if (q === r) return ".";
  return q.startsWith(`${r}/`) ? q.slice(r.length + 1) : undefined;
}

/** A grep/glob scope: omp takes several paths separated by ";" – one entry each (commas stay: brace globs). */
export const searchScopes = (path?: string): string[] =>
  (path ?? "").split(/[;\n]/).map((s) => s.trim()).filter(Boolean);

/**
 * Where a shell call ran, when that is not the space folder: relative to the space when under it, else `short(path)`
 * (home as ~); a relative argument resolves against the space folder first (omp's `cwd: "../x"`). Undefined for the
 * space folder itself (and without a cwd).
 */
export function cwdShown(cwd: string | undefined, root: string | undefined, short: (p: string) => string): string | undefined {
  const c = cwd?.trim().replace(/(.)\/+$/, "$1");
  if (!c || c === "." || c === "./") return undefined;
  if (!c.startsWith("/") && !root) return c;
  const abs = c.startsWith("/") ? c : resolvePath(`${root}/${c}`);
  const r = underRoot(abs, root);
  if (r === ".") return undefined;
  return r ?? short(abs);
}

/** `/a/b/../c/./d` → `/a/c/d` (absolute paths only; ".." never climbs above "/"). */
function resolvePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

// ------------------------------------------------------------ diffs

/** a diff line, a gap between hunks, or a file header (multi-file edits: where the hunk's file changes) */
export type DiffRow = DiffLine | { gap: true } | { file: string };

/** Hunks as one row list: a file row where the file changes, a gap row between hunks that don't touch. */
export function diffRows(hunks: DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let file: string | undefined;
  let lastO: number | undefined;
  let lastN: number | undefined;
  for (const h of hunks) {
    const first = h.lines[0];
    if (!first) continue;
    if (h.file !== undefined && h.file !== file) {
      file = h.file;
      rows.push({ file });
      lastO = lastN = undefined;
    }
    const touches =
      (first.n !== undefined && lastN !== undefined && first.n <= lastN + 1) ||
      (first.o !== undefined && lastO !== undefined && first.o <= lastO + 1);
    const started = lastO !== undefined || lastN !== undefined;
    if (started && !touches) rows.push({ gap: true });
    for (const l of h.lines) {
      rows.push(l);
      if (l.o !== undefined) lastO = l.o;
      if (l.n !== undefined) lastN = l.n;
    }
  }
  return rows;
}

/** Widest line number, for the gutter width. */
export const gutterDigits = (rows: DiffRow[]) =>
  String(Math.max(1, ...rows.map((r) => ("t" in r ? Math.max(r.o ?? 0, r.n ?? 0) : 0)))).length;

/**
 * Rows to show: everything when open, otherwise the first `preview` rows. A diff of at most `small` rows starts
 * open. `hidden` = diff lines (not gap/file rows) left out.
 */
export function diffSlice(rows: DiffRow[], open: boolean | undefined, small = 30, preview = 12) {
  const isOpen = open ?? rows.length <= small;
  const shown = isOpen ? rows : rows.slice(0, preview);
  const hidden = isOpen ? 0 : rows.slice(preview).filter((r) => "t" in r).length;
  return { isOpen, shown, hidden, foldable: rows.length > preview };
}

/** read's `range` ("1-63/513", "/total" only when known); `whole` = the entire file was read. */
export function parseRange(range: string): { from: number; to: number; total?: number; whole: boolean } | undefined {
  const m = range.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
  if (!m) return undefined;
  const [from, to, total] = [Number(m[1]), Number(m[2]), m[3] === undefined ? undefined : Number(m[3])];
  return { from, to, total, whole: from === 1 && total !== undefined && to >= total };
}

// ------------------------------------------------------------ todo

export function todoCounts(phases: TodoPhase[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const p of phases)
    for (const x of p.tasks) {
      total++;
      if (x.status === "completed") done++;
    }
  return { done, total };
}

/** Tasks that are new or changed status since `prev` (none for the first snapshot in view). */
export function todoChanges(prev: TodoPhase[] | undefined, next: TodoPhase[]): TodoTask[] {
  if (!prev) return [];
  const before = new Map(prev.flatMap((p) => p.tasks.map((x) => [`${p.name}\u0000${x.content}`, x.status] as const)));
  return next.flatMap((p) => p.tasks.filter((x) => before.get(`${p.name}\u0000${x.content}`) !== x.status));
}

/** omp folds finished phases; we do too, unless one of their tasks just changed (so you see what got ticked). */
export const phaseFolded = (p: TodoPhase, changed: TodoTask[]) =>
  p.tasks.length > 0 &&
  p.tasks.every((x) => x.status === "completed" || x.status === "abandoned") &&
  !p.tasks.some((x) => changed.includes(x));

// ------------------------------------------------------------ grep

export type Seg = { s: string; hit?: boolean };

/** `text` split around matches of the grep pattern (case-insensitive; an invalid regex matches literally). */
export function markHits(text: string, pattern?: string): Seg[] {
  if (!pattern) return [{ s: text }];
  let re: RegExp;
  try {
    re = new RegExp(pattern, "gi");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }
  const out: Seg[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) break; // zero-width pattern (e.g. "^"): nothing useful to mark
    const i = m.index ?? 0;
    if (i > at) out.push({ s: text.slice(at, i) });
    out.push({ s: m[0], hit: true });
    at = i + m[0].length;
  }
  if (at < text.length || !out.length) out.push({ s: text.slice(at) });
  return out;
}

// ------------------------------------------------------------ bash

/** Output to show: the last `n` lines collapsed, all sent lines open; `earlier` = lines above them. */
export function outTail(c: Pick<ToolCall, "out" | "outTotal">, open: boolean, n = 8) {
  const out = c.out ?? [];
  const lines = open ? out : out.slice(-n);
  const total = Math.max(c.outTotal ?? out.length, out.length);
  return { lines, earlier: total - lines.length, more: out.length - lines.length, total };
}

/**
 * A shell command as one short line for tight spots (HUD, chips): first line, `sh -c '…'` unwrapped, a leading
 * `cd … &&` and env assignments dropped, cut at the first `&&` / `;` / `|` / redirect ("…" marks the cut).
 */
export function shortCommand(cmd: string, max = 72): string {
  const lines = cmd.trim().split("\n");
  let s = lines[0]?.trim() ?? "";
  let cut = lines.length > 1;
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-[a-z]*c\s+(['"])(.*)$/.exec(s);
  if (wrapped) s = wrapped[2]!.replace(new RegExp(`${wrapped[1]}\\s*$`), "");
  s = s.replace(/^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*/, "");
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, "");
  const stop = /\s(?:&&|\|\||\||[0-9&]?>{1,2}|<)|;(?:\s|$)/.exec(s);
  if (stop) {
    s = s.slice(0, stop.index);
    cut = true;
  }
  s = s.trim();
  if (s.length > max) return `${s.slice(0, max - 1).trimEnd()}…`;
  return cut ? `${s} …` : s;
}

// ------------------------------------------------------------ background jobs & waits

/** The call that started each background job (its `bg` id) – a later start under the same id wins. */
export function jobCalls(items: TimelineItem[]): Map<string, ToolCall> {
  const out = new Map<string, ToolCall>();
  for (const i of items) if (i.k === "tools") for (const c of i.calls) if (c.bg) out.set(c.bg, c);
  return out;
}

/** A background job as the chat shows it: what it does (the starting call's intent), its command short and full. */
export interface JobView {
  id: string;
  title: string;
  /** short command, when the job is a shell command and it says more than the title */
  command?: string;
  /** full command (tooltip) */
  full?: string;
  startedAt?: number;
}

/** `id`/`label` of a job (running, or reported by a wait) with what its starting call tells about it. */
export function jobView(job: { id: string; label?: string; startedAt?: number }, call?: ToolCall): JobView {
  const intent = call?.label && call.label !== call.name ? call.label : undefined;
  const shell = call?.name === "bash" || call?.name === "eval";
  const full = shell ? call?.detail : undefined;
  const label = job.label && job.label !== job.id ? job.label : undefined;
  const title = intent ?? (label && !full ? label : undefined) ?? (full ? shortCommand(full) : (label ?? job.id));
  const command = full ? shortCommand(full) : undefined;
  return {
    id: job.id,
    title,
    command: command && command !== title ? command : undefined,
    full: full ?? label,
    startedAt: job.startedAt,
  };
}

/** The running jobs with their intents. */
export const jobViews = (tl: Pick<Timeline, "jobs" | "items">, calls = jobCalls(tl.items)): JobView[] =>
  tl.jobs.map((j) => jobView(j, calls.get(j.id)));

/** How a wait's job ended: done, failed, or still running when the wait returned (timeout). */
export function jobOutcome(status: string): "done" | "failed" | "running" {
  const s = status.toLowerCase();
  if (s === "running" || s === "pending" || s === "queued") return "running";
  if (s === "completed" || s === "done" || s === "exited" || s === "ok" || s === "success") return "done";
  return "failed";
}

const JOB_DONE = "Hintergrund-Job fertig: ";
/**
 * The server's "Hintergrund-Job fertig: <omp label>" info (the label is the clipped command) with the intents of the
 * jobs it names, found by their command; undefined when it is no such info or names no known job.
 */
export function finishedJobs(text: string, calls: Map<string, ToolCall>): string[] | undefined {
  if (!text.startsWith(JOB_DONE)) return undefined;
  const names = text.slice(JOB_DONE.length);
  const found = new Set<string>();
  for (const c of calls.values()) {
    const head = (c.detail ?? "").split("\n")[0]!.trim().slice(0, 60);
    if (head.length >= 4 && names.includes(head) && c.label && c.label !== c.name) found.add(c.label);
  }
  return found.size ? [...found] : undefined;
}
