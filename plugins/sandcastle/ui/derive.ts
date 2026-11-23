/** Board facts derived from the state, shared by board, details panel and Läufe view. Cheap: recomputed per render. */
import { assignLanes, classify, laneRun, type TicketRun, ticketRuns } from "./model";
import { currentProject, laneServers, state } from "./state";
import type { Column, Issue, Project, Run, Server, TicketFlags } from "./types";

export interface Lane {
  server: Server;
  /** queued tickets of this machine, in its effective order */
  order: number[];
  run: Run | null;
}

export interface Derived {
  project: Project | undefined;
  issues: Map<number, Issue>;
  columns: Record<Exclude<Column, "queue">, Issue[]>;
  lanes: Lane[];
  /** queued tickets when no machine has the repo checked out (no lanes known yet) */
  unlaned: number[];
  laneOf: Map<number, string>;
  runs: Map<number, TicketRun>;
  open: Set<number>;
  stories: Map<number, string>;
}

export function derive(): Derived {
  const project = currentProject();
  const board = state.board;
  const issues = new Map<number, Issue>();
  for (const i of state.olderClosed) issues.set(i.number, i);
  for (const i of board?.issues ?? []) issues.set(i.number, i);
  const columns: Derived["columns"] = { grill: [], backlog: [], done: [] };
  const queued: number[] = [];
  const open = new Set<number>();
  if (project && board)
    for (const i of issues.values()) {
      if (i.state === "open") open.add(i.number);
      const col = classify(i, project.labels, board.hasGrill);
      if (col === "story") continue;
      if (col === "queue") queued.push(i.number);
      else columns[col].push(i);
    }
  const byTime = (a: Issue, b: Issue) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  columns.grill.sort(byTime);
  columns.backlog.sort(byTime);
  columns.done.sort((a, b) => Date.parse(b.closedAt ?? b.updatedAt) - Date.parse(a.closedAt ?? a.updatedAt));

  const servers = laneServers();
  const split = assignLanes(
    queued,
    servers.map((s) => ({ server: s.id, order: state.queues.get(s.id)?.order ?? [] })),
  );
  const laneOf = new Map<number, string>();
  const lanes = servers.map((server) => {
    const order = split.get(server.id) ?? [];
    for (const n of order) laneOf.set(n, server.id);
    return { server, order, run: laneRun(state.statuses.get(server.id), state.slug) };
  });
  return {
    project,
    issues,
    columns,
    lanes,
    unlaned: servers.length ? [] : [...queued].sort((a, b) => a - b),
    laneOf,
    runs: ticketRuns(state.statuses, state.slug),
    open,
    stories: new Map((board?.stories ?? []).map((s) => [s.number, s.title])),
  };
}

/** Per-ticket test flags: the run's copy while it has the ticket, else the lane machine's queue file. */
export function flagsOf(d: Derived, n: number): TicketFlags | null {
  const fromRun = d.runs.get(n)?.issue.flags;
  if (fromRun) return fromRun;
  const server = d.laneOf.get(n);
  return (server && state.queues.get(server)?.tickets[String(n)]) || null;
}

/** Open tickets this one waits for (the loop skips it until they are closed). */
export const openBlockers = (d: Derived, issue: Issue) => issue.blockedBy.filter((b) => b !== issue.number && d.open.has(b));
