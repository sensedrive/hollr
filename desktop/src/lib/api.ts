// Calls into the Rust backend (pinned SSH → `hollr gate` on the server).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";

export interface Server {
  id: string;
  label: string;
  user: string;
  addresses: string[];
  port: number;
  hostFingerprint: string;
  deviceId: string;
  /** lan / tailscale / auto */
  network?: string;
}

export interface Pane {
  pane: string;
  agent?: string;
  status: string;
  title: string;
  cwd: string;
  focused: boolean;
  live: boolean;
}
export interface Tab {
  id: string;
  label: string;
  number: number;
  panes: Pane[];
}
export interface Workspace {
  id: string;
  label: string;
  number: number;
  status: string;
  tabs: Tab[];
}

export interface ToolCall {
  id: string;
  name: string;
  label: string;
  detail?: string;
  status: "running" | "ok" | "error";
  ms?: number;
  add?: number;
  del?: number;
  result?: string;
  bg?: string;
  out?: string[];
  outTotal?: number;
  exit?: number;
  path?: string;
  // ---- rich tool data (all optional, capped by the server; see the chat contract)
  /** edit/write: the change as hunks (~3 context lines), at most 400 lines; `diffMore` = lines left out */
  diff?: DiffHunk[];
  diffMore?: number;
  /** edit/write/read: absolute or space-relative file path (`detail` may be shortened) */
  file?: string;
  /** grep: matches per file (≤ 20 files × 8 lines); `result` keeps the count summary */
  matches?: MatchFile[];
  /** glob/find/ls: found paths (≤ 50) */
  files?: string[];
  /** read: line range read ("12-80") */
  range?: string;
  /** todo: the full todo state right after this call */
  todo?: TodoPhase[];
  /** web_search/fetch: result links (≤ 10) */
  links?: { title: string; url: string }[];
  /** subagent (task): its final answer (markdown, clipped), tool calls it made, agent name */
  sub?: { answer?: string; calls?: number; agent?: string };
  /** the agent's own tool name when `name` is the canonical one (Claude "MultiEdit" → "edit") */
  tool?: string;
  /** bash/eval: the working directory the call ran in, as the agent passed it (absolute or relative to the space) */
  cwd?: string;
  /** wait: the jobs its result reported – id, what the job did, final status ("completed", "running" on timeout …), run time */
  waited?: { id: string; label: string; status: string; ms?: number }[];
}

/** one line of a diff hunk: " " context, "+" added, "-" removed; `o`/`n` = old/new line number */
export interface DiffLine { t: " " | "+" | "-"; o?: number; n?: number; text: string }
/** `file`: only when one call changed several files (omp multi-file edit) – a file header where it changes */
export interface DiffHunk { lines: DiffLine[]; file?: string }
/** one file's grep matches: line number + text */
export interface MatchFile { file: string; lines: { n: number; text: string }[] }

/** `at`: epoch ms of the session-log entry the item comes from (older servers send it on user items only). */
export type TimelineItem =
  | { k: "user"; id: string; text: string; source?: string; at?: number }
  | { k: "thinking"; id: string; text: string; at?: number }
  | { k: "text"; id: string; text: string; at?: number }
  | { k: "tools"; id: string; calls: ToolCall[]; at?: number }
  | ({
      k: "ask"; id: string; answer?: string; pending?: boolean;
      /** every question when omp asks several at once (the question fields here are the first one) */
      questions?: AskQuestion[];
      at?: number;
    } & AskQuestion)
  | { k: "end"; id: string; ms: number; status: string; error?: string; at?: number }
  | { k: "info"; id: string; text: string; at?: number };

/** One of omp's questions: short title, a line per option, the recommended option's index, multi-select. */
export interface AskQuestion {
  question: string;
  options: string[];
  header?: string;
  descriptions?: string[];
  recommended?: number;
  multi?: boolean;
}

/** The answer to one question: picked option indexes and/or an own text (the server types the keys). */
export interface AskPick {
  options?: number[];
  text?: string;
}

export interface TodoTask {
  content: string;
  status: string;
}
export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}
export interface StatusLine {
  model?: string;
  folder?: string;
  branch?: string;
  dirty?: number;
  context?: string;
  cost?: string;
}
export interface Timeline {
  /** which session log the timeline comes from (older servers: omp only, field missing) */
  agent?: "omp" | "claude";
  title?: string;
  items: TimelineItem[];
  todo?: TodoPhase[];
  jobs: { id: string; type: string; label: string; startedAt: number }[];
  running: boolean;
  waiting: boolean;
  turnStartedAt?: number;
  model?: string;
  status?: string;
  line?: StatusLine;
  /** content fingerprint – sent back on the next poll */
  etag?: string;
}

export interface ModelList {
  kind: string;
  models: { id: string; name: string; group: string; context?: number }[];
  levels: string[];
  levelName: string;
  canSwitch: boolean;
}

export const servers = () => invoke<Server[]>("servers");
export const pair = (link: string, deviceName: string) => invoke<Server>("pair", { link, deviceName });
/** Pairing by one-time code; code errors reject with `otp:<kind>` (`otp:unreachable:<ip>`). */
export const pairCode = (code: string, deviceName: string) => invoke<Server>("pair_code", { code, deviceName });
export const removeServer = (id: string) => invoke<void>("remove_server", { id });

export async function gate<T>(server: string, command: string, body?: unknown, long = false): Promise<T> {
  const out = await invoke<string>(long ? "gate_long" : "gate", {
    server,
    command,
    stdin: body === undefined ? null : JSON.stringify(body),
  });
  const data = JSON.parse(out.trim().split("\n")[0] || "{}");
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") throw new Error(data.error);
  return data as T;
}

export const tree = (s: string) => gate<{ workspaces: Workspace[] }>(s, "tree").then((r) => r.workspaces);
/** null = unchanged since `etag` (the server then only answers {"same":true}). */
export const timeline = (s: string, pane: string, etag?: string, limit = 150) =>
  gate<Timeline & { same?: boolean }>(s, `timeline ${pane} ${limit}${etag ? ` ${etag}` : ""}`).then((t) =>
    t.same ? null : t,
  );
export const screen = (s: string, pane: string, lines = 80) =>
  gate<{ text: string }>(s, `screen ${pane} ${lines}`).then((r) => r.text);
/** Sends a message. If omp waits on a question, the server makes the text its own answer. */
export const prompt = (s: string, pane: string, text: string) =>
  gate(s, `prompt ${pane}`, { text }).catch((e) => Promise.reject(answerError(e)));
export const keys = (s: string, pane: string, k: string[]) => gate(s, `keys ${pane} ${k.join(" ")}`);
/** Answers omp's question `ask` (its id): one pick per question – the server works out the keys. */
export const answer = (s: string, pane: string, ask: string | undefined, picks: AskPick[]) =>
  gate(s, `answer ${pane}`, { id: ask, picks }).catch((e) => Promise.reject(answerError(e)));

function answerError(e: unknown): Error {
  const code = e instanceof Error ? e.message : String(e);
  const known: Record<string, string> = {
    no_question: t("omp fragt gerade nichts mehr."),
    stale_question: t("omp fragt inzwischen etwas anderes – bitte neu wählen."),
    bad_answer: t("Diese Antwort passt nicht zur Frage."),
    several_questions: t("omp stellt mehrere Fragen – bitte im Chat beantworten."),
    agent_blocked: t("Der Agent wartet auf eine Eingabe im Terminal – dort antworten."),
    not_allowed: t("Hollr auf dem Server ist zu alt – unter Server › Werkzeuge aktualisieren."),
  };
  return new Error(known[code] ?? code);
}

export const kinds = (s: string) => gate<{ kinds: string[] }>(s, "kinds").then((r) => r.kinds);
export const newChat = (s: string, body: Record<string, unknown>) =>
  gate<{ pane: string }>(s, "new", body).then((r) => r.pane);
export const closePane = (s: string, pane: string) => gate(s, `close ${pane}`);
/** herdr tab name (`rename <tab id>`, server 0.32.5+) */
export const renameTab = (s: string, tab: string, label: string) => gate(s, `rename ${tab}`, { label });
export const models = (s: string, kind: string) => gate<ModelList>(s, `models ${kind}`);
/** A file for the agent (base64): lands outside the repo on the server, gives back its absolute path. */
export const upload = (s: string, name: string, data: string) =>
  gate<{ path: string }>(s, "upload", { name, data }, true).then((r) => r.path);
export const switchModel = (s: string, pane: string, model: string, level?: string) =>
  gate(s, `model ${pane}`, { model, level });

// ---- localhost tunnel: a local port on this computer forwarded to `localhost:<port>` on the server
export const tunnelOpen = (server: string, port: number) => invoke<number>("tunnel_open", { server, port });
export const tunnelClose = (localPort: number) => invoke<void>("tunnel_close", { localPort });

// ---- live change feed (one `hollr gate events` channel per server, see src-tauri/src/feed.rs)
export const feedsSync = (servers: string[]) => invoke<void>("feeds_sync", { servers });
export const onChanged = (fn: (e: { server: string; spaces: boolean }) => void) =>
  listen<{ server: string; spaces: boolean }>("hollr-changed", (e) => fn(e.payload));
export const onFeed = (fn: (e: { server: string; live: boolean }) => void) =>
  listen<{ server: string; live: boolean }>("hollr-feed", (e) => fn(e.payload));
