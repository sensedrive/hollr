/**
 * `hollr gate term <pane>`: a live terminal for the app. Streams the pane's visible screen (with
 * colors, as ANSI) whenever herdr's revision moves, and types what comes from the phone.
 *   out: {"t":"screen","ansi":"…","rows":40,"cols":120}   {"t":"ping"}   {"t":"closed"}
 *   in:  {"t":"text","text":"ls\r"}   {"t":"keys","keys":["ctrl+c"]}
 * The pane is shared with herdr on the computer: nothing here scrolls or resizes it.
 */
import { herdrSocket } from "./events";

/** fast right after typing (echo), slower when nothing happens */
const FAST_MS = 80;
const SLOW_MS = 350;
const FAST_FOR_MS = 3000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

/** Visible width of the widest line (the pane's column count is not in herdr's API). */
export function screenSize(ansi: string): { rows: number; cols: number } {
  const lines = ansi.split("\n");
  let cols = 0;
  for (const line of lines) cols = Math.max(cols, [...line.replace(ANSI_RE, "")].length);
  return { rows: lines.length, cols };
}

export async function runTerm(pane: string): Promise<number> {
  const out = (line: object) => {
    try {
      process.stdout.write(`${JSON.stringify(line)}\n`);
    } catch {
      process.exit(0);
    }
  };
  // herdr answers one request per connection: a short-lived socket per call (cheap, it's local)
  const call = (method: string, params: object) =>
    new Promise<Record<string, unknown> | undefined>((resolve) => {
      let buffer = "";
      let settled = false;
      const finish = (result: Record<string, unknown> | undefined) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      setTimeout(() => finish(undefined), 4000);
      Bun.connect({
        unix: herdrSocket(),
        socket: {
          open(sock) {
            sock.write(`${JSON.stringify({ id: "term", method, params })}\n`);
          },
          data(sock, data) {
            buffer += data.toString();
            const nl = buffer.indexOf("\n");
            if (nl === -1) return;
            try {
              const msg = JSON.parse(buffer.slice(0, nl)) as { result?: Record<string, unknown>; error?: unknown };
              finish(msg.error ? undefined : msg.result);
            } catch {
              finish(undefined);
            }
            sock.end();
          },
          close() {
            finish(undefined);
          },
          error() {
            finish(undefined);
          },
        },
      }).catch(() => finish(undefined));
    });

  if (!(await call("pane.get", { pane_id: pane }))) {
    out({ t: "error", error: "Pane nicht gefunden oder herdr läuft nicht" });
    return 1;
  }

  let fastUntil = 0;
  // phone → pane
  let pending = "";
  process.stdin.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
      try {
        const msg = JSON.parse(line) as { t?: string; text?: string; keys?: string[] };
        fastUntil = Date.now() + FAST_FOR_MS;
        if (msg.t === "text" && msg.text) void call("pane.send_text", { pane_id: pane, text: msg.text.slice(0, 4096) });
        else if (msg.t === "keys" && Array.isArray(msg.keys))
          void call("pane.send_keys", { pane_id: pane, keys: msg.keys.slice(0, 32).map(String) });
      } catch {}
    }
  });
  let stdinOpen = true;
  process.stdin.on("end", () => {
    stdinOpen = false;
  });
  process.stdin.on("close", () => {
    stdinOpen = false;
  });
  process.stdin.resume();

  // pane → phone: re-read the screen only when herdr's revision moved
  let revision: unknown;
  let last = "";
  let lastPing = Date.now();
  while (stdinOpen) {
    const info = await call("pane.get", { pane_id: pane });
    const p = info?.pane as { revision?: unknown } | undefined;
    if (!p) {
      out({ t: "closed" });
      break;
    }
    if (p.revision !== revision) {
      revision = p.revision;
      const read = await call("pane.read", { pane_id: pane, source: "visible", format: "ansi", strip_ansi: false });
      const text = ((read?.read as { text?: string } | undefined)?.text ?? "").replace(/\n+$/, "");
      if (text !== last) {
        last = text;
        out({ t: "screen", ansi: text, ...screenSize(text) });
      }
    }
    if (Date.now() - lastPing > 20_000) {
      lastPing = Date.now();
      out({ t: "ping" });
    }
    await Bun.sleep(Date.now() < fastUntil ? FAST_MS : SLOW_MS);
  }
  return 0;
}
