/**
 * Turns a Claude Code transcript (~/.claude/projects/<cwd>/<session id>.jsonl) into the same
 * render-ready timeline omp's log gives (timeline.ts): turns, grouped tool calls under the names the
 * apps already style for omp, thinking, answers, questions, the todo list and background jobs.
 *
 * Claude writes one line per content block (a message's thinking, text and every tool call get a line
 * of their own, sharing `message.id`), the tool results come back as "user" lines, subagents write
 * `isSidechain` lines (or files of their own) and a lot of plumbing (attachments, api requests, file
 * history) sits in between. Permission and trust dialogs are not in the log at all – they only show
 * on the screen (claudeprompt.ts), `claudeLive` merges them in.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ClaudePrompt, parseClaudePrompt } from "./claudeprompt";
import type { Agent, Herdr } from "./herdr";
import type { LogEvent } from "./sessionlog";
import {
  type AskQuestion,
  askOptions,
  capDiff,
  clip,
  type DiffHunk,
  type DiffLine,
  type Job,
  type MatchFile,
  RICH_CAPS,
  readTimeline,
  redact,
  type Timeline,
  type TimelineItem,
  type TodoPhase,
  type ToolCall,
} from "./timeline";

// ---------------------------------------------------------------- session file

/** Where Claude Code keeps its config (and the transcripts under projects/). */
export function claudeHome(): string {
  return Bun.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Claude names a project folder after the cwd with every character but [A-Za-z0-9] made a "-". */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * The transcript of session `id` (herdr's `agent_session` of a claude pane). Claude files it under the
 * folder it was started in – macOS's real path (/private/tmp for /tmp), and not the pane's cwd at all
 * after a `cd` or for very long, shortened folder names: then every project folder is looked at.
 * undefined while Claude hasn't written the file yet (a fresh session before its first message).
 */
export function claudeSessionFile(
  cwd: string,
  id: string,
  root = join(claudeHome(), "projects"),
): string | undefined {
  if (!/^[\w-]{8,80}$/.test(id)) return undefined;
  const name = `${id}.jsonl`;
  const dirs = new Set(cwd ? [cwd] : []);
  try {
    if (cwd) dirs.add(realpathSync(cwd));
  } catch {}
  for (const d of dirs) {
    const file = join(root, claudeProjectDir(d), name);
    if (existsSync(file)) return file;
  }
  try {
    for (const d of readdirSync(root)) {
      const file = join(root, d, name);
      if (existsSync(file)) return file;
    }
  } catch {}
  return undefined;
}

// ---------------------------------------------------------------- log entries

type Block = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type Entry = {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  content?: unknown;
  durationMs?: number;
  aiTitle?: string;
  customTitle?: string;
  summary?: string;
  totalCostUSD?: number;
  error?: unknown;
  retryAttempt?: number;
  maxRetries?: number;
  toolUseResult?: unknown;
  toolDenialKind?: string;
  attachment?: { type?: string; prompt?: unknown; commandMode?: string; source_uuid?: string };
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: string | Block[];
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
};

/** Numbers Claude's log gives for the status line (omp shows them in its footer). */
export interface ClaudeUsage {
  /** tokens of the last request (input + cache) – what the context holds now */
  context?: number;
  /** the session's cost so far, USD */
  cost?: number;
}

export interface ClaudeLog {
  timeline: Timeline;
  usage: ClaudeUsage;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** The text of a message or tool result (string, or its text blocks); images become a placeholder. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((b) => (b?.type === "text" ? (b.text ?? "") : b?.type === "image" ? "[Bild]" : ""))
    .filter(Boolean)
    .join("\n");
}

const tag = (text: string, name: string) =>
  text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** Claude's tool → the name the apps style (omp's) where the meaning matches; else its own, lower case. */
const CANONICAL: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "write",
  NotebookEdit: "notebook",
  Grep: "grep",
  Glob: "glob",
  LS: "ls",
  TodoWrite: "todo",
  TaskCreate: "todo",
  TaskUpdate: "todo",
  TaskList: "todo",
  TaskGet: "todo",
  Task: "task",
  Agent: "task",
  WebSearch: "web_search",
  WebFetch: "fetch",
  AskUserQuestion: "ask",
  ExitPlanMode: "plan",
  EnterPlanMode: "plan",
  Skill: "skill",
  BashOutput: "wait",
  TaskOutput: "wait",
};

export function canonicalTool(name: string): string {
  return CANONICAL[name] ?? (name.startsWith("mcp__") ? name : name.toLowerCase());
}

/** One-line description of a Claude tool call's input. */
function detailOf(tool: string, a: Record<string, unknown>): string | undefined {
  switch (tool) {
    case "Bash":
      return str(a.command);
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return str(a.file_path);
    case "NotebookEdit":
      return str(a.notebook_path);
    case "Grep":
    case "Glob":
      return str(a.pattern);
    case "LS":
      return str(a.path);
    case "Task":
    case "Agent":
      return str(a.description);
    case "WebSearch":
      return str(a.query);
    case "WebFetch":
      return str(a.url);
    case "Skill":
      return [str(a.skill), str(a.args)].filter(Boolean).join(" ") || undefined;
    case "ExitPlanMode":
      return str(a.planFilePath);
    case "EnterPlanMode":
      return "Planmodus";
    case "TaskCreate":
      return str(a.subject);
    case "TaskUpdate":
      return [str(a.taskId) && `#${a.taskId}`, str(a.status) ?? str(a.subject)]
        .filter(Boolean)
        .join(" · ");
    case "BashOutput":
      return str(a.bash_id);
    case "TaskOutput":
    case "TaskStop":
      return str(a.task_id) ?? str(a.shell_id);
    case "KillShell":
    case "KillBash":
      return str(a.shell_id);
    case "Monitor":
      return str(a.description) ?? str(a.command);
    default: {
      const first = Object.values(a).find((v) => typeof v === "string" && v.trim());
      return typeof first === "string" ? first : undefined;
    }
  }
}

// ---------------------------------------------------------------- diffs

/** Hunks of Claude's structuredPatch (or of a plain old → new swap) with line numbers and +/- counts;
 *  capped by timeline.ts's capDiff like omp's. */
class DiffBuilder {
  hunks: DiffHunk[] = [];
  add = 0;
  del = 0;
  /** lines of a written file that are not even shown (beyond RICH_CAPS.writeLines) */
  private skipped = 0;

  private hunk(lines: DiffLine[]) {
    for (const l of lines) {
      if (l.t === "+") this.add++;
      else if (l.t === "-") this.del++;
    }
    if (lines.length) this.hunks.push({ lines });
  }

  patch(patch: unknown) {
    if (!Array.isArray(patch)) return;
    for (const h of patch as Array<{ oldStart?: number; newStart?: number; lines?: unknown }>) {
      const lines: DiffLine[] = [];
      let o = num(h?.oldStart) ?? 1;
      let n = num(h?.newStart) ?? 1;
      for (const raw of Array.isArray(h?.lines) ? h.lines : []) {
        if (typeof raw !== "string" || raw.startsWith("\\")) continue;
        const text = raw.slice(1);
        if (raw[0] === "+") lines.push({ t: "+", n: n++, text });
        else if (raw[0] === "-") lines.push({ t: "-", o: o++, text });
        else lines.push({ t: " ", o: o++, n: n++, text });
      }
      this.hunk(lines);
    }
  }

  /** a swap without a patch (the call is still waiting, failed, or an old log): no line numbers */
  swap(oldText: string, newText: string) {
    const lines: DiffLine[] = [];
    if (oldText) for (const text of oldText.split("\n")) lines.push({ t: "-", text });
    if (newText) for (const text of newText.split("\n")) lines.push({ t: "+", text });
    this.hunk(lines);
  }

  /** a new file: its head as added lines, like omp's writes */
  create(content: string) {
    if (!content) return;
    const all = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    const kept = all.slice(0, RICH_CAPS.writeLines);
    this.skipped = all.length - kept.length;
    this.hunk(kept.map((text, i): DiffLine => ({ t: "+", n: i + 1, text })));
    this.add += this.skipped;
  }

  applyTo(call: ToolCall) {
    const { diff, diffMore } = capDiff(this.hunks, this.skipped);
    call.diff = diff;
    call.diffMore = diffMore;
    call.add = this.add || this.del ? this.add : undefined;
    call.del = this.add || this.del ? this.del : undefined;
  }
}

/** The change an edit/write call makes – from the result's patch, else from its input. */
function diffOf(
  tool: string,
  input: Record<string, unknown>,
  res?: Record<string, unknown>,
): DiffBuilder {
  const d = new DiffBuilder();
  if (res && Array.isArray(res.structuredPatch) && res.structuredPatch.length) {
    d.patch(res.structuredPatch);
    return d;
  }
  if (tool === "Write" || res?.type === "create") {
    d.create(str(res?.content) ?? str(input.content) ?? "");
  } else if (tool === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
    for (const e of edits) d.swap(str(e?.old_string) ?? "", str(e?.new_string) ?? "");
  } else if (tool === "Edit") {
    d.swap(
      str(res?.oldString) ?? str(input.old_string) ?? "",
      str(res?.newString) ?? str(input.new_string) ?? "",
    );
  }
  return d;
}

// ---------------------------------------------------------------- tool results

/** Grep's output ("file:12:text", or just files) as matches per file – matching lines only, capped. */
function grepMatches(res: Record<string, unknown>): MatchFile[] | undefined {
  const files = new Map<string, MatchFile>();
  const fileOf = (file: string) => {
    let f = files.get(file);
    if (!f && files.size < RICH_CAPS.matchFiles) {
      f = { file, lines: [] };
      files.set(file, f);
    }
    return f;
  };
  const content = str(res.content);
  if (res.mode === "content" && content) {
    for (const line of content.split("\n")) {
      // "path:12:text" (-n is Claude's default) or "path:text"; context lines (-A/-C) use "-" and are left out
      const m = line.match(/^(.+?):(\d+):(.*)$/) ?? line.match(/^([^:]+):()(.*)$/);
      if (!m) continue;
      const f = fileOf(m[1] ?? "");
      if (f && f.lines.length < RICH_CAPS.matchLines)
        f.lines.push({
          n: Number(m[2]) || 0,
          text: redact((m[3] ?? "").slice(0, RICH_CAPS.matchText)),
        });
    }
  } else if (Array.isArray(res.filenames)) {
    for (const file of res.filenames) if (typeof file === "string") fileOf(file);
  }
  return files.size ? [...files.values()] : undefined;
}

/** Search results Claude got back ({title, url} lists, sometimes nested per query). */
function searchLinks(
  res: Record<string, unknown>,
): Array<{ title: string; url: string }> | undefined {
  const links: Array<{ title: string; url: string }> = [];
  const visit = (v: unknown) => {
    if (links.length >= RICH_CAPS.links || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Record<string, unknown>;
    const url = str(o.url);
    if (url) links.push({ title: clip(str(o.title) ?? url, 200), url });
    else visit(o.content);
  };
  visit(res.results);
  return links.length ? links : undefined;
}

/** "Exit code 2\n…" (Claude's failed Bash result) → the code and the output without that line. */
function splitExit(text: string): { exit?: number; text: string } {
  const m = text.match(/^(?:Error: )?Exit code (\d+)\n?/);
  return m ? { exit: Number(m[1]), text: text.slice(m[0].length) } : { text };
}

const lastLines = (text: string) => {
  const lines = text.replace(/\s+$/, "").split("\n");
  return {
    out: lines.slice(-RICH_CAPS.outLines).map((l) => redact(l).slice(0, RICH_CAPS.outLineChars)),
    outTotal: lines.length,
  };
};

/** tools whose `description` input is the intent shown as the call's label */
const DESCRIBED: Record<string, true> = { Bash: true, Task: true, Agent: true, Monitor: true };

const REJECTED = /^The user doesn't want to (proceed|take this action)/;
const INTERRUPTED = /^\[Request interrupted by user/;

const TODO_PHASE = "Aufgaben";

// ---------------------------------------------------------------- the parser

/** Builds the timeline from Claude's transcript. `maxItems` limits the returned history. */
export function parseClaudeLog(jsonl: string, maxItems = 150, now = Date.now()): ClaudeLog {
  const items: TimelineItem[] = [];
  const calls = new Map<string, ToolCall>();
  /** what each call was: Claude's tool name, input, start */
  const uses = new Map<string, { tool: string; input: Record<string, unknown>; at: number }>();
  const asks = new Map<string, Extract<TimelineItem, { k: "ask" }>>();
  const jobs = new Map<string, Job>();
  /** tool_use id → background job it started (notifications name either) */
  const jobOfCall = new Map<string, string>();
  /** TaskCreate/TaskUpdate's list, by task id, in creation order */
  const tasks = new Map<string, { content: string; status: string }>();
  let todoWrite: TodoPhase[] | undefined;
  let todoFrom: "write" | "tasks" | undefined;
  const seen = new Set<string>();
  const usage: ClaudeUsage = {};
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let model: string | undefined;
  let turnStart: number | undefined;
  let currentGroup: Extract<TimelineItem, { k: "tools" }> | undefined;
  let lastFinal:
    | { id: string; at: number; status: "done" | "aborted" | "error"; error?: string; ms?: number }
    | undefined;
  /** the info of the last API error – retries update it instead of adding one each */
  let retryInfo: Extract<TimelineItem, { k: "info" }> | undefined;
  /** a `!` shell command whose output comes in a later line */
  let shellCall: ToolCall | undefined;
  let seq = 0;
  const nid = () => `c${seq++}`;

  /** the turn's end item is out (an info after the final answer closes it right away) */
  let closed = false;
  const closeTurn = () => {
    if (turnStart !== undefined && lastFinal) {
      items.push({
        k: "end",
        id: `end-${lastFinal.id}`,
        ms: lastFinal.ms ?? Math.max(0, lastFinal.at - turnStart),
        status: lastFinal.status,
        error: lastFinal.error,
        at: lastFinal.at,
      });
      closed = true;
    }
    lastFinal = undefined;
  };
  const startTurn = (at: number) => {
    closeTurn();
    turnStart = at;
    closed = false;
    currentGroup = undefined;
  };
  /** no turn is running: what comes now (a queued prompt, a job's report) starts one */
  const idle = () => turnStart === undefined || Boolean(lastFinal) || closed;
  const pushItem = (item: TimelineItem) => {
    if (item.k !== "tools") currentGroup = undefined;
    if (item.k !== "info" || item !== retryInfo) retryInfo = undefined;
    // a notice after the final answer (compaction, recap …) comes after the turn's end
    if (item.k === "info" && lastFinal) closeTurn();
    items.push(item);
  };
  const addCall = (call: ToolCall, at: number | undefined) => {
    calls.set(call.id, call);
    if (!currentGroup) {
      currentGroup = { k: "tools", id: `g-${call.id}`, calls: [], at };
      items.push(currentGroup);
    }
    currentGroup.calls.push(call);
  };
  const todoSnapshot = (): TodoPhase[] | undefined =>
    todoFrom === "tasks"
      ? [{ name: TODO_PHASE, tasks: [...tasks.values()].map((t) => ({ ...t })) }]
      : todoWrite;
  /** the user stopped the turn: whatever still ran was cut off */
  const abort = (id: string, at: number) => {
    for (const c of calls.values()) {
      if (c.status !== "running") continue;
      c.status = "error";
      c.result = "abgebrochen";
      const ask = asks.get(c.id);
      if (ask?.pending) {
        ask.pending = false;
        ask.answer = "abgebrochen";
      }
    }
    if (turnStart !== undefined) lastFinal = { id, at, status: "aborted" };
    currentGroup = undefined;
  };
  const endJob = (id?: string) => {
    if (!id) return;
    const job = jobOfCall.get(id) ?? id;
    jobs.delete(job);
  };

  const userText = (e: Entry, text: string, at: number, queued: boolean) => {
    const id = e.uuid ?? nid();
    const t = text.trim();
    if (!t) return;
    if (INTERRUPTED.test(t)) {
      abort(id, at);
      return;
    }
    const note = tag(t, "task-notification");
    if (note !== undefined) {
      // a background job / subagent / monitor reported in: the agent works on it, like a new turn
      const status = tag(note, "status")?.trim();
      const summary = unescapeXml(tag(note, "summary") ?? tag(note, "event") ?? "").trim();
      if (status && status !== "running") {
        endJob(tag(note, "task-id")?.trim());
        endJob(tag(note, "tool-use-id")?.trim());
      }
      // a background subagent's answer belongs on its task card (the call itself only said "backgrounded")
      const result = unescapeXml(tag(note, "result") ?? "").trim();
      const taskId = tag(note, "task-id")?.trim();
      const callId = tag(note, "tool-use-id")?.trim() || [...jobOfCall].find(([, job]) => job === taskId)?.[0];
      const call = calls.get(callId ?? "");
      if (call?.name === "task" && result) {
        call.sub = { ...call.sub, answer: clip(redact(result), RICH_CAPS.subAnswer) };
        call.status = status === "failed" ? "error" : "ok";
      }
      if (idle()) startTurn(at);
      pushItem({
        k: "info",
        id,
        text: `${status ? "Hintergrund-Job fertig" : "Hintergrund-Meldung"}: ${clip(summary || "Job", 200)}`,
        at,
      });
      return;
    }
    const command = tag(t, "command-name");
    if (command !== undefined) {
      const args = tag(t, "command-args")?.trim();
      if (!queued || idle()) startTurn(at);
      pushItem({
        k: "user",
        id,
        text: clip([command.trim(), args].filter(Boolean).join(" "), 4000),
        source: "typed",
        at,
      });
      return;
    }
    const stdout = tag(t, "local-command-stdout") ?? tag(t, "local-command-stderr");
    if (stdout !== undefined) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Claude colours its command output (ANSI)
      const out = stdout.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (out) pushItem({ k: "info", id, text: clip(out, 300), at });
      return;
    }
    const shell = tag(t, "bash-input");
    if (shell !== undefined) {
      // a `!` command the user ran in Claude's prompt: their message, and a terminal like the agent's
      if (!queued || idle()) startTurn(at);
      pushItem({ k: "user", id, text: clip(`! ${shell}`, 4000), source: "typed", at });
      shellCall = {
        id: `sh-${id}`,
        name: "bash",
        tool: "!",
        label: "Shell",
        detail: clip(shell, 400),
        status: "running",
      };
      addCall(shellCall, at);
    }
    const out = tag(t, "bash-stdout");
    const err = tag(t, "bash-stderr");
    if (out !== undefined || err !== undefined) {
      if (shellCall) {
        const text = [out, err].filter((s) => s?.trim()).join("\n");
        if (text.trim()) Object.assign(shellCall, lastLines(text));
        shellCall.status = err?.trim() && !out?.trim() ? "error" : "ok";
        shellCall = undefined;
      }
      return;
    }
    if (shell !== undefined) return;
    // other injected plumbing (<system-reminder>, <ci-monitor-event> …)
    if (/^<[a-z][\w-]*>/.test(t)) return;
    if (!queued || idle()) startTurn(at);
    // a prompt queued while Claude worked can show up twice (attachment + delivery)
    const prev = items.at(-1);
    if (queued && prev?.k === "user" && prev.text === clip(t, 4000)) return;
    pushItem({ k: "user", id, text: clip(t, 4000), source: "typed", at });
  };

  const toolResult = (e: Entry, b: Block, at: number) => {
    const id = b.tool_use_id ?? "";
    const call = calls.get(id);
    const use = uses.get(id);
    if (!call || !use) return;
    const tool = use.tool;
    const input = use.input;
    const res = obj(e.toolUseResult);
    const text = textOf(b.content);
    const rejected = REJECTED.test(text) || e.toolDenialKind === "user-rejected";
    const isError = Boolean(b.is_error) || rejected;
    call.status = isError ? "error" : "ok";
    call.ms = Math.max(0, at - use.at);
    if (isError)
      call.result = rejected ? "abgelehnt" : clip(splitExit(text).text || text || "Fehler", 160);

    switch (tool) {
      case "Bash": {
        const { exit, text: rest } = splitExit(text);
        const bg =
          str(res?.backgroundTaskId) ?? text.match(/running in background with ID: (\w+)/)?.[1];
        const out = res
          ? [str(res.stdout), str(res.stderr)].filter((s) => s?.trim()).join("\n")
          : rest;
        if (out.trim() && !rejected && !(bg && !res?.stdout)) Object.assign(call, lastLines(out));
        if (exit) {
          call.exit = exit;
          call.result = clip(
            `Exit ${exit}: ${rest
              .trim()
              .split("\n")
              .filter((l) => l.trim())
              .slice(-2)
              .join(" ⏎ ")}`,
            160,
          );
        } else if (res?.interrupted === true) {
          call.status = "error";
          call.result = "abgebrochen";
        } else if (!isError) {
          const interp = str(res?.returnCodeInterpretation);
          const tail = out
            .trim()
            .split("\n")
            .filter((l) => l.trim())
            .slice(-2)
            .join(" ⏎ ");
          call.result = interp ?? (tail ? clip(tail, 120) : undefined);
        }
        if (bg && !isError) {
          call.ms = undefined;
          call.result = `im Hintergrund · ${bg}`;
          call.bg = bg;
          jobs.set(bg, {
            id: bg,
            type: "bash",
            label: call.label !== tool ? call.label : (call.detail ?? bg),
            startedAt: use.at,
          });
          jobOfCall.set(id, bg);
        }
        break;
      }
      case "Read": {
        const file = obj(res?.file);
        if (res?.type === "image") call.result = "Bild";
        else if (file) {
          const start = num(file.startLine) ?? 1;
          const count = num(file.numLines);
          const total = num(file.totalLines);
          if (count !== undefined)
            call.range = `${start}-${start + Math.max(0, count - 1)}${total !== undefined ? `/${total}` : ""}`;
        }
        break;
      }
      case "Edit":
      case "MultiEdit":
      case "Write":
        if (!isError) diffOf(tool, input, res).applyTo(call);
        break;
      case "Grep":
        if (res) {
          call.matches = grepMatches(res);
          // content mode reports numFiles 0: count the files the lines are from
          const files = num(res.numFiles) || call.matches?.length || 0;
          const count = num(res.numMatches) ?? num(res.numLines);
          if (!isError)
            call.result =
              res.mode === "content" || res.mode === "count"
                ? `${count ?? 0} Treffer in ${files} Dateien`
                : `${files} Dateien`;
        }
        break;
      case "Glob":
      case "LS":
        if (res && Array.isArray(res.filenames)) {
          const names = res.filenames.filter((f): f is string => typeof f === "string");
          call.files = names.slice(0, RICH_CAPS.files);
          if (!isError) call.result = `${num(res.numFiles) ?? names.length} Dateien`;
        }
        break;
      case "TodoWrite": {
        const list = Array.isArray(res?.newTodos) ? res.newTodos : input.todos;
        if (!isError && Array.isArray(list)) {
          todoWrite = [
            {
              name: TODO_PHASE,
              tasks: (list as Array<Record<string, unknown>>).map((t) => ({
                content: clip(str(t?.content) ?? "", 200),
                status: str(t?.status) ?? "pending",
              })),
            },
          ];
          todoFrom = "write";
          call.todo = todoSnapshot();
          const done = todoWrite[0]?.tasks.filter((t) => t.status === "completed").length ?? 0;
          call.detail = `${done}/${todoWrite[0]?.tasks.length ?? 0} erledigt`;
        }
        break;
      }
      case "TaskCreate":
      case "TaskUpdate": {
        if (isError) break;
        const task = obj(res?.task);
        const taskId = str(task?.id) ?? str(res?.taskId) ?? str(input.taskId);
        if (tool === "TaskCreate" && taskId)
          tasks.set(taskId, {
            content: clip(str(task?.subject) ?? str(input.subject) ?? "", 200),
            status: "pending",
          });
        if (tool === "TaskUpdate" && taskId) {
          const t = tasks.get(taskId);
          const status = str(obj(res?.statusChange)?.to) ?? str(input.status);
          if (status === "deleted") tasks.delete(taskId);
          else if (t) {
            if (status) t.status = status;
            if (str(input.subject)) t.content = clip(str(input.subject) ?? "", 200);
          }
        }
        todoFrom = "tasks";
        call.todo = todoSnapshot();
        break;
      }
      case "Task":
      case "Agent": {
        const answer = textOf(res?.content ?? b.content).replace(
          /^\[Subagent hand-back\][^\n]*\n/,
          "",
        );
        const agentType = str(res?.agentType) ?? str(input.subagent_type);
        const async = res?.isAsync === true || res?.status === "async_launched";
        const agentId = str(res?.agentId);
        if (async && agentId && !isError) {
          call.ms = undefined;
          call.result = `im Hintergrund · ${agentId}`;
          call.bg = agentId;
          jobs.set(agentId, {
            id: agentId,
            type: "agent",
            label: call.detail ?? agentId,
            startedAt: use.at,
          });
          jobOfCall.set(id, agentId);
          call.sub = { agent: agentType };
        } else {
          call.sub = {
            answer: answer.trim() ? clip(answer, RICH_CAPS.subAnswer) : undefined,
            calls: num(res?.totalToolUseCount),
            agent: agentType,
          };
          const ms = num(res?.totalDurationMs);
          if (ms !== undefined) call.ms = ms;
        }
        break;
      }
      case "WebSearch":
        if (res) {
          call.links = searchLinks(res);
          if (!isError && call.links) call.result = `${call.links.length} Treffer`;
        }
        break;
      case "WebFetch": {
        const url = str(res?.url) ?? str(input.url);
        if (url) call.links = [{ title: url, url }];
        if (!isError && res)
          call.result = [num(res.code), str(res.codeText)].filter(Boolean).join(" ") || undefined;
        break;
      }
      case "ExitPlanMode":
        if (!isError) call.result = "freigegeben";
        else if (rejected) {
          // "Tell Claude what to change": the feedback follows "the user said:"
          const said = text.match(/the user said:\s*([\s\S]+)$/i)?.[1];
          call.result = said ? clip(`abgelehnt: ${said}`, 160) : "abgelehnt";
        }
        break;
      case "Monitor": {
        const taskId = str(res?.taskId);
        if (taskId && !isError) {
          call.bg = taskId;
          jobs.set(taskId, {
            id: taskId,
            type: "monitor",
            label: call.label !== tool ? call.label : (call.detail ?? taskId),
            startedAt: use.at,
          });
          jobOfCall.set(id, taskId);
        }
        break;
      }
      case "KillShell":
      case "KillBash":
      case "TaskStop":
        if (!isError) endJob(str(input.shell_id) ?? str(input.task_id) ?? str(res?.task_id));
        break;
      case "BashOutput":
      case "TaskOutput": {
        const status = str(res?.status);
        if (status && status !== "running") endJob(str(input.bash_id) ?? str(input.task_id));
        const out = res
          ? [str(res.stdout), str(res.stderr)].filter((s) => s?.trim()).join("\n")
          : "";
        if (out.trim()) Object.assign(call, lastLines(out));
        break;
      }
      case "AskUserQuestion": {
        const ask = asks.get(id);
        if (!ask) break;
        ask.pending = false;
        const answers = obj(res?.answers);
        ask.answer = isError
          ? "abgebrochen"
          : clip(
              (answers
                ? (ask.questions ?? [ask])
                    .map((q) => str(answers[q.question]))
                    .filter(Boolean)
                    .join(" · ")
                : "") || text,
              300,
            );
        break;
      }
    }
  };

  const assistant = (e: Entry, at: number) => {
    const m = e.message ?? {};
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.model && m.model !== "<synthetic>") model = m.model;
    const u = m.usage;
    if (u && m.model !== "<synthetic>") {
      const ctx =
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
      if (ctx) usage.context = ctx;
    }
    const id = e.uuid ?? nid();
    if (e.isApiErrorMessage || m.model === "<synthetic>") {
      // Claude's own messages: API errors end the turn, "No response requested." is nothing
      if (e.isApiErrorMessage) {
        lastFinal = { id, at, status: "error", error: clip(textOf(blocks) || "API-Fehler", 200) };
        currentGroup = undefined;
      }
      return;
    }
    let hasTool = false;
    blocks.forEach((b, i) => {
      const bid = i ? `${id}:${i}` : id;
      if (b.type === "thinking" && b.thinking?.trim()) {
        pushItem({ k: "thinking", id: bid, text: clip(b.thinking, 1500), at });
      } else if (b.type === "text" && b.text?.trim()) {
        pushItem({ k: "text", id: bid, text: redact(b.text), at });
      } else if (b.type === "tool_use" && b.id && b.name && !calls.has(b.id)) {
        hasTool = true;
        const input = obj(b.input) ?? {};
        const tool = b.name;
        // Claude loading the schemas of its deferred tools: plumbing, not something it does for you
        if (tool === "ToolSearch") return;
        uses.set(b.id, { tool, input, at });
        if (tool === "AskUserQuestion") {
          const questions: AskQuestion[] = (
            Array.isArray(input.questions) ? input.questions : []
          ).map((q: Record<string, unknown>) => claudeQuestion(q));
          const first = questions[0] ?? { question: "Frage", options: [] };
          calls.set(b.id, {
            id: b.id,
            name: "ask",
            tool,
            label: first.question,
            status: "running",
          });
          const ask: Extract<TimelineItem, { k: "ask" }> = {
            k: "ask",
            id: b.id,
            ...first,
            ...(questions.length > 1 ? { questions } : {}),
            pending: true,
            at,
          };
          asks.set(b.id, ask);
          pushItem(ask);
          return;
        }
        const plan = tool === "ExitPlanMode" ? str(input.plan) : undefined;
        if (plan?.trim()) pushItem({ k: "text", id: `${b.id}:plan`, text: redact(plan), at });
        const name = canonicalTool(tool);
        const detail = detailOf(tool, input);
        const call: ToolCall = {
          id: b.id,
          name,
          tool: name !== tool ? tool : undefined,
          // Bash/Agent/Monitor say what they do in `description` (TaskCreate's is the task's text)
          label: clip((DESCRIBED[tool] ? str(input.description) : undefined) || tool, 120),
          detail: detail ? clip(detail, tool === "Bash" ? 400 : 160) : undefined,
          path: tool === "Grep" || tool === "Glob" ? str(input.path) : undefined,
          file: str(input.file_path) ?? str(input.notebook_path),
          status: "running",
        };
        // what an edit will change shows while Claude still waits for the permission
        if (tool === "Edit" || tool === "MultiEdit" || tool === "Write")
          diffOf(tool, input).applyTo(call);
        if (tool === "TodoWrite" && Array.isArray(input.todos))
          call.detail = `${input.todos.length} Aufgaben`;
        if ((tool === "Task" || tool === "Agent") && str(input.subagent_type))
          call.sub = { agent: str(input.subagent_type) };
        addCall(call, at);
      }
    });
    // the agent kept working after an earlier stop (a background job reported in) – that stop was not the end
    if (hasTool) lastFinal = undefined;
    const stop = m.stop_reason;
    if (!hasTool && stop && stop !== "tool_use" && stop !== "pause_turn") {
      lastFinal = {
        id,
        at,
        status: stop === "refusal" ? "error" : "done",
        error: stop === "refusal" ? "Claude hat die Antwort verweigert" : undefined,
      };
      currentGroup = undefined;
    }
  };

  for (const line of jsonl.split("\n")) {
    if (!line || line.length > 3_000_000) continue;
    let e: Entry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // subagents' own conversation: their result arrives as the Task/Agent call's result
    if (e.isSidechain) continue;
    if (e.uuid) {
      if (seen.has(e.uuid)) continue;
      seen.add(e.uuid);
    }
    const at = (e.timestamp ? Date.parse(e.timestamp) : NaN) || now;
    switch (e.type) {
      case "ai-title":
        aiTitle = str(e.aiTitle) || aiTitle;
        continue;
      case "custom-title":
        customTitle = str(e.customTitle) || customTitle;
        continue;
      case "summary":
        aiTitle ??= str(e.summary);
        continue;
      case "cost-state":
        usage.cost = num(e.totalCostUSD) ?? usage.cost;
        continue;
      case "system":
        switch (e.subtype) {
          case "compact_boundary":
            pushItem({ k: "info", id: e.uuid ?? nid(), text: "Kontext wurde zusammengefasst", at });
            break;
          case "turn_duration":
            if (lastFinal && num(e.durationMs) !== undefined) lastFinal.ms = num(e.durationMs);
            break;
          case "api_error": {
            const err = obj(e.error);
            const why = str(err?.formatted) ?? str(err?.message) ?? "API-Fehler";
            const attempt = num(e.retryAttempt);
            const text = clip(
              `API-Fehler: ${why}${attempt ? ` – neuer Versuch ${attempt}/${num(e.maxRetries) ?? "?"}` : ""}`,
              200,
            );
            if (retryInfo && items.at(-1) === retryInfo) retryInfo.text = text;
            else {
              retryInfo = { k: "info", id: e.uuid ?? nid(), text, at };
              pushItem(retryInfo);
            }
            break;
          }
          case "informational":
          case "away_summary": {
            const text = (str(e.content) ?? "").replace(
              /\s*\(disable recaps in \/config\)\s*$/,
              "",
            );
            if (text.trim())
              pushItem({
                k: "info",
                id: e.uuid ?? nid(),
                text: clip(e.subtype === "away_summary" ? `Zusammenfassung: ${text}` : text, 400),
                at,
              });
            break;
          }
          case "local_command":
            userText(e, str(e.content) ?? "", at, false);
            break;
        }
        continue;
      case "attachment": {
        const a = e.attachment;
        // a message typed (or a job's report delivered) while Claude was working
        if (a?.type === "queued_command") userText(e, textOf(a.prompt), at, true);
        continue;
      }
      case "user": {
        if (e.isMeta || e.isCompactSummary) continue;
        const content = e.message?.content;
        if (Array.isArray(content)) {
          const results = content.filter((b) => b?.type === "tool_result");
          for (const b of results) toolResult(e, b, at);
          if (results.length) continue;
        }
        userText(e, textOf(content), at, false);
        continue;
      }
      case "assistant":
        assistant(e, at);
        continue;
    }
  }
  closeTurn();

  // jobs that never reported an end (Claude was closed, old sessions) – hide after a few hours
  for (const [id, job] of jobs) if (now - job.startedAt > 4 * 3600_000) jobs.delete(id);

  const todo = todoSnapshot();
  const lastItem = items.at(-1);
  const runningCall = [...calls.values()].some((c) => c.status === "running" && c.name !== "ask");
  // a prompt without an answer yet: Claude is thinking (omp logs that differently); a question waits on the user
  const open =
    turnStart !== undefined && !lastFinal && !closed && ![...asks.values()].some((a) => a.pending);
  return {
    timeline: {
      agent: "claude",
      title: customTitle ?? aiTitle,
      items: items.slice(-maxItems),
      todo: todo?.some((p) => p.tasks.length) ? todo : undefined,
      jobs: [...jobs.values()],
      running: (runningCall || open) && lastItem?.k !== "end",
      waiting: false,
      turnStartedAt: turnStart,
      model,
    },
    usage,
  };
}

/** One AskUserQuestion question as the timeline shows it; "(Recommended)" becomes the flag. */
function claudeQuestion(q: Record<string, unknown>): AskQuestion {
  const raw = Array.isArray(q?.options) ? (q.options as Array<Record<string, unknown>>) : [];
  const options = raw.map((o) => {
    const label = str(o?.label) ?? "";
    const rec = /\s*\(Recommended\)\s*$/i.test(label);
    return {
      label: label.replace(/\s*\(Recommended\)\s*$/i, "") || label,
      description: str(o?.description),
      recommended: rec,
    };
  });
  return {
    question: clip(str(q?.question) ?? "Frage", 500),
    ...askOptions({ header: str(q?.header), multi: q?.multiSelect === true, options }),
  };
}

export async function readClaudeLog(file: string, maxItems = 150): Promise<ClaudeLog> {
  if (!existsSync(file))
    return {
      timeline: { agent: "claude", items: [], jobs: [], running: false, waiting: false },
      usage: {},
    };
  return parseClaudeLog(await Bun.file(file).text(), maxItems);
}

// ---------------------------------------------------------------- live state

const HEADERS: Record<ClaudePrompt["kind"], string> = {
  permission: "Freigabe",
  plan: "Plan",
  trust: "Ordner vertrauen",
  question: "",
};

/**
 * The log's timeline as of now: herdr's status says whether Claude still works, and a dialog on the
 * screen (passed when herdr says "blocked") becomes a pending ask – permission and trust dialogs are
 * never in the log, an AskUserQuestion only counts as open while Claude shows it.
 */
export function claudeLive(tl: Timeline, status: string, screen?: string): Timeline {
  const items = [...tl.items];
  let running = tl.running;
  if (status === "idle" || status === "done") running = false;
  const prompt = screen ? parseClaudePrompt(screen) : undefined;
  const settled = status === "idle" || status === "done" || status === "working";
  const lastAsk = items.findLastIndex((i) => i.k === "ask" && i.pending);
  if (lastAsk >= 0 && (settled || (screen !== undefined && prompt && prompt.kind !== "question"))) {
    // the question is gone from the screen (answered or cancelled in the terminal, Claude closed)
    const ask = items[lastAsk] as Extract<TimelineItem, { k: "ask" }>;
    items[lastAsk] = { ...ask, pending: false };
  }
  if (prompt && prompt.kind !== "question") {
    items.push(promptAsk(prompt, tl));
    running = false;
  } else if (prompt) running = false;
  return { ...tl, items, running };
}

/**
 * The dialog on the screen as an ask item. Its id hashes what is asked (the command or diff is part
 * of the question), so a stale tap can't answer a different one: the call it is about is not always
 * in the log yet while Claude waits (an edit right after a plan approval shows up only once it ran).
 * A plan's question text never changes – there the plan call it belongs to goes in.
 */
export function promptAsk(prompt: ClaudePrompt, tl: Timeline): Extract<TimelineItem, { k: "ask" }> {
  const calls = tl.items.flatMap((i) => (i.k === "tools" ? i.calls : []));
  const plan = prompt.kind === "plan" ? calls.findLast((c) => c.name === "plan")?.id : undefined;
  const id =
    prompt.kind === "trust"
      ? "trust"
      : `${prompt.kind === "plan" ? "plan" : "perm"}-${hash(`${plan ?? ""}\n${prompt.question}\n${prompt.options.join("\n")}`)}`;
  return {
    k: "ask",
    id,
    question: prompt.question,
    options: prompt.options,
    ...(prompt.descriptions?.some(Boolean) ? { descriptions: prompt.descriptions } : {}),
    header: HEADERS[prompt.kind],
    pending: true,
  };
}

function hash(s: string): string {
  return new Bun.CryptoHasher("sha1").update(s).digest("hex").slice(0, 10);
}

/** The pane's chat: the log's timeline, for Claude with the dialog it shows (read when herdr says blocked). */
export async function paneTimeline(
  herdr: Herdr,
  agent: Agent,
  maxItems: number,
): Promise<{ timeline: Timeline; usage?: ClaudeUsage }> {
  const file = agent.sessionFile;
  if (agent.kind !== "claude")
    return {
      timeline: file
        ? await readTimeline(file, maxItems)
        : { items: [], jobs: [], running: false, waiting: false },
    };
  const log = file
    ? await readClaudeLog(file, maxItems)
    : {
        timeline: { agent: "claude" as const, items: [], jobs: [], running: false, waiting: false },
        usage: {},
      };
  const screen =
    agent.status === "blocked" ? await herdr.screen(agent.pane, 40).catch(() => "") : undefined;
  return { timeline: claudeLive(log.timeline, agent.status, screen), usage: log.usage };
}

/** Context and cost for the status line, formatted like omp's footer gives them. */
export function claudeFooter(usage: ClaudeUsage | undefined): { context?: string; cost?: string } {
  const ctx = usage?.context;
  return {
    context: ctx
      ? ctx >= 1_000_000
        ? `${(ctx / 1_000_000).toFixed(1)}M`
        : `${Math.round(ctx / 1000)}k`
      : undefined,
    cost: usage?.cost !== undefined ? usage.cost.toFixed(2) : undefined,
  };
}

// ---------------------------------------------------------------- history

/** Last `limit` conversation events of a Claude transcript (for reopening a chat), like omp's readHistory. */
export async function readClaudeHistory(file: string, limit = 60): Promise<LogEvent[]> {
  if (!existsSync(file)) return [];
  const events: LogEvent[] = [];
  for (const item of parseClaudeLog(await Bun.file(file).text(), 100_000).timeline.items) {
    if (item.k === "user") events.push({ t: "user", text: item.text });
    else if (item.k === "tools")
      for (const c of item.calls)
        events.push({
          t: "tool",
          name: c.name,
          intent: c.label !== (c.tool ?? c.name) ? c.label : undefined,
        });
    else if (item.k === "text") events.push({ t: "answer", text: item.text, final: false });
    else if (item.k === "end") {
      const last = events.findLast((ev) => ev.t === "answer");
      if (last?.t === "answer") last.final = true;
    }
  }
  return events.slice(-limit);
}
