/**
 * Live Activities: while an agent works for a while, the phone's lock screen / Dynamic Island shows
 * its current step and todo progress; it turns orange when the agent waits for you and ends when the
 * turn is over. The watcher calls `step()` on every poll; `planActivity` is the pure, tested core.
 */

import type { ActivityState } from "./push";
import type { Timeline } from "./timeline";

/** an agent has to work this long before its activity appears (short turns stay quiet) */
export const START_AFTER_MS = 20_000;
/** progress updates at most this often (Apple budgets activity pushes) */
export const UPDATE_EVERY_MS = 30_000;

export interface Track {
  /** activity running on the phones */
  active: boolean;
  /** when the current turn started (ms) */
  since: number;
  lastStatus?: string;
  lastStep?: string;
  lastAt: number;
}

export type ActivityAction =
  | { event: "start"; state: ActivityState }
  | { event: "update"; state: ActivityState; alert: boolean }
  | { event: "end"; state: ActivityState }
  | undefined;

/**
 * One agent, one poll: what to send. `status` is herdr's (working / blocked / idle / done),
 * `error` = the turn ended with an error.
 */
export function planActivity(
  track: Track,
  status: string,
  state: Omit<ActivityState, "status" | "since">,
  now: number,
  error = false,
): ActivityAction {
  const since = Math.floor(track.since / 1000);
  if (status === "working") {
    const s: ActivityState = { ...state, status: "working", since };
    if (!track.active) return now - track.since >= START_AFTER_MS ? { event: "start", state: s } : undefined;
    const changed = track.lastStatus !== "working" || track.lastStep !== s.step;
    if (changed && (track.lastStatus !== "working" || now - track.lastAt >= UPDATE_EVERY_MS))
      return { event: "update", state: s, alert: false };
    return undefined;
  }
  if (!track.active) return undefined;
  if (status === "blocked") {
    if (track.lastStatus === "waiting") return undefined;
    return { event: "update", state: { ...state, status: "waiting", since }, alert: true };
  }
  // idle / done / gone: the turn is over
  return { event: "end", state: { ...state, status: error ? "error" : "done", since } };
}

/** Current step and todo progress from the session log. */
export function describeProgress(tl: Timeline | undefined, fallback: string) {
  let step = "";
  let todoDone = 0;
  let todoTotal = 0;
  if (tl) {
    for (const phase of tl.todo ?? []) {
      for (const task of phase.tasks) {
        todoTotal++;
        if (task.status === "completed" || task.status === "done") todoDone++;
        else if (!step && task.status === "in_progress") step = task.content;
      }
    }
    for (const item of [...tl.items].reverse()) {
      if (step) break;
      if (item.k === "ask" && item.pending) step = item.question;
      else if (item.k === "tools") {
        const running = item.calls.findLast((c) => c.status === "running") ?? item.calls.at(-1);
        if (running?.label) step = running.label;
      } else if (item.k === "text") step = item.text;
    }
  }
  return { step: clip(step || fallback, 120), todoDone, todoTotal };
}

function clip(text: string, max: number) {
  const one = text.replace(/\s+/g, " ").replace(/[*_`#>]/g, "").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
