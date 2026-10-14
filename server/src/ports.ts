/**
 * Web services listening on this server's loopback – the in-app browser offers them
 * as quick links (dev servers, previews, dashboards). Only ports that answer with HTML.
 */
import { readlinkSync } from "node:fs";

export interface WebPort {
  port: number;
  title?: string;
  process?: string;
  cwd?: string;
}

interface Listener {
  port: number;
  process?: string;
  pid?: number;
}

const SKIP = new Set([22, 53]);
/** browser automation / debugging endpoints, not pages */
const SKIP_PROCESS = /^(chrome|chromium|agent-browser|omp|moshi-hook)$/;

/** Parses `ss -Hltnp`; keeps sockets reachable via loopback (127.0.0.1, ::1, wildcard). */
export function parseListeners(text: string): Listener[] {
  const out = new Map<number, Listener>();
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    if (!local) continue;
    const idx = local.lastIndexOf(":");
    const host = local.slice(0, idx).replace(/%.*$/, "");
    const port = Number(local.slice(idx + 1));
    if (!port || SKIP.has(port)) continue;
    const loopback = ["127.0.0.1", "0.0.0.0", "*", "[::]", "[::1]", "::", "::1"].includes(host);
    if (!loopback) continue;
    const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (proc && SKIP_PROCESS.test(proc[1] ?? "")) continue;
    if (!out.has(port) || proc)
      out.set(port, { port, process: proc?.[1], pid: proc ? Number(proc[2]) : undefined });
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

/** macOS (no `ss`): `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → p<pid> / c<command> / n<host:port> records. */
export function parseLsof(text: string): Listener[] {
  const out = new Map<number, Listener>();
  let pid: number | undefined;
  let proc: string | undefined;
  for (const line of text.split("\n")) {
    const v = line.slice(1);
    if (line.startsWith("p")) pid = Number(v);
    else if (line.startsWith("c")) proc = v;
    else if (line.startsWith("n")) {
      const idx = v.lastIndexOf(":");
      const host = v.slice(0, idx);
      const port = Number(v.slice(idx + 1));
      if (!port || SKIP.has(port) || out.has(port)) continue;
      if (!["127.0.0.1", "*", "[::1]", "localhost", "[::]"].includes(host)) continue;
      if (proc && SKIP_PROCESS.test(proc)) continue;
      out.set(port, { port, process: proc, pid });
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

function listeners(): Listener[] {
  try {
    const ss = Bun.spawnSync(["ss", "-Hltnp"], { stdout: "pipe", stderr: "ignore" });
    if (ss.exitCode === 0) return parseListeners(ss.stdout.toString());
  } catch {}
  try {
    const lsof = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return parseLsof(lsof.stdout.toString());
  } catch {
    return [];
  }
}

async function probe(port: number): Promise<{ html: boolean; title?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(900),
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.includes("text/html")) return { html: false };
    const body = (await res.text()).slice(0, 65536);
    const title = body.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim();
    return { html: true, title };
  } catch {
    return { html: false };
  }
}

export async function webPorts(): Promise<WebPort[]> {
  const probed = await Promise.all(
    listeners()
      .slice(0, 60)
      .map(async (l) => ({ l, p: await probe(l.port) })),
  );
  return probed
    .filter(({ p }) => p.html)
    .map(({ l, p }) => {
      let cwd: string | undefined;
      try {
        if (l.pid) cwd = readlinkSync(`/proc/${l.pid}/cwd`);
      } catch {}
      return { port: l.port, title: p.title, process: l.process, cwd };
    });
}
