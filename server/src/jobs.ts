/**
 * One background job of an omp session (`bg_3`): what started it, and – once finished – its output, read from the
 * session log. omp keeps a running job's output in memory only; the log has it when the job is done (the
 * async-result notice or the `wait` that collected it).
 */
import { readFileSync } from "node:fs";

export interface JobDetail {
  id: string;
  /** the starting call: tool, intent, command, when */
  tool?: string;
  intent?: string;
  command?: string;
  startedAt?: number;
  status: "running" | "done" | "unknown";
  /** the output as omp handed it to the agent (done jobs) */
  output?: string;
  finishedAt?: number;
}

type Rec = {
  type?: string;
  customType?: string;
  timestamp?: string;
  content?: unknown;
  data?: {
    toolCallId?: string;
    toolName?: string;
    startedAt?: string;
    args?: Record<string, unknown>;
    intent?: string;
  };
  message?: {
    role?: string;
    toolCallId?: string;
    toolName?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
};

const textOf = (r: Rec): string =>
  typeof r.content === "string"
    ? r.content
    : (r.message?.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

/** `### bg_3 [bash] — completed …` up to the next job or section in a `wait` result */
function fromWait(text: string, id: string): string | undefined {
  const head = text.indexOf(`### ${id} [`);
  if (head < 0) return undefined;
  const rest = text.slice(head);
  const end = rest.slice(4).search(/\n#{2,3} /);
  return (end < 0 ? rest : rest.slice(0, end + 4)).trim();
}

export function jobDetail(sessionFile: string, id: string): JobDetail {
  if (!/^[\w-]{1,40}$/.test(id)) throw new Error("bad_job");
  const lines = readFileSync(sessionFile, "utf8").split("\n");
  const starts = new Map<string, Rec["data"]>();
  const detail: JobDetail = { id, status: "unknown" };
  let startLine = -1;
  const recs: (Rec | undefined)[] = lines.map((l) => {
    try {
      return l ? (JSON.parse(l) as Rec) : undefined;
    } catch {
      return undefined;
    }
  });
  // the newest start of this id (ids count again after omp restarts)
  recs.forEach((r, i) => {
    if (!r) return;
    if (r.customType === "tool_execution_start" && r.data?.toolCallId)
      starts.set(r.data.toolCallId, r.data);
    if (r.message?.role === "toolResult" && new RegExp(`(^|\\n)Backgrounded as job ${id} \\(`).test(textOf(r))) {
      const s = starts.get(r.message.toolCallId ?? "");
      startLine = i;
      detail.tool = s?.toolName ?? r.message.toolName;
      detail.intent = s?.intent;
      const args = s?.args ?? {};
      const cmd = args.command ?? args.code ?? args.task;
      detail.command = typeof cmd === "string" ? cmd : JSON.stringify(cmd ?? args);
      detail.startedAt = Date.parse(s?.startedAt ?? r.timestamp ?? "") || undefined;
      detail.status = "running";
      detail.output = undefined;
      detail.finishedAt = undefined;
    }
  });
  if (startLine < 0) return detail;
  for (const r of recs.slice(startLine + 1)) {
    if (!r) continue;
    const text = textOf(r);
    if (r.customType === "async-result" && text.includes(`job ${id} (`)) {
      detail.output = text
        .replace(/^<system-notice>\s*/, "")
        .replace(/<\/system-notice>\s*$/, "")
        .replace(/^Background job [^\n]*\n(Resume your work using the result below\.\n)?/, "")
        .trim();
    } else if (
      r.message?.toolName === "wait" &&
      text.includes(`### ${id} [`) &&
      /— (completed|failed|killed|cancelled)/.test(fromWait(text, id) ?? "")
    ) {
      detail.output = fromWait(text, id);
    } else continue;
    detail.status = "done";
    detail.finishedAt = Date.parse(r.timestamp ?? "") || undefined;
    break;
  }
  return detail;
}
