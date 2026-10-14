// Calls into the Rust backend (pinned SSH → `hollr gate` on the server).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
}

export type TimelineItem =
  | { k: "user"; id: string; text: string; source?: string }
  | { k: "thinking"; id: string; text: string }
  | { k: "text"; id: string; text: string }
  | { k: "tools"; id: string; calls: ToolCall[] }
  | { k: "ask"; id: string; question: string; options: string[]; answer?: string; pending?: boolean }
  | { k: "end"; id: string; ms: number; status: string; error?: string }
  | { k: "info"; id: string; text: string };

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
export const removeServer = (id: string) => invoke<void>("remove_server", { id });

export async function gate<T>(server: string, command: string, body?: unknown): Promise<T> {
  const out = await invoke<string>("gate", {
    server,
    command,
    stdin: body === undefined ? null : JSON.stringify(body),
  });
  const data = JSON.parse(out.trim().split("\n")[0] || "{}");
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") throw new Error(data.error);
  return data as T;
}

export const tree = (s: string) => gate<{ workspaces: Workspace[] }>(s, "tree").then((r) => r.workspaces);
export const timeline = (s: string, pane: string) => gate<Timeline>(s, `timeline ${pane} 150`);
export const screen = (s: string, pane: string, lines = 80) =>
  gate<{ text: string }>(s, `screen ${pane} ${lines}`).then((r) => r.text);
export const prompt = (s: string, pane: string, text: string) => gate(s, `prompt ${pane}`, { text });
export const keys = (s: string, pane: string, k: string[]) => gate(s, `keys ${pane} ${k.join(" ")}`);
export const kinds = (s: string) => gate<{ kinds: string[] }>(s, "kinds").then((r) => r.kinds);
export const newChat = (s: string, body: Record<string, unknown>) =>
  gate<{ pane: string }>(s, "new", body).then((r) => r.pane);
export const closePane = (s: string, pane: string) => gate(s, `close ${pane}`);
export const models = (s: string, kind: string) => gate<ModelList>(s, `models ${kind}`);
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
