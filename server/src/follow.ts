/**
 * `hollr gate follow <pane> [limit]`: the chat as a stream. One long-lived process instead of a
 * `timeline` poll every 1.5 s (each poll started a process, ~150 ms): the session file is watched,
 * herdr's status checked every second, and only what changed is sent.
 *   {"t":"full", ...timeline, "etag"}                     first, and after a gap
 *   {"t":"delta", "head":{…}, "order":[ids], "items":[changed items], "etag"}
 *   {"t":"ping"}  every 20 s · {"t":"error","error":"not_found"} when the pane is gone
 */
import { createHash } from "node:crypto";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { type ClaudeUsage, claudeFooter, claudeLive, readClaudeLog } from "./claudelog";
import { execHerdr, type Herdr } from "./herdr";
import { parseStartScreen } from "./startscreen";
import { readTimeline, type Timeline, type TimelineItem } from "./timeline";

type Snapshot = Record<string, unknown> & { items: TimelineItem[] };

/** What changed between two snapshots: head fields, the id order, and new or changed items. */
export function diffTimeline(prev: Snapshot | undefined, next: Snapshot) {
  const { items, ...head } = next;
  const order = items.map((i) => i.id);
  if (!prev) return { full: true as const, head, items, order };
  const before = new Map(prev.items.map((i) => [i.id, JSON.stringify(i)]));
  const changed = items.filter((i) => before.get(i.id) !== JSON.stringify(i));
  return { full: false as const, head, items: changed, order };
}

export async function runFollow(herdr: Herdr, pane: string, limit: number, statusLineOf: (
  cwd: string,
  screen: string,
  model?: string,
  /** Claude's context/cost from its log, instead of omp's footer on the screen */
  fromLog?: { context?: string; cost?: string },
) => unknown): Promise<number> {
  const out = (line: object) => {
    try {
      process.stdout.write(`${JSON.stringify(line)}\n`);
    } catch {
      process.exit(0);
    }
  };
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.stdin.resume();

  let prev: Snapshot | undefined;
  let lastEtag = "";
  let file: string | undefined;
  let watcher: FSWatcher | undefined;
  let dirty = true;
  let lastStatus = "";
  let lastScreenAt = 0;
  /** omp: its footer – the whole screen while the session is fresh (its start screen); Claude: its screen */
  let screen = "";
  let lastPing = Date.now();
  /** parsed log, re-read only when it was written (a 7 MB log costs ~20 ms per read) */
  let cached: Timeline | undefined;
  let usage: ClaudeUsage | undefined;

  /** `changed`: the log was written since the last read (taken before reading, so a write during
   *  the read is not lost) */
  const snapshot = async (changed: boolean): Promise<Snapshot | undefined> => {
    let agent: Awaited<ReturnType<Herdr["agent"]>>;
    try {
      agent = await herdr.agent(pane);
    } catch {
      return undefined;
    }
    // herdr's hook names the session file before the agent writes it: watch it once it exists (watching a
    // missing file throws, which ended the stream before its first line – the app showed skeletons forever)
    const f = agent.sessionFile && existsSync(agent.sessionFile) ? agent.sessionFile : undefined;
    if (f !== file) {
      cached = undefined;
      watcher?.close();
      watcher = undefined;
      file = undefined;
      if (f) {
        try {
          // a write to the session log = something to show (debounced by the loop)
          watcher = watch(f, () => {
            dirty = true;
          });
          file = f;
        } catch {
          // gone again – next round
        }
      }
    }
    const claude = agent.kind === "claude";
    if (!cached || changed) {
      if (claude) {
        const log = file
          ? await readClaudeLog(file, limit)
          : { timeline: { agent: "claude" as const, items: [], jobs: [], running: false, waiting: false }, usage: {} };
        cached = log.timeline;
        usage = log.usage;
      } else cached = file ? await readTimeline(file, limit) : { items: [], jobs: [], running: false, waiting: false };
    }
    /** nothing said yet: the agent's start screen is the chat's start (version, MCP, update …) */
    const fresh = cached.items.length === 0;
    const due = changed || agent.status !== lastStatus || Date.now() - lastScreenAt > 5000;
    if (claude) {
      // Claude's permission/trust dialogs are only on its screen: read it while herdr says it waits; a fresh
      // session's banner (version, model, plan) sits at its top
      const blocked = agent.status === "blocked";
      if (blocked || (fresh && due)) {
        screen = await herdr.screen(pane, blocked ? 40 : 80).catch(() => "");
        lastScreenAt = Date.now();
      }
      const timeline = claudeLive(cached, agent.status, blocked ? screen : undefined);
      const start = fresh ? parseStartScreen("claude", screen) : undefined;
      lastStatus = agent.status;
      return {
        ...timeline,
        status: agent.status,
        line: statusLineOf(agent.cwd, "", timeline.model, claudeFooter(usage)),
        ...(start ? { start } : {}),
      } as Snapshot;
    }
    const timeline = cached;
    // omp's footer (model, context, cost) – it changes with the log or the status, else every 5 s
    if (due) {
      const lines = fresh ? "80" : "4";
      const read = await execHerdr(["agent", "read", pane, "--source", "visible", "--lines", lines]).catch(() => "");
      screen = typeof read === "string" ? read : "";
      lastScreenAt = Date.now();
    }
    const start = fresh ? parseStartScreen("omp", screen) : undefined;
    lastStatus = agent.status;
    return {
      ...timeline,
      status: agent.status,
      line: statusLineOf(agent.cwd, screen, timeline.model),
      ...(start ? { start } : {}),
    } as Snapshot;
  };

  while (!stopped) {
    const changed = dirty;
    dirty = false;
    const next = await snapshot(changed);
    if (!next) {
      out({ t: "error", error: "not_found" });
      break;
    }
    const etag = createHash("sha1").update(JSON.stringify(next)).digest("base64url").slice(0, 16);
    if (etag !== lastEtag) {
      const d = diffTimeline(prev, next);
      if (d.full) out({ t: "full", ...next, etag });
      else out({ t: "delta", head: d.head, order: d.order, items: d.items, etag });
      prev = next;
      lastEtag = etag;
    }
    if (Date.now() - lastPing > 20_000) {
      lastPing = Date.now();
      out({ t: "ping" });
    }
    // wake on a log write (checked every 100 ms) or after a second for herdr's status
    for (let waited = 0; waited < 1000 && !dirty && !stopped; waited += 100) await Bun.sleep(100);
    if (dirty) await Bun.sleep(60); // let omp finish the line it is writing
  }
  watcher?.close();
  return 0;
}
