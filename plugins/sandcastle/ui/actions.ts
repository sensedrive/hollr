/**
 * Changes, all optimistic: the board shows the result at once, the network catches up; a failure rolls the local
 * state back and says why. GitHub (labels, open/closed) goes to this plugin's /api, queue order and ticket flags to
 * the machine's gate (`queue-set`).
 */
import { api, sc } from "./api";
import { derive } from "./derive";
import { placeBefore } from "./model";
import { errorText, hooks, serverLabel, state, toast } from "./state";
import type { Column, Issue, QueueState, TicketFlags } from "./types";

interface Snapshot {
  issues: Issue[] | undefined;
  older: Issue[];
  queues: Map<string, QueueState>;
}

const snapshot = (): Snapshot => ({
  issues: state.board?.issues.map((i) => ({ ...i, labels: [...i.labels] })),
  older: state.olderClosed,
  queues: new Map([...state.queues].map(([k, v]) => [k, { order: [...v.order], tickets: { ...v.tickets } }])),
});

function restore(s: Snapshot): void {
  if (state.board && s.issues) state.board.issues = s.issues;
  state.olderClosed = s.older;
  state.queues = s.queues;
}

/** Replaces one issue in the board data (answer of a write). */
export function putIssue(issue: Issue): void {
  if (!state.board) return;
  const i = state.board.issues.findIndex((x) => x.number === issue.number);
  if (i >= 0) state.board.issues[i] = issue;
  else state.board.issues.unshift(issue);
  state.olderClosed = state.olderClosed.filter((x) => x.number !== issue.number);
}

/** The label/state rules of src/board.ts movePlan, applied locally. */
function applyMove(issue: Issue, to: Column): void {
  const p = derive().project;
  if (!p) return;
  const { queue, grill } = p.labels;
  const drop = (l: string | null) => {
    if (l) issue.labels = issue.labels.filter((x) => x !== l);
  };
  if (to === "done") {
    issue.state = "closed";
    issue.closedAt = new Date().toISOString();
    return;
  }
  issue.state = "open";
  issue.closedAt = null;
  if (to === "queue") {
    drop(grill);
    if (!issue.labels.includes(queue)) issue.labels.push(queue);
  } else if (to === "grill") {
    drop(queue);
    if (grill && !issue.labels.includes(grill)) issue.labels.push(grill);
  } else {
    drop(queue);
    drop(grill);
  }
  issue.updatedAt = new Date().toISOString();
}

function setOrder(server: string, order: number[]): void {
  const q = state.queues.get(server) ?? { order: [], tickets: {} };
  state.queues.set(server, { ...q, order });
}

let busy = 0;
/** Writes in flight: polls must not overwrite the optimistic state with an older answer. */
export const writing = () => busy > 0;

async function optimistic(apply: () => void, remote: () => Promise<void>): Promise<boolean> {
  const before = snapshot();
  apply();
  hooks.render();
  busy++;
  try {
    await remote();
    return true;
  } catch (err) {
    restore(before);
    toast(errorText(err));
    return false;
  } finally {
    busy--;
    hooks.render();
  }
}

/**
 * Moves a ticket to a column; `lane` = the machine for the Sandcastle column, `before` = position in its queue.
 * Between lanes only while queued – the board checks that before calling.
 */
export function moveTicket(n: number, to: Column, lane: string | null = null, before: number | null = null): Promise<boolean> {
  const d = derive();
  const issue = d.issues.get(n);
  if (!issue || !d.project) return Promise.resolve(false);
  const from = d.laneOf.get(n) ?? null;
  const wasQueued = issue.labels.includes(d.project.labels.queue) && issue.state === "open";
  const columnChanges = !(to === "queue" && wasQueued);
  const slug = state.slug;
  // queue files to rewrite: the old lane loses it (if listed), the target lane gets it at the drop position
  const writes = new Map<string, number[]>();
  if (from && from !== lane && state.queues.get(from)?.order.includes(n))
    writes.set(from, (state.queues.get(from)?.order ?? []).filter((x) => x !== n));
  if (to === "queue" && lane) {
    const visible = d.lanes.find((l) => l.server.id === lane)?.order ?? [];
    // write the visible (effective) order so the file states exactly what the lane shows
    writes.set(lane, placeBefore(visible, n, before));
  }
  return optimistic(
    () => {
      if (columnChanges) applyMove(issue, to);
      for (const [server, order] of writes) setOrder(server, order);
    },
    async () => {
      if (columnChanges) {
        const { issue: fresh } = await api<{ issue: Issue }>("/api/move", { slug, n, to });
        putIssue(fresh);
      }
      await Promise.all(
        [...writes].map(async ([server, order]) => {
          const q = await sc.queueSet(server, slug, { order }).catch((err) => {
            throw new Error(`Warteschlange auf ${serverLabel(server)}: ${errorText(err)}`);
          });
          if (slug === state.slug) state.queues.set(server, q);
        }),
      );
    },
  );
}

/** Test flags of one ticket on one machine's queue file. */
export function setFlags(server: string, n: number, flags: TicketFlags): Promise<boolean> {
  const slug = state.slug;
  const tickets = { ...(state.queues.get(server)?.tickets ?? {}), [String(n)]: flags };
  return optimistic(
    () => {
      const q = state.queues.get(server) ?? { order: [], tickets: {} };
      state.queues.set(server, { ...q, tickets });
    },
    async () => {
      const q = await sc.queueSet(server, slug, { tickets });
      if (slug === state.slug) state.queues.set(server, q);
    },
  );
}

export async function editLabels(n: number, add: string[], remove: string[]): Promise<boolean> {
  const d = derive();
  const issue = d.issues.get(n);
  if (!issue || !d.project) return false;
  const slug = state.slug;
  const queueLabel = d.project.labels.queue;
  const lane = d.lanes[0]?.server.id;
  return optimistic(
    () => {
      issue.labels = [...issue.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !issue.labels.includes(l))];
    },
    async () => {
      const { issue: fresh } = await api<{ issue: Issue }>("/api/labels", { slug, n, add, remove });
      putIssue(fresh);
      // the queue label by hand: keep the machine's order in step (append to the first lane, or drop)
      const server = d.laneOf.get(n);
      if (remove.includes(queueLabel) && server) {
        const order = (state.queues.get(server)?.order ?? []).filter((x) => x !== n);
        state.queues.set(server, await sc.queueSet(server, slug, { order }));
      } else if (add.includes(queueLabel) && lane) {
        const order = placeBefore(state.queues.get(lane)?.order ?? [], n, null);
        state.queues.set(lane, await sc.queueSet(lane, slug, { order }));
      }
    },
  );
}
