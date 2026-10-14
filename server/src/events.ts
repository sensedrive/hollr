/**
 * `hollr gate events` – a live change feed for the apps, so they don't have to poll.
 * Subscribes to herdr's socket API and writes one JSON line per burst of changes:
 *   {"t":"ready"} once, {"t":"changed","spaces":true|false} (coalesced, ≤ 4/s), {"t":"ping"} every 20 s.
 * Pane output alone (revision bumps) is not a change – only structure, cwd, title and agent status.
 * Ends when herdr goes away or the SSH channel closes; the apps reconnect.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.closed",
  "workspace.updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "worktree.created",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.exited",
  "pane.moved",
  "pane.agent_detected",
];

interface PaneState {
  agent_status?: string;
  cwd?: string;
  title?: string;
  agent?: string;
}

/** What an event means for the apps: nothing, the session tree, or also the spaces list. */
export function classify(
  event: { event?: string; data?: { pane?: PaneState & { pane_id?: string } } },
  panes: Map<string, string>,
): "none" | "tree" | "spaces" {
  const kind = event.event ?? "";
  if (kind.startsWith("workspace_") || kind.startsWith("worktree_")) return "spaces";
  if (kind === "pane_updated") {
    const p = event.data?.pane;
    if (!p?.pane_id) return "none";
    const key = [p.agent_status, p.cwd, p.title, p.agent].join("|");
    if (panes.get(p.pane_id) === key) return "none";
    const known = panes.has(p.pane_id);
    panes.set(p.pane_id, key);
    return known ? "tree" : "none";
  }
  if (kind === "pane_closed") return "tree";
  return kind ? "tree" : "none";
}

export function herdrSocket(): string {
  return Bun.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

export async function runEvents(): Promise<number> {
  const out = (line: object) => {
    try {
      process.stdout.write(`${JSON.stringify(line)}\n`);
    } catch {
      process.exit(0);
    }
  };
  const panes = new Map<string, string>();
  let pending: "none" | "tree" | "spaces" = "none";
  let buf = "";
  const { promise: finished, resolve: done } = Promise.withResolvers<number>();
  let stopping = false;

  let sock: Awaited<ReturnType<typeof Bun.connect>>;
  try {
    sock = await Bun.connect({
      unix: herdrSocket(),
      socket: {
        data(_s, chunk) {
          buf += chunk.toString();
          for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            try {
              const msg = JSON.parse(line);
              if (msg.error) {
                out({ t: "error", error: msg.error.message ?? "herdr" });
                done(1);
                return;
              }
              if (msg.result?.type === "subscription_started") {
                out({ t: "ready" });
                continue;
              }
              const c = classify(msg, panes);
              if (c === "spaces" || (c === "tree" && pending === "none")) pending = c;
            } catch {}
          }
        },
        close() {
          if (!stopping) out({ t: "closed" });
          done(1);
        },
        error() {
          done(1);
        },
      },
    });
  } catch {
    out({ t: "error", error: "herdr läuft nicht" });
    return 1;
  }
  sock.write(
    `${JSON.stringify({
      id: "hollr-events",
      method: "events.subscribe",
      params: { subscriptions: SUBSCRIPTIONS.map((type) => ({ type })) },
    })}\n`,
  );
  const flush = setInterval(() => {
    if (pending === "none") return;
    out({ t: "changed", spaces: pending === "spaces" });
    pending = "none";
  }, 250);
  const ping = setInterval(() => out({ t: "ping" }), 20_000);
  // the SSH channel closing closes stdin: stop then
  process.stdin.on("end", () => done(0));
  process.stdin.on("close", () => done(0));
  process.stdin.resume();
  const code = await finished;
  stopping = true;
  clearInterval(flush);
  clearInterval(ping);
  sock.end();
  return code;
}
