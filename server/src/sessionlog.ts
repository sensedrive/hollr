/**
 * Follows an omp session JSONL file and turns new entries into app events:
 * what the voice delegated, which tools the agent used, and its answers.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogEvent =
  | { t: "delegation"; text: string }
  | { t: "user"; text: string }
  | { t: "tool"; name: string; intent?: string }
  | { t: "answer"; text: string; final: boolean };

type Content = {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
  intent?: string;
};

interface Entry {
  type?: string;
  customType?: string;
  data?: unknown;
  content?: unknown;
  message?: {
    role?: string;
    customType?: string;
    content?: string | Content[];
    stopReason?: string;
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Content[])
      .filter((c) => c?.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

export function parseEntry(line: string, sinceMs = 0): LogEvent[] {
  let e: Entry & { timestamp?: string };
  try {
    e = JSON.parse(line);
  } catch {
    return [];
  }
  if (sinceMs && (!e.timestamp || Date.parse(e.timestamp) < sinceMs)) return [];
  const custom = e.customType ?? e.message?.customType;
  if (custom === "live-delegation") {
    const text = textOf(
      e.message?.content ?? e.content ?? (e.data as { content?: unknown })?.content,
    );
    return text ? [{ t: "delegation", text }] : [];
  }
  const msg = e.message;
  if (e.type === "message" && msg?.role === "user") {
    const text = textOf(msg.content).trim();
    // skip injected system notices / tool plumbing
    return text && !text.startsWith("<") ? [{ t: "user", text }] : [];
  }
  if (e.type !== "message" || msg?.role !== "assistant" || !Array.isArray(msg.content)) return [];
  const events: LogEvent[] = [];
  for (const c of msg.content) {
    if (c?.type === "toolCall" && c.name) {
      events.push({ t: "tool", name: c.name, intent: c.intent });
    }
  }
  const text = textOf(msg.content).trim();
  if (text) events.push({ t: "answer", text, final: msg.stopReason !== "toolUse" });
  return events;
}

export class SessionTail {
  private offset: number;
  private partial = "";
  private timer?: ReturnType<typeof setInterval>;

  /** Reads the whole file but only reports entries written after `sinceMs`. */
  constructor(
    readonly file: string,
    private readonly onEvent: (e: LogEvent) => void,
    private readonly sinceMs = Date.now(),
  ) {
    this.offset = 0;
  }

  start(intervalMs = 500) {
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async poll() {
    if (!existsSync(this.file)) return;
    const size = statSync(this.file).size;
    if (size < this.offset) this.offset = 0; // file rotated / rewritten
    if (size === this.offset) return;
    const chunk = await Bun.file(this.file).slice(this.offset, size).text();
    this.offset = size;
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) for (const ev of parseEntry(line, this.sinceMs)) this.onEvent(ev);
  }
}

/** omp keeps sessions in ~/.omp/agent/sessions/<encoded cwd>/<timestamp>_<id>.jsonl */
export function sessionDirCandidates(cwd: string, home = homedir()): string[] {
  const enc = (p: string) => p.replace(/\//g, "-");
  const names = new Set([enc(cwd)]);
  if (cwd.startsWith(`${home}/`)) names.add(enc(cwd.slice(home.length)));
  names.add(`-${enc(cwd)}--`);
  return [...names];
}

/** file → its title at that mtime: the first line is read once per change, not on every poll */
const titles = new Map<string, { mtime: number; title: string | undefined }>();

/** The title omp keeps in the first line of a session file – omp also sets it as the pane's terminal title. */
function sessionTitle(file: string, mtime: number): string | undefined {
  const known = titles.get(file);
  if (known?.mtime === mtime) return known.title;
  let title: string | undefined;
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const entry = JSON.parse(buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "") as {
        type?: string;
        title?: string;
      };
      title = (entry.type === "title" && entry.title?.trim()) || undefined;
    } finally {
      closeSync(fd);
    }
  } catch {}
  titles.set(file, { mtime, title });
  return title;
}

/** Newest session file in `dirs` with that title. */
function newestTitled(root: string, dirs: Iterable<string>, title: string) {
  let best: { file: string; mtime: number } | undefined;
  for (const name of dirs) {
    const dir = join(root, name);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = join(dir, f);
      const mtime = statSync(file).mtimeMs;
      if ((!best || mtime > best.mtime) && sessionTitle(file, mtime) === title) best = { file, mtime };
    }
  }
  return best?.file;
}

/**
 * The session file of an omp pane herdr names no path for: the newest one whose title is the pane's terminal
 * title – first in the pane's folder, then anywhere (herdr's cwd can be the shell's, not the folder omp was
 * started in). "Newest in the folder" alone showed another omp working in the same folder; a fresh omp (no
 * title, no file yet) gets none.
 */
export function findSessionByTitle(
  cwd: string,
  title: string,
  root = join(homedir(), ".omp", "agent", "sessions"),
): string | undefined {
  const near = sessionDirCandidates(cwd);
  const found = newestTitled(root, near, title);
  if (found || !existsSync(root)) return found;
  return newestTitled(root, readdirSync(root).filter((d) => !near.includes(d)), title);
}

/** Last `limit` conversation events of a session file (for reopening a chat). */
export async function readHistory(file: string, limit = 60): Promise<LogEvent[]> {
  if (!existsSync(file)) return [];
  const text = await Bun.file(file).text();
  const events: LogEvent[] = [];
  for (const line of text.split("\n")) events.push(...parseEntry(line));
  return events.slice(-limit);
}
