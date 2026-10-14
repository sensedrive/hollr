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
  const ss = Bun.spawnSync(["ss", "-Hltnp"], { stdout: "pipe", stderr: "ignore" });
  const listeners = parseListeners(ss.stdout.toString()).slice(0, 60);
  const probed = await Promise.all(listeners.map(async (l) => ({ l, p: await probe(l.port) })));
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
