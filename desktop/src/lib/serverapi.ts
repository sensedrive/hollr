// Server-side helpers for Settings, Server info and Tools (`sysinfo` and `tools` gates).
// JSON shapes mirror server/src/sysinfo.ts and server/src/tools.ts.
import { gate } from "./api";
import { lang, t } from "./i18n";

export interface ProcessInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  rssMb: number;
  name: string;
  command: string;
  /** belongs to the Hollr stack (herdr, omp, claude, codex, hollr, pulseaudio) */
  stack: boolean;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface ServerInfo {
  host: string;
  os: string;
  kernel: string;
  arch: string;
  user: string;
  uptime: number;
  hollr: string;
  cores: number;
  load: number[];
  cpu?: number;
  memory: { total: number; used: number; swapTotal: number; swapUsed: number };
  disks: { mount: string; total: number; used: number }[];
  processes: ProcessInfo[];
  checks: Check[];
}

export interface ServerTool {
  name: string;
  title: string;
  version?: string;
  latest?: string;
  updateAvailable?: boolean;
  installed: boolean;
  running: boolean;
  exit?: number;
  log?: string;
}

/** `sysinfo <lang>` – the pane slot carries the language. */
export const sysinfo = (server: string) => gate<ServerInfo>(server, `sysinfo ${lang()}`);

/** List tools; `check` ignores the 1 h cache of latest versions; `run` starts install/update of one. */
export async function tools(server: string, opts: { run?: string; check?: boolean } = {}): Promise<ServerTool[]> {
  const body: Record<string, string> = { lang: lang() };
  if (opts.run) {
    body.op = "run";
    body.name = opts.run;
  } else if (opts.check) body.op = "check";
  return (await gate<{ tools: ServerTool[] }>(server, "tools", body)).tools;
}

/** `hello` – Hollr version and host name of the server. */
export const hello = (server: string) => gate<{ hollr: string; host: string }>(server, "hello");

// ------------------------------------------------------------ formatting

/** Binary byte count like iOS' ByteCountFormatter(.memory): "12,3 GB". */
export function bytes(v: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const digits = i === 0 || n >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(lang(), { maximumFractionDigits: digits }).format(n)} ${units[i]}`;
}

/** Uptime like iOS: "3 T 4 h", "4 h 12 min", "12 min". */
export function duration(seconds: number): string {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return t("{d} T {h} h", { d, h });
  if (h > 0) return t("{h} h {m} min", { h, m });
  return t("{m} min", { m });
}

export const num = (v: number, digits = 1) =>
  new Intl.NumberFormat(lang(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);

/** Copies text to the clipboard; returns false when the webview refuses. */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback for webviews without the async clipboard API
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export const errText = (e: unknown) => String(e instanceof Error ? e.message : e);
