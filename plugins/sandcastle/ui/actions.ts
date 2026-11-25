/**
 * Changes, all optimistic: the board shows the result at once, the network catches up; a failure rolls the local
 * state back and says why. GitHub (labels, open/closed) goes to this plugin's /api, queue order and ticket flags to
 * the machine's gate (`queue-set`), JIRA (status, labels, drift) to /api/jira/* and /api/drift/apply.
 */
import { api, sc } from "./api";
import { derive } from "./derive";
import { doubles, homeLane, isBusy, placeBefore, unionOrder } from "./model";
import { errorText, hooks, laneServers, serverLabel, state, toast } from "./state";
import { openChildren } from "./tickets";
import type { Column, Issue, JiraTicket, QueueState, TicketFlags } from "./types";

interface Snapshot {
  issues: Issue[] | undefined;
  older: Issue[];
  queues: Map<string, QueueState>;
  tickets: JiraTicket[] | undefined;
}

const snapshot = (): Snapshot => ({
  issues: state.board?.issues.map((i) => ({ ...i, labels: [...i.labels] })),
  older: state.olderClosed,
  queues: new Map([...state.queues].map(([k, v]) => [k, { order: [...v.order], tickets: { ...v.tickets } }])),
  tickets: state.jira?.tickets.map((t) => ({ ...t, labels: [...t.labels] })),
});

function restore(s: Snapshot): void {
  if (state.board && s.issues) state.board.issues = s.issues;
  state.olderClosed = s.older;
  state.queues = s.queues;
  if (state.jira && s.tickets) state.jira.tickets = s.tickets;
}

/** Replaces one ticket in the JIRA board data (answer of a write). */
export function putTicket(ticket: JiraTicket): void {
  if (!state.jira) return;
  const i = state.jira.tickets.findIndex((t) => t.key === ticket.key);
  if (i >= 0) state.jira.tickets[i] = ticket;
  else state.jira.tickets.push(ticket);
}

const ticketOf = (key: string) => state.jira?.tickets.find((t) => t.key === key);

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

const unknownOp = (err: unknown) => errorText(err).includes("Unbekannte Operation");

/** `queue-add` on the machine; a hollr from before that op gets the same through read + `queue-set`. */
async function laneAdd(server: string, slug: string, add: number[]): Promise<QueueState> {
  try {
    return await sc.queueAdd(server, slug, add);
  } catch (err) {
    if (!unknownOp(err)) throw err;
    return sc.queueSet(server, slug, { order: unionOrder((await sc.queue(server, slug)).order, add) });
  }
}

/** `queue-remove` on the machine; a hollr from before that op gets the same through read + `queue-set`. */
async function laneRemove(server: string, slug: string, remove: number[]): Promise<QueueState> {
  try {
    return await sc.queueRemove(server, slug, remove);
  } catch (err) {
    if (!unknownOp(err)) throw err;
    return sc.queueSet(server, slug, { order: (await sc.queue(server, slug)).order.filter((n) => !remove.includes(n)) });
  }
}

/** Runs a queue file write and keeps its answer; failures name the machine. */
async function laneWrite(server: string, slug: string, write: () => Promise<QueueState>): Promise<void> {
  const q = await write().catch((err) => {
    throw new Error(`Warteschlange auf ${serverLabel(server)}: ${errorText(err)}`);
  });
  if (slug === state.slug) state.queues.set(server, q);
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
 * Between lanes only while queued – the board checks that before calling. Into the queue the lane's file comes
 * before the label (a board that sees the label finds the ticket in a lane and doesn't adopt it into its first
 * lane), out of it the label first; the target file before the source file, so a failure never leaves it in none.
 */
export function moveTicket(n: number, to: Column, lane: string | null = null, before: number | null = null): Promise<boolean> {
  const d = derive();
  const issue = d.issues.get(n);
  if (!issue || !d.project) return Promise.resolve(false);
  const from = d.laneOf.get(n) ?? null;
  const wasQueued = issue.labels.includes(d.project.labels.queue) && issue.state === "open";
  const columnChanges = !(to === "queue" && wasQueued);
  const slug = state.slug;
  // the old lane loses it (if its file names it), the target lane gets it at the drop position
  const source = from && from !== lane && state.queues.get(from)?.order.includes(n) ? from : null;
  // write the visible (effective) order so the file states exactly what the lane shows
  const target = to === "queue" && lane ? placeBefore(d.lanes.find((l) => l.server.id === lane)?.order ?? [], n, before) : null;
  const relabel = async () => {
    if (!columnChanges) return;
    const { issue: fresh } = await api<{ issue: Issue }>("/api/move", { slug, n, to });
    putIssue(fresh);
  };
  return optimistic(
    () => {
      if (columnChanges) applyMove(issue, to);
      if (lane && target) setOrder(lane, target);
      if (source) setOrder(source, (state.queues.get(source)?.order ?? []).filter((x) => x !== n));
    },
    async () => {
      if (lane && target) await laneWrite(lane, slug, () => sc.queueSet(lane, slug, { order: target }));
      else await relabel();
      if (source) await laneWrite(source, slug, () => laneRemove(source, slug, [n]));
      if (target) await relabel();
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

/**
 * Labels by hand. The queue label keeps the machines' files in step: added, the ticket goes to the end of the first
 * online lane's file (file before label) unless a lane names it already; removed, it leaves its lane (label first).
 */
export async function editLabels(n: number, add: string[], remove: string[]): Promise<boolean> {
  const d = derive();
  const issue = d.issues.get(n);
  if (!issue || !d.project) return false;
  const slug = state.slug;
  const queueLabel = d.project.labels.queue;
  const named = laneServers().some((s) => state.queues.get(s.id)?.order.includes(n));
  const home = add.includes(queueLabel) && !named ? homeLane(laneServers())?.id : undefined;
  const server = remove.includes(queueLabel) ? d.laneOf.get(n) : undefined;
  return optimistic(
    () => {
      issue.labels = [...issue.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !issue.labels.includes(l))];
    },
    async () => {
      if (home) await laneWrite(home, slug, () => laneAdd(home, slug, [n]));
      const { issue: fresh } = await api<{ issue: Issue }>("/api/labels", { slug, n, add, remove });
      putIssue(fresh);
      if (server && state.queues.get(server)?.order.includes(n)) await laneWrite(server, slug, () => laneRemove(server, slug, [n]));
    },
  );
}

// ---- JIRA tickets

/** Moves a ticket to another JIRA status (by target status name). */
export function transitionTicket(key: string, to: string): Promise<boolean> {
  const t = ticketOf(key);
  if (!t || t.status === to) return Promise.resolve(false);
  const slug = state.slug;
  const category = state.jira?.statuses.find((s) => s.name === to)?.category ?? t.category;
  return optimistic(
    () => {
      t.status = to;
      t.category = category;
    },
    async () => {
      const { ticket } = await api<{ ticket: JiraTicket }>("/api/jira/transition", { slug, key, to });
      if (slug === state.slug) putTicket(ticket);
    },
  );
}

/**
 * Queues every open child of a ticket on one machine (story and grill ticket are never built): they get the queue
 * label and go to the end of that machine's queue in child order; children waiting on another machine move over,
 * children another machine is already working on stay there. Files first (target, then the old lanes), labels last
 * – as in `moveTicket`.
 */
export function queueChildren(key: string, server: string): Promise<boolean> {
  const t = ticketOf(key);
  const d = derive();
  if (!t || !d.project) return Promise.resolve(false);
  const queueLabel = d.project.labels.queue;
  const children = openChildren(t)
    .map((n) => d.issues.get(n))
    .filter((i): i is Issue => !!i && i.state === "open");
  const movable = children.filter((i) => {
    const from = d.laneOf.get(i.number);
    const phase = d.runs.get(i.number)?.issue.phase;
    return !from || from === server || !phase || phase === "queued";
  });
  if (!movable.length) {
    toast(children.length ? `${key}: alle Kinder laufen schon auf einem anderen Rechner.` : `${key} hat keine offenen Kinder auf GitHub – erst grillen.`, "info");
    return Promise.resolve(false);
  }
  const slug = state.slug;
  const ns = movable.map((i) => i.number);
  const sources = new Map<string, number[]>();
  for (const n of ns) {
    const from = d.laneOf.get(n);
    if (from && from !== server && state.queues.get(from)?.order.includes(n)) sources.set(from, [...(sources.get(from) ?? []), n]);
  }
  let target = d.lanes.find((l) => l.server.id === server)?.order ?? [];
  for (const n of ns) if (!target.includes(n)) target = placeBefore(target, n, null);
  const relabel = movable.filter((i) => !i.labels.includes(queueLabel));
  return optimistic(
    () => {
      for (const i of relabel) applyMove(i, "queue");
      setOrder(server, target);
      for (const [s, gone] of sources) setOrder(s, (state.queues.get(s)?.order ?? []).filter((x) => !gone.includes(x)));
    },
    async () => {
      await laneWrite(server, slug, () => sc.queueSet(server, slug, { order: target }));
      await Promise.all([...sources].map(([s, gone]) => laneWrite(s, slug, () => laneRemove(s, slug, gone))));
      for (const i of relabel) {
        const { issue: fresh } = await api<{ issue: Issue }>("/api/move", { slug, n: i.number, to: "queue" });
        putIssue(fresh);
      }
    },
  );
}

/** Writes one machine's queue order as the dock shows it (whole tickets moved up or down). */
export function setLaneOrder(server: string, order: number[]): Promise<boolean> {
  const slug = state.slug;
  return optimistic(
    () => setOrder(server, order),
    async () => {
      const q = await sc.queueSet(server, slug, { order });
      if (slug === state.slug) state.queues.set(server, q);
    },
  );
}

let adopting = false;
/** after a failed adoption: no new try before (a broken gate would otherwise be asked every second) */
let adoptRetryAt = 0;

/**
 * Gives queued tickets named in no machine's queue file a lane: appends them to the first online lane's file
 * (`derive().adopt`), as the board already shows them – only then does that machine's loop run them. The files
 * are read again right before (another board may have placed them since the last poll) and after (a board on
 * another plugin host, with another first lane, may have adopted them at the same moment: `doubles`).
 */
export async function adoptLanes(): Promise<void> {
  if (adopting || busy || Date.now() < adoptRetryAt || !derive().adopt) return;
  const slug = state.slug;
  const online = laneServers().filter((s) => s.online);
  const readAll = (servers: typeof online) => Promise.all(servers.map(async (s) => ({ server: s.id, q: await sc.queue(s.id, slug) })));
  adopting = true;
  busy++;
  try {
    for (const { server, q } of await readAll(online)) if (slug === state.slug) state.queues.set(server, q);
    const plan = slug === state.slug ? derive().adopt : null;
    if (!plan) return;
    await laneWrite(plan.server, slug, () => laneAdd(plan.server, slug, plan.add));
    const files = await readAll(online);
    const host = (id: string) => state.statuses.get(id)?.machine.host ?? id;
    const extra = doubles(
      plan.add,
      files.map(({ server, q }) => ({ server, host: host(server), order: q.order })),
    );
    for (const [server, ns] of extra) await laneWrite(server, slug, () => laneRemove(server, slug, ns));
  } catch (err) {
    adoptRetryAt = Date.now() + 60_000;
    toast(errorText(err));
  } finally {
    adopting = false;
    busy--;
    hooks.render();
  }
}

/** „Aus dem Lauf nehmen“: the ticket's waiting issues lose the queue label, then leave the machine's queue. */
export function takeOutOfLane(server: string, ns: number[]): Promise<boolean> {
  const d = derive();
  const issues = ns.map((n) => d.issues.get(n)).filter((i): i is Issue => !!i);
  const slug = state.slug;
  return optimistic(
    () => {
      for (const i of issues) applyMove(i, "backlog");
      setOrder(server, (state.queues.get(server)?.order ?? []).filter((n) => !ns.includes(n)));
    },
    async () => {
      for (const i of issues) {
        const { issue: fresh } = await api<{ issue: Issue }>("/api/move", { slug, n: i.number, to: "backlog" });
        putIssue(fresh);
      }
      await laneWrite(server, slug, () => laneRemove(server, slug, ns));
    },
  );
}

/** Labels on the JIRA ticket; the server takes a label written here off the ticket's GitHub issues. */
export function editTicketLabels(key: string, add: string[], remove: string[]): Promise<boolean> {
  const t = ticketOf(key);
  if (!t) return Promise.resolve(false);
  const slug = state.slug;
  const done = optimistic(
    () => {
      t.labels = [...t.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !t.labels.includes(l))];
    },
    async () => {
      const { ticket } = await api<{ ticket: JiraTicket }>("/api/jira/labels", { slug, key, add, remove });
      if (slug === state.slug) putTicket(ticket);
    },
  );
  // GitHub may have lost the same label: fetch it once polls may write again
  done.then((ok) => {
    if (ok) hooks.reloadBoard();
  });
  return done;
}

/** „Angleichen“: product labels from GitHub into the ticket and off GitHub, JIRA status forward. */
export async function applyTicketDrift(key: string): Promise<boolean> {
  const slug = state.slug;
  busy++;
  try {
    const { ticket } = await api<{ ticket: JiraTicket }>("/api/drift/apply", { slug, key });
    if (slug === state.slug) putTicket(ticket);
    toast(`${key} angeglichen`, "info");
    return true;
  } catch (err) {
    toast(errorText(err));
    return false;
  } finally {
    busy--;
    // GitHub lost labels: fetch it fresh now that polls may write again
    hooks.reloadBoard();
    hooks.render();
  }
}

/** Whether any open child of the ticket is being built right now (the card is not moved between lanes then). */
export const ticketBusy = (t: JiraTicket) => openChildren(t).some((n) => isBusy(derive().runs.get(n)?.issue.phase));
