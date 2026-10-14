/**
 * `hollr watch`: long-running watcher (systemd --user) that turns herdr agent state
 * changes into push notifications – waiting for you, finished, failed.
 */

import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { execHerdr, Herdr, type TreeWorkspace } from "./herdr";
import { log } from "./log";
import { hostKeyFingerprint } from "./pairing";
import { type Notice, pushConfig, pushDevices, sendNotice } from "./push";
import { findSessionFile } from "./sessionlog";
import { usageLimits } from "./spaces";
import { readTimeline } from "./timeline";
import { prune, UsageRecorder } from "./usagehistory";

interface Seen {
  status: string;
  /** when the agent started working */
  since: number;
  /** finished, waiting to confirm it stays idle */
  pendingDone?: number;
}

const POLL_MS = 2000;
/** a turn must last this long to be worth a "done" notification */
const MIN_WORK_MS = 5000;
/** idle must hold this long (omp flips to idle between some steps) */
const CONFIRM_MS = 3500;

const isIdle = (s: string) => s === "idle" || s === "done";

/** Pure state machine, testable: returns the events for one poll. */
export function diffStates(
  seen: Map<string, Seen>,
  agents: Array<{ pane: string; status: string }>,
  now: number,
): Array<{ pane: string; kind: "waiting" | "done"; workedMs: number }> {
  const events: Array<{ pane: string; kind: "waiting" | "done"; workedMs: number }> = [];
  const present = new Set<string>();
  for (const a of agents) {
    present.add(a.pane);
    const prev = seen.get(a.pane);
    if (!prev) {
      seen.set(a.pane, { status: a.status, since: now });
      continue;
    }
    if (a.status === "working" && prev.status !== "working") {
      // a pending "done" that turned back into work was just a pause
      seen.set(a.pane, { status: "working", since: prev.pendingDone ? prev.since : now });
      continue;
    }
    if (a.status === "blocked" && prev.status !== "blocked") {
      events.push({ pane: a.pane, kind: "waiting", workedMs: now - prev.since });
      seen.set(a.pane, { status: "blocked", since: prev.since });
      continue;
    }
    if (isIdle(a.status) && prev.status === "working") {
      seen.set(a.pane, { status: a.status, since: prev.since, pendingDone: now });
      continue;
    }
    if (isIdle(a.status) && prev.pendingDone && now - prev.pendingDone >= CONFIRM_MS) {
      const worked = prev.pendingDone - prev.since;
      if (worked >= MIN_WORK_MS) events.push({ pane: a.pane, kind: "done", workedMs: worked });
      seen.set(a.pane, { status: a.status, since: now });
      continue;
    }
    if (a.status !== prev.status) seen.set(a.pane, { ...prev, status: a.status });
  }
  for (const pane of [...seen.keys()]) if (!present.has(pane)) seen.delete(pane);
  return events;
}

function liveLocked(pane: string): boolean {
  const base = Bun.env.XDG_RUNTIME_DIR || tmpdir();
  return existsSync(join(base, "hollr", `${pane.replace(/[^\w]/g, "_")}.lock`));
}

function plain(markdown: string, max = 220): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>|]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

/** Text for the notification: the agent's last answer, its question, or the screen. */
async function describe(
  herdr: Herdr,
  pane: string,
  kind: "waiting" | "done",
): Promise<{ body: string; error?: boolean; fallback?: boolean }> {
  try {
    const agent = await herdr.agent(pane);
    const file =
      agent.sessionFile ?? (agent.kind === "omp" ? findSessionFile(agent.cwd, 0) : undefined);
    if (file) {
      const tl = await readTimeline(file, 30);
      const items = [...tl.items].reverse();
      if (kind === "waiting") {
        const ask = items.find((i) => i.k === "ask" && i.pending);
        if (ask && ask.k === "ask") {
          const options = ask.options.length ? ` (${ask.options.slice(0, 3).join(" / ")})` : "";
          return { body: plain(ask.question + options) };
        }
      } else {
        const end = items.find((i) => i.k === "end");
        if (end && end.k === "end" && end.status === "error") {
          return { body: plain(`Fehler: ${end.error ?? "unbekannt"}`), error: true };
        }
        const text = items.find((i) => i.k === "text");
        if (text && text.k === "text") return { body: plain(text.text) };
      }
    }
  } catch {}
  const screen = await execHerdr([
    "agent",
    "read",
    pane,
    "--source",
    "visible",
    "--lines",
    "14",
  ]).catch(() => "");
  const lines = (typeof screen === "string" ? screen : "")
    .split("\n")
    .map((l) => l.replace(/[│╭╮╰╯─]+/g, " ").trim())
    .filter((l) => l.length > 2);
  return {
    body: plain(lines.slice(-4).join(" · ")) || (kind === "waiting" ? "Wartet auf dich" : "Fertig"),
    fallback: !plain(lines.slice(-4).join(" · ")),
  };
}

function labels(
  tree: TreeWorkspace[],
  pane: string,
): { tab: string; workspace: string; agent: string } {
  for (const w of tree)
    for (const t of w.tabs)
      for (const p of t.panes)
        if (p.pane === pane) return { tab: t.label, workspace: w.label, agent: p.agent ?? "Shell" };
  return { tab: pane, workspace: "", agent: "Agent" };
}

export async function runWatch(): Promise<number> {
  const herdr = new Herdr();
  const seen = new Map<string, Seen>();
  let fp = "";
  try {
    fp = hostKeyFingerprint();
  } catch {}
  const host = hostname();
  log("watch", `started (push ${pushConfig() ? "ready" : "not configured"})`);
  // usage history (beta): limits every 10 min, agent working time per hour
  const recorder = new UsageRecorder();
  let nextLimits = 0;
  prune();
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, () => {
      stopping = true;
    });
  while (!stopping) {
    try {
      const agents = await herdr.agents();
      recorder.tick(agents.filter((a) => a.status === "working").map((a) => a.kind || "agent"));
      if (Date.now() >= nextLimits) {
        nextLimits = Date.now() + 600_000;
        usageLimits()
          .then((u) => recorder.recordLimits(u.limits))
          .catch(() => {});
      }
      const events = diffStates(seen, agents, Date.now());
      if (events.length && pushConfig() && pushDevices().length) {
        const tree = await herdr.tree();
        for (const e of events) {
          if (liveLocked(e.pane)) continue; // you are talking to it right now
          const where = labels(tree, e.pane);
          const info = await describe(herdr, e.pane, e.kind);
          const kind = info.error ? "error" : e.kind;
          const notice: Notice = {
            title: where.tab,
            subtitle:
              kind === "waiting"
                ? `${where.agent} wartet auf dich`
                : kind === "error"
                  ? `${where.agent} ist mit einem Fehler gestoppt`
                  : `${where.agent} ist fertig · ${duration(e.workedMs)}`,
            body: info.body,
            en: {
              subtitle:
                kind === "waiting"
                  ? `${where.agent} is waiting for you`
                  : kind === "error"
                    ? `${where.agent} stopped with an error`
                    : `${where.agent} is done · ${duration(e.workedMs)}`,
              body: info.fallback ? (kind === "waiting" ? "Waiting for you" : "Done") : undefined,
            },
            thread: `${host}:${e.pane}`,
            collapse: `${e.pane}:${kind}`,
            kind,
            data: { pane: e.pane, fp, host },
          };
          const n = await sendNotice(notice);
          log("watch", `${e.pane} ${kind} → ${n} device(s)`);
        }
      }
    } catch (err) {
      log("watch", `poll failed: ${err instanceof Error ? err.message : err}`);
    }
    await Bun.sleep(POLL_MS);
  }
  recorder.flush();
  return 0;
}
