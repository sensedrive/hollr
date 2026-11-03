/**
 * Turns an omp session JSONL into a compact, render-ready timeline for the phone:
 * turns, grouped tool calls (with status, duration, diff stats), thinking, answers,
 * questions, the current todo list and running background jobs.
 */
import { existsSync, readFileSync, statSync } from "node:fs";

export type ToolStatus = "running" | "ok" | "error";

/** One line of a diff hunk: " " context, "+" added, "-" removed; `o`/`n` = old/new line number. */
export interface DiffLine {
  t: " " | "+" | "-";
  o?: number;
  n?: number;
  text: string;
}

export interface DiffHunk {
  lines: DiffLine[];
  /** the file of this hunk when one call changed several files (omp multi-file edit) */
  file?: string;
}

/** One file's grep matches: line number + text (clipped to 300 chars). */
export interface MatchFile {
  file: string;
  lines: Array<{ n: number; text: string }>;
}

/** Caps of the rich tool data – the app polls/streams the timeline, so every call must stay small. */
export const RICH_CAPS = {
  diffLines: 400,
  /** a written file is shown whole only when small – its head otherwise (writes were the biggest
   *  share of a timeline at 400 lines: whole generated files nobody reads in the chat) */
  writeLines: 120,
  matchFiles: 20,
  matchLines: 8,
  matchText: 300,
  files: 50,
  links: 10,
  subAnswer: 4000,
  outLines: 60,
  outLineChars: 240,
} as const;

export interface ToolCall {
  id: string;
  /** canonical lower-case tool name (see chat contract) */
  name: string;
  /** what the agent says it is doing (omp's `intent`) */
  label: string;
  /** short argument summary: path, command, pattern … */
  detail?: string;
  status: ToolStatus;
  ms?: number;
  add?: number;
  del?: number;
  /** short result preview (errors, match counts …) */
  result?: string;
  /** last output lines (bash/eval, at most 60), like omp's output pane */
  out?: string[];
  /** total output line count */
  outTotal?: number;
  /** exit code when non-zero */
  exit?: number;
  /** search scope (grep/glob) */
  path?: string;
  /** background job id when the call was backgrounded */
  bg?: string;
  /** edit/write: the change as hunks with context (whole new file for small creates);
   *  at most 400 diff lines over all hunks, then `diffMore` = how many lines were left out */
  diff?: DiffHunk[];
  diffMore?: number;
  /** edit/write/read: absolute or space-relative file path (`detail` may be shortened) */
  file?: string;
  /** grep: matches per file, at most 20 files × 8 lines; `result` keeps the count summary */
  matches?: MatchFile[];
  /** glob/find/ls: found paths, at most 50 */
  files?: string[];
  /** read: line range read, "start-end" plus "/total" when the file's line count is known ("12-80/993") */
  range?: string;
  /** todo calls: the full todo state right after this call (same shape as Timeline.todo) */
  todo?: TodoPhase[];
  /** web_search / fetch: result links, at most 10 */
  links?: Array<{ title: string; url: string }>;
  /** subagent (task/agent): final answer (markdown, ≤4000 chars), its tool call count, agent type */
  sub?: { answer?: string; calls?: number; agent?: string };
  /** the agent's original tool name when `name` was mapped to a canonical one (Claude "MultiEdit" → "edit") */
  tool?: string;
}

/** `at`: epoch ms of the log entry the item comes from (the user's prompt, the assistant message the
 *  text/thinking/tool calls arrived with, the turn's final answer) – absent when the entry had none. */
export type TimelineItem =
  | {
      k: "user";
      id: string;
      text: string;
      source: "typed" | "voice" | "skill" | "agent";
      at: number;
    }
  | { k: "thinking"; id: string; text: string; at?: number }
  | { k: "text"; id: string; text: string; at?: number }
  | { k: "tools"; id: string; calls: ToolCall[]; at?: number }
  | ({
      k: "ask";
      id: string;
      answer?: string;
      pending: boolean;
      /** every question when omp asks several at once (the question fields here are the first one) */
      questions?: AskQuestion[];
      at?: number;
    } & AskQuestion)
  | { k: "end"; id: string; ms: number; status: "done" | "aborted" | "error"; error?: string; at?: number }
  | { k: "info"; id: string; text: string; at?: number };

/** One question of omp's ask dialog. */
export interface AskQuestion {
  question: string;
  options: string[];
  /** omp's short title ("Rebase") */
  header?: string;
  /** one per option ("" = none) */
  descriptions?: string[];
  /** index of omp's recommended option (shown as "(Recommended)" in the TUI) */
  recommended?: number;
  /** several options can be picked (Space toggles in the TUI) */
  multi?: boolean;
}

export interface TodoPhase {
  name: string;
  tasks: Array<{ content: string; status: string; blocker?: string }>;
}

export interface Job {
  id: string;
  type: string;
  label: string;
  startedAt: number;
}

export interface Timeline {
  title?: string;
  items: TimelineItem[];
  todo?: TodoPhase[];
  jobs: Job[];
  /** agent is mid-turn (last assistant asked for tools, or a tool is running) */
  running: boolean;
  /** an open `wait` on background jobs */
  waiting: boolean;
  turnStartedAt?: number;
  model?: string;
  /** which agent's log the timeline came from */
  agent?: "omp" | "claude";
}

type Block = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  intent?: string;
};
type Entry = {
  type?: string;
  id?: string;
  timestamp?: string;
  customType?: string;
  title?: string;
  data?: Record<string, unknown> | string;
  content?: unknown;
  display?: boolean;
  details?: Record<string, unknown>;
  model?: string;
  message?: {
    role?: string;
    content?: string | Block[];
    stopReason?: string;
    errorMessage?: string;
    timestamp?: number;
    completedAt?: number;
    steering?: boolean;
    toolCallId?: string;
    toolName?: string;
    details?: Record<string, unknown>;
    isError?: boolean;
    retryRecovery?: { status?: string };
  };
};

const SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

export function redact(text: string): string {
  return text.replace(SECRET_RE, "•••");
}

/** Trims, redacts and shortens a text to `max` chars (with "…"). */
export function clip(text: string, max: number): string {
  const t = redact(text.trim());
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((b) => b?.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n");
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A real file, not a URL or an omp device/message target (`agent://`, `xd://`, `https://`);
 *  `local://` is omp's session scratch folder, so it counts as a file. */
function isFilePath(path: string): boolean {
  return path.startsWith("local://") || !/^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

/** One-line description of a tool call's arguments. */
export function toolDetail(name: string, args: Record<string, unknown> = {}): string | undefined {
  const a = args;
  switch (name) {
    case "read":
    case "write":
      return str(a.path);
    case "edit": {
      const input = str(a.input);
      return str(a.path) ?? input?.match(/^\[([^#\]]+)#/)?.[1];
    }
    case "bash":
      return clip(str(a.command) ?? "", 400) || undefined;
    case "grep":
      return str(a.pattern);
    case "glob":
      return str(a.path) ?? str(a.pattern);
    case "web_search":
      return str(a.query);
    case "eval":
      return str(a.title) ?? str(a.language);
    case "task": {
      const tasks = Array.isArray(a.tasks) ? (a.tasks as Array<{ name?: string }>) : [];
      return (
        tasks
          .map((t) => t.name)
          .filter(Boolean)
          .join(", ") || undefined
      );
    }
    case "todo":
      return [str(a.op), str(a.task) ?? str(a.phase)].filter(Boolean).join(" · ");
    default: {
      const first = Object.entries(a).find(([k, v]) => k !== "i" && typeof v === "string");
      return first ? String(first[1]) : undefined;
    }
  }
}

function diffStats(diff: unknown): { add?: number; del?: number } {
  if (typeof diff !== "string") return {};
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return add || del ? { add, del } : {};
}

/** Longest diff line text sent – keeps minified one-liners from blowing up the timeline. */
const DIFF_TEXT_MAX = 400;

/** Applies the 400-line budget over all hunks (redacting and shortening each line);
 *  `diffMore` counts the lines left out. Both parsers use it so the cap is the same everywhere. */
export function capDiff(hunks: DiffHunk[], alreadyLeftOut = 0): { diff?: DiffHunk[]; diffMore?: number } {
  let left: number = RICH_CAPS.diffLines;
  let more = alreadyLeftOut;
  const diff: DiffHunk[] = [];
  for (const h of hunks) {
    const take = Math.min(left, h.lines.length);
    more += h.lines.length - take;
    left -= take;
    if (!take) continue;
    const lines = h.lines.slice(0, take).map((l) => ({ ...l, text: redact(l.text).slice(0, DIFF_TEXT_MAX) }));
    diff.push(h.file ? { file: h.file, lines } : { lines });
  }
  if (!diff.length) return {};
  return more ? { diff, diffMore: more } : { diff };
}

/** omp's compact diff line: marker, line number, "|", text ("-24|old", "+24|new", " 25|context"). */
const OMP_DIFF_RE = /^([ +-])\s*(\d+)\|(.*)$/;

/** Parses omp's edit diff into hunks. Hunks are separated by blank lines. omp numbers "-" and context
 *  lines with the OLD line and "+" lines with the NEW one, so a context line's new number is its old one
 *  shifted by the lines added/removed above it. */
export function ompDiffHunks(diff: string, file?: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | undefined;
  let shift = 0;
  for (const raw of diff.split("\n")) {
    const m = OMP_DIFF_RE.exec(raw);
    if (!m) {
      cur = undefined;
      continue;
    }
    if (!cur) {
      cur = file ? { file, lines: [] } : { lines: [] };
      hunks.push(cur);
    }
    const num = Number(m[2]);
    const text = m[3] ?? "";
    if (m[1] === "+") {
      cur.lines.push({ t: "+", n: num, text });
      shift++;
    } else if (m[1] === "-") {
      cur.lines.push({ t: "-", o: num, text });
      shift--;
    } else cur.lines.push({ t: " ", o: num, n: num + shift, text });
  }
  return hunks;
}

/** A written file as one all-added hunk; only the first lines are even split into objects. */
function writeDiff(content: string): { diff?: DiffHunk[]; diffMore?: number } {
  const all = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const kept = all.slice(0, RICH_CAPS.writeLines);
  const lines = kept.map((text, i): DiffLine => ({ t: "+", n: i + 1, text }));
  return capDiff([{ lines }], all.length - kept.length);
}

/** grep line in omp's display: "*" marks a match, the rest is context ("*23│text", " 24│text"). */
const OMP_GREP_RE = /^\s*(\*)?\s*(\d+)[│:](.*)$/;
/** omp's per-file hash tag after a grep file header ("# inventory.py#706F"). */
const OMP_TAG_RE = /#[0-9A-Z]{4}$/;

/** Matches per file from omp's grep output. Files are "#" headers, nested by depth under directory
 *  headers ending in "/" ("# .do/", "## app.stage.yaml"); a single-file search has no header. */
export function ompGrepMatches(display: string, singleFile?: string): MatchFile[] {
  const out: MatchFile[] = [];
  const dirs: string[] = [];
  let cur: MatchFile | undefined;
  let full = false;
  for (const raw of display.split("\n")) {
    const head = /^(#+) (.+)$/.exec(raw);
    if (head) {
      const depth = head[1]?.length ?? 1;
      const name = (head[2] ?? "").replace(OMP_TAG_RE, "");
      dirs.length = depth - 1;
      if (name.endsWith("/")) {
        dirs.push(name);
        cur = undefined;
      } else {
        cur = undefined;
        if (out.length >= RICH_CAPS.matchFiles) {
          full = true;
          continue;
        }
        cur = { file: dirs.join("") + name, lines: [] };
        out.push(cur);
      }
      continue;
    }
    const m = OMP_GREP_RE.exec(raw);
    if (!m?.[1]) continue;
    if (!cur && !full && !out.length && singleFile) {
      cur = { file: singleFile, lines: [] };
      out.push(cur);
    }
    if (!cur || cur.lines.length >= RICH_CAPS.matchLines) continue;
    cur.lines.push({ n: Number(m[2]), text: redact(m[3] ?? "").trimEnd().slice(0, RICH_CAPS.matchText) });
  }
  return out.filter((f) => f.lines.length);
}

/** The todo state of a todo tool result, shortened like Timeline.todo. */
function todoPhases(phases: unknown): TodoPhase[] | undefined {
  if (!Array.isArray(phases)) return undefined;
  return (phases as TodoPhase[]).map((p) => ({
    name: p.name,
    tasks: (p.tasks ?? []).map((t) => ({
      content: clip(t.content, 200),
      status: t.status,
      blocker: t.blocker,
    })),
  }));
}

/** A subagent's report inside a wait result or async delivery:
 *  `<task-result id="X" agent="scout" …><meta …/><preview …>answer</preview></task-result>`. */
const TASK_RESULT_RE = /<task-result id="([^"]+)"([^>]*)>([\s\S]*?)<\/task-result>/g;

function taskResults(text: string): Array<{ id: string; agent?: string; answer: string }> {
  const out: Array<{ id: string; agent?: string; answer: string }> = [];
  for (const m of text.matchAll(TASK_RESULT_RE)) {
    const body = m[3] ?? "";
    const preview = /<preview[^>]*>([\s\S]*?)<\/preview>/.exec(body)?.[1];
    const answer = (preview ?? body.replace(/<meta[^>]*\/>/g, "")).trim();
    out.push({ id: m[1] ?? "", agent: /\bagent="([^"]*)"/.exec(m[2] ?? "")?.[1], answer });
  }
  return out;
}

/** `ToolCall.sub` of a task call from its subagents' reports (several agents: one section each). */
function subOf(
  agents: Map<string, { agent?: string; answer?: string }>,
  calls: number | undefined,
): NonNullable<ToolCall["sub"]> {
  const list = [...agents];
  const answers = list.filter(([, a]) => a.answer);
  const answer =
    list.length === 1
      ? answers[0]?.[1].answer
      : answers.map(([id, a]) => `**${id}**\n\n${a.answer}`).join("\n\n") || undefined;
  const types = new Set(list.map(([, a]) => a.agent));
  const agent = types.size === 1 ? [...types][0] : undefined;
  return {
    ...(answer ? { answer: clip(answer, RICH_CAPS.subAnswer) } : {}),
    ...(calls !== undefined ? { calls } : {}),
    ...(agent ? { agent } : {}),
  };
}

function resultPreview(
  name: string,
  details: Record<string, unknown> | undefined,
  content: unknown,
  isError: boolean,
): string | undefined {
  const d = details ?? {};
  if (isError) return clip(textOf(content) || "Fehler", 160);
  if (name === "grep" && typeof d.matchCount === "number")
    return `${d.matchCount} Treffer in ${d.fileCount ?? "?"} Dateien`;
  if (name === "glob" && typeof d.fileCount === "number") return `${d.fileCount} Dateien`;
  if (name === "bash") {
    const exit = typeof d.exitCode === "number" ? d.exitCode : undefined;
    const out = textOf(content).trim().split("\n").slice(-2).join(" ⏎ ");
    if (exit && exit !== 0) return clip(`Exit ${exit}: ${out}`, 160);
    return out ? clip(out, 120) : undefined;
  }
  return undefined;
}

const TERMINAL_JOB = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "killed",
  "exited",
  "done",
]);

/** Optional lookups outside the main log. `subCalls`: tool calls a subagent made so far (from its own log). */
export interface TimelineOptions {
  subCalls?: (agentId: string) => number | undefined;
}

/** Builds the timeline from the raw JSONL text. `maxItems` limits the returned history. */
export function buildTimeline(jsonl: string, maxItems = 150, opts: TimelineOptions = {}): Timeline {
  const items: TimelineItem[] = [];
  const calls = new Map<string, ToolCall>();
  const starts = new Map<string, number>();
  const jobs = new Map<string, Job>();
  /** write calls' content until their result says whether the write happened */
  const writes = new Map<string, string>();
  /** task calls: their subagents (id → type, answer) and which call each subagent belongs to */
  const subAgents = new Map<string, Map<string, { agent?: string; answer?: string }>>();
  const subCall = new Map<string, string>();
  const noteTaskResults = (text: string) => {
    if (!text.includes("<task-result")) return;
    for (const r of taskResults(text)) {
      const agents = subAgents.get(subCall.get(r.id) ?? "");
      const a = agents?.get(r.id);
      if (!a) continue;
      a.answer = r.answer || a.answer;
      a.agent = r.agent ?? a.agent;
    }
  };
  /** Fills the rich tool data of a successful call from omp's result details. */
  const richResult = (call: ToolCall, d: Record<string, unknown>, content: unknown) => {
    switch (call.name) {
      case "edit": {
        // a multi-file edit: the combined `diff` runs the files together, the per-file diffs keep them apart
        const perFile = Array.isArray(d.perFileResults)
          ? (d.perFileResults as Array<{ path?: unknown; diff?: unknown }>)
          : [];
        const path = str(d.path) ?? (perFile.length === 1 ? str(perFile[0]?.path) : undefined);
        if (path) call.file = path;
        const hunks =
          perFile.length > 1
            ? perFile.flatMap((f) => (typeof f.diff === "string" ? ompDiffHunks(f.diff, str(f.path)) : []))
            : typeof d.diff === "string"
              ? ompDiffHunks(d.diff)
              : [];
        Object.assign(call, capDiff(hunks));
        return;
      }
      case "write": {
        const path = str(d.resolvedPath);
        if (path && isFilePath(path)) call.file = path;
        const text = writes.get(call.id);
        if (text !== undefined && call.file) Object.assign(call, writeDiff(text));
        return;
      }
      case "read": {
        if (d.isDirectory || d.kind === "url") {
          // a directory listing or a fetched page: no file to open, no line range
          delete call.file;
          return;
        }
        const meta = d.meta as
          | { source?: { type?: string; value?: string }; truncation?: { shownRange?: { start?: number; end?: number } } }
          | undefined;
        if (meta?.source?.type === "path" && meta.source.value) call.file = meta.source.value;
        const shown = d.displayContent as { startLine?: number; lineNumbers?: number[] } | undefined;
        const start = shown?.startLine ?? meta?.truncation?.shownRange?.start;
        const end = shown?.lineNumbers?.at(-1) ?? meta?.truncation?.shownRange?.end;
        const total = typeof d.totalLines === "number" ? `/${d.totalLines}` : "";
        if (typeof start === "number" && typeof end === "number") call.range = `${start}-${end}${total}`;
        return;
      }
      case "grep": {
        const found = Array.isArray(d.files) ? (d.files as unknown[]) : [];
        const single = found.length === 1 ? str(found[0]) : undefined;
        const matches = ompGrepMatches(str(d.displayContent) ?? textOf(content), single);
        if (matches.length) call.matches = matches;
        return;
      }
      case "glob": {
        const files = (Array.isArray(d.files) ? (d.files as unknown[]) : []).filter(
          (f): f is string => typeof f === "string",
        );
        if (files.length) call.files = files.slice(0, RICH_CAPS.files);
        return;
      }
      case "web_search": {
        const sources = (d.response as { sources?: Array<{ title?: unknown; url?: unknown }> } | undefined)?.sources;
        const links = (Array.isArray(sources) ? sources : [])
          .filter((s) => typeof s?.url === "string")
          .slice(0, RICH_CAPS.links)
          .map((s) => ({ title: clip(str(s.title) || String(s.url), 200), url: String(s.url) }));
        if (links.length) call.links = links;
        return;
      }
      case "todo": {
        const phases = todoPhases(d.phases);
        if (phases) call.todo = phases;
        return;
      }
      case "task": {
        const progress = Array.isArray(d.progress) ? (d.progress as Array<{ id?: unknown; agent?: unknown }>) : [];
        const agents = new Map<string, { agent?: string; answer?: string }>();
        for (const p of progress) {
          const id = str(p.id);
          if (!id) continue;
          agents.set(id, { agent: str(p.agent) });
          subCall.set(id, call.id);
        }
        if (agents.size) subAgents.set(call.id, agents);
        return;
      }
    }
  };
  let todo: TodoPhase[] | undefined;
  let title: string | undefined;
  let model: string | undefined;
  let turnStart: number | undefined;
  let lastAssistantStop: string | undefined;
  let openWait = false;
  let currentGroup: Extract<TimelineItem, { k: "tools" }> | undefined;
  let lastFinal:
    | { id: string; at: number; status: "done" | "aborted" | "error"; error?: string }
    | undefined;
  let seq = 0;
  const nid = (base?: string) => base ?? `i${seq++}`;

  const closeTurn = () => {
    if (turnStart !== undefined && lastFinal) {
      items.push({
        k: "end",
        id: `end-${lastFinal.id}`,
        ms: Math.max(0, lastFinal.at - turnStart),
        status: lastFinal.status,
        error: lastFinal.error,
        at: lastFinal.at,
      });
    }
    lastFinal = undefined;
  };
  const startTurn = (at: number) => {
    closeTurn();
    turnStart = at;
    currentGroup = undefined;
  };
  const pushItem = (item: TimelineItem) => {
    if (item.k !== "tools") currentGroup = undefined;
    items.push(item);
  };

  for (const line of jsonl.split("\n")) {
    if (!line || line.length > 3_000_000) continue;
    let e: Entry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = e.timestamp ? Date.parse(e.timestamp) : Date.now();
    /** the entry's own time for `at` – never "now", so an unchanged item stays unchanged for follow */
    const ts = e.timestamp ? Date.parse(e.timestamp) || undefined : undefined;
    switch (e.type) {
      case "title":
        title = e.title || title;
        continue;
      case "model_change":
        model = e.model ?? model;
        continue;
      case "compaction":
        pushItem({ k: "info", id: nid(e.id), text: "Kontext wurde zusammengefasst", at: ts });
        continue;
      case "custom": {
        const data = (typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
        if (e.customType === "tool_execution_start") {
          const id = str(data.toolCallId);
          if (id) starts.set(id, Date.parse(str(data.startedAt) ?? "") || at);
          if (str(data.toolName) === "wait") openWait = true;
        }
        if (e.customType === "session_exit") jobs.clear();
        continue;
      }
      case "custom_message": {
        // a background subagent's report – also when omp does not show the delivery
        if (e.customType === "async-result") noteTaskResults(textOf(e.content));
        if (!e.display) continue;
        const text = textOf(e.content);
        if (e.customType === "live-delegation") {
          startTurn(at);
          pushItem({ k: "user", id: nid(e.id), text: clip(text, 4000), source: "voice", at });
        } else if (e.customType === "skill-prompt") {
          startTurn(at);
          const prompt = str(e.details?.prompt) ?? text;
          pushItem({ k: "user", id: nid(e.id), text: clip(prompt, 400), source: "skill", at });
        } else if (e.customType === "async-result") {
          const finished =
            (e.details?.jobs as Array<{ jobId?: string; label?: string; status?: string }>) ?? [];
          for (const j of finished) if (j.jobId) jobs.delete(j.jobId);
          const names = finished
            .map((j) => j.label ?? j.jobId)
            .filter(Boolean)
            .join(", ");
          pushItem({
            k: "info",
            id: nid(e.id),
            text: `Hintergrund-Job fertig: ${clip(names || "Job", 120)}`,
            at: ts,
          });
        } else if (e.customType === "irc:incoming") {
          const from = str(e.details?.from) ?? "Agent";
          pushItem({
            k: "info",
            id: nid(e.id),
            text: `Nachricht von ${from}: ${clip(str(e.details?.message) ?? text, 200)}`,
            at: ts,
          });
        }
        continue;
      }
      case "message":
        break;
      default:
        continue;
    }

    const m = e.message;
    if (!m) continue;
    if (m.role === "user") {
      const text = textOf(m.content).trim();
      if (!text || text.startsWith("<")) continue;
      if (!m.steering) startTurn(m.timestamp ?? at);
      pushItem({
        k: "user",
        id: nid(e.id),
        text: clip(text, 4000),
        source: m.steering ? "agent" : "typed",
        at: m.timestamp ?? at,
      });
      continue;
    }
    if (m.role === "assistant") {
      openWait = false;
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b.type === "thinking" && b.thinking?.trim()) {
          pushItem({ k: "thinking", id: nid(), text: clip(b.thinking, 1500), at: ts });
        } else if (b.type === "text" && b.text?.trim()) {
          pushItem({ k: "text", id: nid(), text: redact(b.text), at: ts });
        } else if (b.type === "toolCall" && b.id && b.name) {
          const args = (b.arguments ?? {}) as Record<string, unknown>;
          if (b.name === "ask") {
            const qs = Array.isArray(args.questions)
              ? (args.questions as Array<Parameters<typeof askQuestion>[0]>)
              : [];
            const questions = qs.map(askQuestion);
            const first = questions[0] ?? askQuestion(undefined);
            const call: ToolCall = {
              id: b.id,
              name: "ask",
              label: first.question,
              status: "running",
            };
            calls.set(b.id, call);
            pushItem({
              k: "ask",
              id: b.id,
              ...first,
              ...(questions.length > 1 ? { questions } : {}),
              pending: true,
              at: ts,
            });
            continue;
          }
          if (b.name === "wait") openWait = true;
          const call: ToolCall = {
            id: b.id,
            name: b.name,
            label: clip(b.intent ?? str(args.i) ?? b.name, 120),
            detail: (() => {
              const d = toolDetail(b.name, args);
              return d ? clip(d, b.name === "bash" ? 400 : 160) : undefined;
            })(),
            path: b.name === "grep" || b.name === "glob" ? str(args.path) : undefined,
            status: "running",
          };
          calls.set(b.id, call);
          if (b.name === "read" || b.name === "write" || b.name === "edit") {
            const file = b.name === "edit" ? toolDetail("edit", args) : str(args.path);
            if (file && isFilePath(file)) call.file = file;
          }
          if (b.name === "write" && typeof args.content === "string") writes.set(b.id, args.content);
          if (!currentGroup) {
            currentGroup = { k: "tools", id: `g-${b.id}`, calls: [], at: ts };
            items.push(currentGroup);
          }
          currentGroup.calls.push(call);
        }
      }
      lastAssistantStop = m.stopReason;
      // the agent kept working after an earlier stop (steering, async results) – that stop was not the end
      if (m.stopReason === "toolUse") lastFinal = undefined;
      if (
        m.stopReason === "stop" ||
        m.stopReason === "aborted" ||
        (m.stopReason === "error" && m.retryRecovery?.status !== "superseded")
      ) {
        lastFinal = {
          id: e.id ?? nid(),
          at: m.completedAt ?? ts ?? at,
          status:
            m.stopReason === "stop" ? "done" : m.stopReason === "aborted" ? "aborted" : "error",
          error: m.errorMessage ? clip(m.errorMessage, 200) : undefined,
        };
        currentGroup = undefined;
      }
      continue;
    }
    if (m.role === "toolResult" && m.toolCallId) {
      const call = calls.get(m.toolCallId);
      const details = m.details ?? {};
      const end = m.timestamp ?? at;
      if (call) {
        call.status = m.isError ? "error" : "ok";
        const started = starts.get(m.toolCallId);
        const wall = typeof details.wallTimeMs === "number" ? details.wallTimeMs : undefined;
        call.ms = wall ?? (started ? Math.max(0, end - started) : undefined);
        Object.assign(call, diffStats(details.diff));
        call.result = resultPreview(call.name, details, m.content, Boolean(m.isError));
        if (call.name === "bash" || call.name === "eval") {
          const text = textOf(m.content)
            .replace(/\n*Wall time: [\d.]+ seconds\s*$/, "")
            .replace(/\s+$/, "");
          const lines = text.split("\n");
          const async = (details.async as { state?: string } | undefined)?.state === "running";
          if (text && !async) {
            call.out = lines.slice(-RICH_CAPS.outLines).map((l) => redact(l).slice(0, RICH_CAPS.outLineChars));
            call.outTotal = lines.length;
          }
          if (typeof details.exitCode === "number" && details.exitCode !== 0)
            call.exit = details.exitCode;
        }
        const bg = details.async as { state?: string; jobId?: string } | undefined;
        if (bg?.jobId && bg.state === "running") {
          call.ms = undefined;
          call.result = `im Hintergrund · ${bg.jobId}`;
          call.bg = bg.jobId;
        }
        if (call.name === "ask") {
          const item = items.find((i) => i.k === "ask" && i.id === call.id) as
            | Extract<TimelineItem, { k: "ask" }>
            | undefined;
          if (item) {
            item.pending = false;
            const sel = (details.selectedOptions as string[] | undefined) ?? [];
            // several questions: omp reports one result per question
            const results = Array.isArray(details.results)
              ? (details.results as Array<{ selectedOptions?: string[]; customInput?: string }>)
              : [];
            item.answer = m.isError
              ? "abgebrochen"
              : clip(
                  (results.length > 1
                    ? results
                        .map((r) => [...(r.selectedOptions ?? []), str(r.customInput)].filter(Boolean).join(", "))
                        .filter(Boolean)
                        .join(" · ")
                    : [...sel, str(details.customInput)].filter(Boolean).join(", ")) ||
                    textOf(m.content),
                  300,
                );
          }
        }
        if (!m.isError) richResult(call, details, m.content);
        writes.delete(m.toolCallId);
      }
      if (m.toolName === "wait") {
        const waited = (details.jobs as Array<{ resultText?: string }> | undefined) ?? [];
        for (const j of waited) if (typeof j.resultText === "string") noteTaskResults(j.resultText);
      }
      // todo snapshot
      if (m.toolName === "todo" && !m.isError && Array.isArray(details.phases)) {
        todo = todoPhases(details.phases);
      }
      // background jobs
      const asyncInfo = details.async as
        | { state?: string; jobId?: string; type?: string }
        | undefined;
      if (asyncInfo?.jobId && asyncInfo.state === "running") {
        jobs.set(asyncInfo.jobId, {
          id: asyncInfo.jobId,
          type: asyncInfo.type ?? m.toolName ?? "job",
          label: call?.detail ?? call?.label ?? asyncInfo.jobId,
          startedAt: starts.get(m.toolCallId) ?? end,
        });
      }
      for (const j of (details.jobs as Array<{ id?: string; jobId?: string; status?: string }>) ??
        []) {
        const id = j.id ?? j.jobId;
        if (id && j.status && TERMINAL_JOB.has(j.status)) jobs.delete(id);
      }
    }
  }
  closeTurn();

  // jobs that never reported an end (crash, old sessions) – hide after a few hours
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.startedAt > 4 * 3600_000) jobs.delete(id);

  const lastItem = items.at(-1);
  const running =
    lastAssistantStop === "toolUse" ||
    [...calls.values()].some((c) => c.status === "running" && c.name !== "ask");
  const sliced = items.slice(-maxItems);
  // subagent answers arrive after the task call (wait, async delivery) – assemble them at the end
  for (const [callId, agents] of subAgents) {
    const call = calls.get(callId);
    if (!call) continue;
    let count: number | undefined;
    for (const id of agents.keys()) {
      const n = opts.subCalls?.(id);
      if (n !== undefined) count = (count ?? 0) + n;
    }
    call.sub = subOf(agents, count);
  }
  return {
    title,
    items: sliced,
    todo: todo?.some((p) => p.tasks.length) ? todo : undefined,
    jobs: [...jobs.values()],
    running: running && lastItem?.k !== "end",
    waiting: openWait && jobs.size > 0,
    turnStartedAt: turnStart,
    model,
    agent: "omp",
  };
}

/** Tool calls per subagent log, keyed by path – reread only when the log changed. */
const subCallCache = new Map<string, { size: number; mtime: number; calls: number }>();

/** How many tool calls a subagent of `session` made: omp keeps its log next to the session,
 *  nested by parent id ("A.B" → `<session>/A/A.B.jsonl`). */
export function subagentCalls(session: string, agentId: string): number | undefined {
  const parts = agentId.split(".");
  const dirs = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("."));
  const path = [session.replace(/\.jsonl$/, ""), ...dirs, `${agentId}.jsonl`].join("/");
  let st: { size: number; mtimeMs: number };
  try {
    st = statSync(path);
  } catch {
    return undefined;
  }
  const hit = subCallCache.get(path);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.calls;
  const text = readFileSync(path, "utf8");
  const needle = '"type":"toolCall"';
  let calls = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) calls++;
  subCallCache.set(path, { size: st.size, mtime: st.mtimeMs, calls });
  return calls;
}

export async function readTimeline(file: string, maxItems = 150): Promise<Timeline> {
  if (!existsSync(file)) return { items: [], jobs: [], running: false, waiting: false, agent: "omp" };
  return buildTimeline(await Bun.file(file).text(), maxItems, {
    subCalls: (id) => subagentCalls(file, id),
  });
}

/** Labels, descriptions and the recommended one – as the question index or a flag on the option. */
export function askOptions(q?: {
  header?: string;
  recommended?: number;
  multi?: boolean;
  options?: Array<{ label?: string; description?: string; recommended?: boolean }>;
}) {
  const opts = (Array.isArray(q?.options) ? q.options : []).filter((o) => o && typeof o === "object" && o.label);
  const options = opts.map((o) => clip(String(o.label), 200));
  const descriptions = opts.map((o) => (typeof o.description === "string" ? clip(o.description, 400) : ""));
  let recommended = opts.findIndex((o) => o.recommended === true);
  if (recommended < 0 && Number.isInteger(q?.recommended) && (q?.recommended ?? -1) < opts.length)
    recommended = q?.recommended ?? -1;
  return {
    options,
    ...(descriptions.some(Boolean) ? { descriptions } : {}),
    ...(recommended >= 0 ? { recommended } : {}),
    ...(typeof q?.header === "string" && q.header ? { header: clip(q.header, 60) } : {}),
    ...(q?.multi === true ? { multi: true } : {}),
  };
}

/** One question of an ask call's arguments, as the timeline shows it. */
function askQuestion(q?: Parameters<typeof askOptions>[0] & { question?: string }): AskQuestion {
  return { question: clip(q?.question ?? "Frage", 500), ...askOptions(q) };
}
