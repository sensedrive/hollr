/**
 * Turns an omp session JSONL into a compact, render-ready timeline for the phone:
 * turns, grouped tool calls (with status, duration, diff stats), thinking, answers,
 * questions, the current todo list and running background jobs.
 */
import { existsSync } from "node:fs";

export type ToolStatus = "running" | "ok" | "error";

export interface ToolCall {
  id: string;
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
  /** last output lines (bash/eval), like omp's collapsed output pane */
  out?: string[];
  /** total output line count */
  outTotal?: number;
  /** exit code when non-zero */
  exit?: number;
  /** search scope (grep/glob) */
  path?: string;
  /** background job id when the call was backgrounded */
  bg?: string;
}

export type TimelineItem =
  | {
      k: "user";
      id: string;
      text: string;
      source: "typed" | "voice" | "skill" | "agent";
      at: number;
    }
  | { k: "thinking"; id: string; text: string }
  | { k: "text"; id: string; text: string }
  | { k: "tools"; id: string; calls: ToolCall[] }
  | { k: "ask"; id: string; question: string; options: string[]; answer?: string; pending: boolean }
  | { k: "end"; id: string; ms: number; status: "done" | "aborted" | "error"; error?: string }
  | { k: "info"; id: string; text: string };

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

function clip(text: string, max: number): string {
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

/** Builds the timeline from the raw JSONL text. `maxItems` limits the returned history. */
export function buildTimeline(jsonl: string, maxItems = 150): Timeline {
  const items: TimelineItem[] = [];
  const calls = new Map<string, ToolCall>();
  const starts = new Map<string, number>();
  const jobs = new Map<string, Job>();
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
    switch (e.type) {
      case "title":
        title = e.title || title;
        continue;
      case "model_change":
        model = e.model ?? model;
        continue;
      case "compaction":
        pushItem({ k: "info", id: nid(e.id), text: "Kontext wurde zusammengefasst" });
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
          });
        } else if (e.customType === "irc:incoming") {
          const from = str(e.details?.from) ?? "Agent";
          pushItem({
            k: "info",
            id: nid(e.id),
            text: `Nachricht von ${from}: ${clip(str(e.details?.message) ?? text, 200)}`,
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
          pushItem({ k: "thinking", id: nid(), text: clip(b.thinking, 1500) });
        } else if (b.type === "text" && b.text?.trim()) {
          pushItem({ k: "text", id: nid(), text: redact(b.text) });
        } else if (b.type === "toolCall" && b.id && b.name) {
          const args = (b.arguments ?? {}) as Record<string, unknown>;
          if (b.name === "ask") {
            const qs =
              (args.questions as Array<{
                question?: string;
                options?: Array<{ label?: string }>;
              }>) ?? [];
            const q = qs[0];
            const call: ToolCall = {
              id: b.id,
              name: "ask",
              label: q?.question ?? "Frage",
              status: "running",
            };
            calls.set(b.id, call);
            pushItem({
              k: "ask",
              id: b.id,
              question: clip(q?.question ?? "Frage", 500),
              options: (q?.options ?? []).map((o) => o.label ?? "").filter(Boolean),
              pending: true,
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
          if (!currentGroup) {
            currentGroup = { k: "tools", id: `g-${b.id}`, calls: [] };
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
          at: m.completedAt ?? at,
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
            call.out = lines.slice(-12).map((l) => redact(l).slice(0, 240));
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
            item.answer = m.isError
              ? "abgebrochen"
              : clip(
                  [...sel, str(details.customInput)].filter(Boolean).join(", ") ||
                    textOf(m.content),
                  300,
                );
          }
        }
      }
      // todo snapshot
      if (m.toolName === "todo" && !m.isError && Array.isArray(details.phases)) {
        todo = (details.phases as TodoPhase[]).map((p) => ({
          name: p.name,
          tasks: (p.tasks ?? []).map((t) => ({
            content: clip(t.content, 200),
            status: t.status,
            blocker: t.blocker,
          })),
        }));
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
  return {
    title,
    items: sliced,
    todo: todo?.some((p) => p.tasks.length) ? todo : undefined,
    jobs: [...jobs.values()],
    running: running && lastItem?.k !== "end",
    waiting: openWait && jobs.size > 0,
    turnStartedAt: turnStart,
    model,
  };
}

export async function readTimeline(file: string, maxItems = 150): Promise<Timeline> {
  if (!existsSync(file)) return { items: [], jobs: [], running: false, waiting: false };
  return buildTimeline(await Bun.file(file).text(), maxItems);
}
