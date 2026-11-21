/**
 * `hollr gate follow <pane> [limit]`: the chat as a stream. One long-lived process instead of a
 * `timeline` poll every 1.5 s (each poll started a process, ~150 ms): the session file is watched,
 * herdr's status checked every second, and only what changed is sent.
 *   {"t":"full", ...timeline, "etag"}                     first, and after a gap
 *   {"t":"delta", "head":{…}, "order":[ids], "items":[changed items], "etag"}
 *   {"t":"ping"}  every 20 s · {"t":"error","error":"not_found"} when the pane is gone
 */
import { createHash } from "node:crypto";
import { type FSWatcher, statSync, watch } from "node:fs";
import { type ClaudeUsage, claudeFooter, claudeLive, readClaudeLog } from "./claudelog";
import { execHerdr, type Herdr, HerdrError } from "./herdr";
import { parseStartScreen } from "./startscreen";
import { ompLive, type Timeline, TimelineFile, type TimelineItem } from "./timeline";
import { wireJson } from "./wire";

type Snapshot = Record<string, unknown> & { items: TimelineItem[] };

/** What changed since the last line sent: head fields, the id order, and new or changed items. `sent` holds each
 *  item's JSON as it went out – compared as text, not against the last snapshot's objects: the omp timeline is
 *  built as the log grows and changes its items in place, so those objects already hold the new state. */
export function diffTimeline(sent: ReadonlyMap<string, string> | undefined, next: Snapshot) {
  const { items, ...head } = next;
  const order = items.map((i) => i.id);
  const json = new Map(items.map((i) => [i.id, JSON.stringify(i)]));
  if (!sent) return { full: true as const, head, items, order, sent: json };
  const changed = items.filter((i) => sent.get(i.id) !== json.get(i.id));
  return { full: false as const, head, items: changed, order, sent: json };
}

/** How long herdr may keep failing (restarting, busy) before the stream gives up, in ms. */
const FAIL_MS = 30_000;

/** herdr names a pane or agent it doesn't know (`pane_not_found`, `agent_not_found` …): the chat is gone. Its
 *  other refusals (`server_unavailable` while it restarts, `internal_error`, `agent_timeout` …) and a failed
 *  call are a hiccup – reporting those as not_found told the app the chat was closed. */
export function paneGone(err: unknown): boolean {
  return err instanceof HerdrError && err.code.endsWith("_not_found");
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
      process.stdout.write(`${wireJson(line)}\n`);
    } catch {
      process.exit(0);
    }
  };
  let stopped = false;
  const stop = () => {
    stopped = true;
    // a herdr call that hangs keeps the loop from ever seeing `stopped`: never outlive the client for long
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.stdin.resume();

  /** each item's JSON as last sent */
  let sent: ReadonlyMap<string, string> | undefined;
  let lastEtag = "";
  let file: string | undefined;
  /** the omp log, parsed as it grows */
  let ompLog: TimelineFile | undefined;
  let watcher: FSWatcher | undefined;
  let watchedIno = -1;
  /** inode, size and mtime of the session file at the last read */
  let stamp = "";
  let dirty = true;
  let lastStatus = "";
  let lastScreenAt = 0;
  /** omp: its footer – the whole screen while the session is fresh (its start screen); Claude: its screen */
  let screen = "";
  let lastPing = Date.now();
  /** parsed log, re-read only when it was written */
  let cached: Timeline | undefined;
  let usage: ClaudeUsage | undefined;
  /** since when every herdr call failed */
  let failingSince: number | undefined;

  const unwatch = () => {
    watcher?.close();
    watcher = undefined;
    watchedIno = -1;
  };
  const rewatch = (f: string, ino: number) => {
    unwatch();
    try {
      // a write to the session log = something to show (debounced by the loop)
      watcher = watch(f, () => {
        dirty = true;
      });
      watcher.on("error", unwatch);
      watchedIno = ino;
    } catch {
      // gone again – next round
    }
  };

  /** `changed`: the log was written since the last read (taken before reading, so a write during
   *  the read is not lost) */
  const snapshot = async (changed: boolean): Promise<Snapshot> => {
    const agent = await herdr.agent(pane);
    let st: { ino: number; size: number; mtimeMs: number } | undefined;
    try {
      // herdr's hook names the session file before the agent writes it: it counts once it exists
      st = agent.sessionFile ? statSync(agent.sessionFile) : undefined;
    } catch {}
    const f = st ? agent.sessionFile : undefined;
    if (f !== file) {
      // another session in the pane (/new, a resumed one): its own log, its own ids
      unwatch();
      file = f;
      ompLog = undefined;
      cached = undefined;
      stamp = "";
    }
    // fs.watch is the fast path, this stat every round the safety net: inotify watches the inode, and omp
    // rewrites its session atomically (a new inode under the same name) – the watcher went quiet and the chat
    // froze for good while herdr's status, and the terminal, went on
    if (f && st && st.ino !== watchedIno) rewatch(f, st.ino);
    const now = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : "";
    const claude = agent.kind === "claude";
    if (!cached || changed || now !== stamp) {
      stamp = now;
      if (claude) {
        const log = file
          ? await readClaudeLog(file, limit)
          : { timeline: { agent: "claude" as const, items: [], jobs: [], running: false, waiting: false }, usage: {} };
        cached = log.timeline;
        usage = log.usage;
      } else {
        if (file) ompLog ??= new TimelineFile(file);
        cached = ompLog ? await ompLog.read(limit) : { items: [], jobs: [], running: false, waiting: false };
      }
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
    const timeline = ompLive(cached, agent.status);
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
    let next: Snapshot | undefined;
    try {
      next = await snapshot(changed);
      failingSince = undefined;
    } catch (err) {
      if (paneGone(err)) {
        out({ t: "error", error: "not_found" });
        break;
      }
      failingSince ??= Date.now();
      if (Date.now() - failingSince >= FAIL_MS) {
        out({ t: "error", error: err instanceof Error ? err.message : String(err) });
        break;
      }
      if (changed) dirty = true;
    }
    if (next) {
      const etag = createHash("sha1").update(JSON.stringify(next)).digest("base64url").slice(0, 16);
      if (etag !== lastEtag) {
        const d = diffTimeline(sent, next);
        if (d.full) out({ t: "full", ...next, etag });
        else out({ t: "delta", head: d.head, order: d.order, items: d.items, etag });
        sent = d.sent;
        lastEtag = etag;
      }
    }
    if (Date.now() - lastPing > 20_000) {
      lastPing = Date.now();
      out({ t: "ping" });
    }
    // wake on a log write (checked every 100 ms) or after a second for herdr's status; while herdr fails, once a
    // second however much the log is written (a retry on every write spun through the failures in no time)
    const failing = failingSince !== undefined;
    for (let waited = 0; waited < 1000 && (failing || !dirty) && !stopped; waited += 100) await Bun.sleep(100);
    if (dirty && !failing) await Bun.sleep(60); // let omp finish the line it is writing
  }
  unwatch();
  return 0;
}
