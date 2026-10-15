/**
 * `hollr gate shell <pane> <cols> <rows>`: the phone's own shell – a real terminal (PTY) sized to the
 * phone, started in the folder of that herdr pane. Unlike `term`, nothing on the computer changes
 * size and you can scroll. (Paired devices can already type into herdr's shell panes; this is the
 * same reach, just readable. Turn it off with ~/.config/hollr/no-shell.)
 *   in:  {"t":"in","d":"ls\r"}   {"t":"resize","cols":80,"rows":40}
 *   out: {"t":"out","d":"…"}     {"t":"exit","code":0}   {"t":"error","error":"…"}
 */
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { execHerdr } from "./herdr";

export const shellDisabled = () => existsSync(join(homedir(), ".config", "hollr", "no-shell"));

export function clampSize(cols: number, rows: number) {
  const c = Number.isFinite(cols) ? Math.round(cols) : 80;
  const r = Number.isFinite(rows) ? Math.round(rows) : 24;
  return { cols: Math.max(20, Math.min(300, c)), rows: Math.max(5, Math.min(200, r)) };
}

async function paneCwd(pane: string): Promise<string> {
  try {
    // execHerdr hands back herdr's `result`
    const out = (await execHerdr(["pane", "get", pane])) as { pane?: { foreground_cwd?: string; cwd?: string } };
    const p = out?.pane;
    const cwd = p?.foreground_cwd || p?.cwd;
    if (cwd && existsSync(cwd)) return cwd;
  } catch {}
  return homedir();
}

export async function runShell(pane: string, cols: number, rows: number): Promise<number> {
  const out = (line: object) => {
    try {
      process.stdout.write(`${JSON.stringify(line)}\n`);
    } catch {
      process.exit(0);
    }
  };
  if (shellDisabled()) {
    out({ t: "error", error: "Eigene Shell ist auf diesem Rechner abgeschaltet (~/.config/hollr/no-shell)." });
    return 1;
  }
  const size = clampSize(cols, rows);
  const cwd = await paneCwd(pane);
  const shell = Bun.env.SHELL || userInfo().shell || "/bin/bash";
  const decoder = new TextDecoder();
  const proc = Bun.spawn([shell, "-l"], {
    cwd,
    env: { ...Bun.env, TERM: "xterm-256color", COLORTERM: "truecolor", HOLLR_PHONE: "1" },
    terminal: {
      ...size,
      data(_t: unknown, data: Uint8Array) {
        out({ t: "out", d: decoder.decode(data, { stream: true }) });
      },
    },
  } as never) as ReturnType<typeof Bun.spawn> & {
    terminal: { write(d: string): void; resize(c: number, r: number): void };
  };

  let pending = "";
  process.stdin.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
      try {
        const msg = JSON.parse(line) as { t?: string; d?: string; cols?: number; rows?: number };
        if (msg.t === "in" && typeof msg.d === "string") proc.terminal.write(msg.d.slice(0, 8192));
        else if (msg.t === "resize") {
          const s = clampSize(Number(msg.cols), Number(msg.rows));
          proc.terminal.resize(s.cols, s.rows);
        }
      } catch {}
    }
  });
  // the app closed the channel: hang up the shell like a closed terminal window
  const hangup = () => {
    try {
      proc.kill("SIGHUP");
    } catch {}
  };
  process.stdin.on("end", hangup);
  process.stdin.on("close", hangup);
  process.stdin.resume();
  const ping = setInterval(() => out({ t: "ping" }), 20_000);
  const code = await proc.exited;
  clearInterval(ping);
  out({ t: "exit", code });
  return 0;
}
