// "Braucht dich" state: which agents wait for the user, what they ask, and what was already seen, dismissed or
// marked unread – that part lives in each server's shared doc (shared.svelte.ts), so the phone shows the same.
// Cards answered from the dashboard hide for a moment (this app only). The count works from the tree statuses
// alone; the dashboard additionally fetches the timelines of those panes (ETag, at most every 5 s each) for
// question, options and last answer.
import * as api from "./api";
import type { Pane } from "./api";
import { history } from "./agent";
import {
  buildEntries, cardStatus, dotFor, fromHistory, fromTimeline, isDue, resultSeen as seenResult, wantsYou,
  type InboxDetail, type InboxEntry, type InboxPane,
} from "./inbox";
import { allPanes, refresh, type PaneRef } from "./store.svelte";
import { isHidden } from "./hiddenSpaces.svelte";
import { shared, showError, type SharedChange, type SharedState } from "./shared.svelte";

export type { InboxEntry } from "./inbox";

export const inbox = $state({
  details: {} as Record<string, InboxDetail | undefined>,
  /** "serverId|pane" → when this app saw it start waiting/finish – stands in for the tree's `since` on servers
   *  before 0.48 */
  noticed: {} as Record<string, number | undefined>,
  /** card key → when it was answered from here (hidden for ANSWERED_MS) */
  answered: {} as Record<string, number | undefined>,
  /** a failed answer, per entry key */
  errors: {} as Record<string, string | undefined>,
  /** bumped every few seconds so answered entries come back on time */
  now: Date.now(),
});

/** not reactive: fetch bookkeeping per pane */
const etags: Record<string, string | undefined> = {};
const lastFetch: Record<string, number | undefined> = {};
/** "status@since" per pane – a new status (or the same one again, later) means a new turn */
const lastState: Record<string, string | undefined> = {};
const inflight = new Set<string>();

const agentPanes = () => allPanes().filter((r) => r.pane.agent);

/** when the pane entered its status: the server's stamp, the same on every device */
const sinceOf = (server: string, pane: Pane) => pane.since ?? inbox.noticed[`${server}|${pane.pane}`] ?? inbox.now;

/** the pane with its marks from the server's shared doc */
function marked(server: string, pane: Pane): InboxPane {
  const doc = shared.of(server);
  return {
    id: `${server}|${pane.pane}`,
    status: pane.status,
    since: sinceOf(server, pane),
    seen: doc.seen[pane.pane],
    dismissed: doc.dismissed[pane.pane],
    unread: doc.unread[pane.pane] === true,
  };
}

/** The inbox with its pane refs (reactive: reads app.trees, the shared docs and the inbox state). Spaces taken
 *  off the list stay out unless the agent waits for you. */
export function inboxEntries(): (InboxEntry & { ref: PaneRef })[] {
  const refs = new Map(agentPanes().filter((r) => !isHidden(r)).map((r) => [r.id, r]));
  return buildEntries([...refs.values()].map((r) => marked(r.server.id, r.pane)), inbox, inbox.now).map((e) => ({
    ...e,
    ref: refs.get(e.id)!,
  }));
}

/** After a tree refresh: note new turns, forget the details of the rest. Call untracked. */
export function trackInbox(now = Date.now()) {
  const alive = new Set<string>();
  for (const r of agentPanes()) {
    alive.add(r.id);
    const state = `${r.pane.status}@${r.pane.since ?? ""}`;
    if (lastState[r.id] === state) continue;
    lastState[r.id] = state;
    if (wantsYou(r.pane.status)) inbox.noticed[r.id] = now;
    else forget(r.id);
    // a new turn may be there – fetch on the next round
    lastFetch[r.id] = undefined;
  }
  for (const id of Object.keys(lastState)) if (!alive.has(id)) forget(id), delete lastState[id];
  inbox.now = now;
}

function forget(id: string) {
  delete inbox.details[id];
  delete inbox.noticed[id];
  delete etags[id];
  delete lastFetch[id];
}

/** Fetches the detail of every pane with a card that is due. Failures just leave the entry plain. */
export async function fetchInbox(now = Date.now()) {
  inbox.now = now;
  await Promise.all(
    agentPanes()
      .filter((r) => wantsYou(cardStatus(marked(r.server.id, r.pane))) && isDue(lastFetch[r.id], now) && !inflight.has(r.id))
      .map((r) => load(r, now)),
  );
}

async function load(r: PaneRef, now: number) {
  inflight.add(r.id);
  lastFetch[r.id] = now;
  const status = cardStatus(marked(r.server.id, r.pane));
  const state = lastState[r.id];
  // the pane moved on while we waited for the answer → drop it
  const current = () => lastState[r.id] === state;
  try {
    if (r.pane.agent === "omp") {
      const tl = await api.timeline(r.server.id, r.pane.pane, inbox.details[r.id] ? etags[r.id] : undefined);
      if (tl && current()) {
        etags[r.id] = tl.etag;
        inbox.details[r.id] = fromTimeline(status, tl);
      }
    } else {
      const h = await history(r.server.id, r.pane.pane, 40);
      if (current()) inbox.details[r.id] = fromHistory(status, h.events ?? []);
    }
  } catch {
    // keep what we had – the entry still shows from the status
  } finally {
    inflight.delete(r.id);
  }
}

/** "Als gesehen markieren": the card goes on every device until the pane's next status. */
export function dismiss(e: InboxEntry & { ref: PaneRef }) {
  const pane = e.ref.pane.pane;
  shared
    .update(e.ref.server.id, () => [
      { path: ["dismissed", pane], value: e.entered },
      { path: ["unread", pane], value: null },
    ])
    .catch(showError);
}

/**
 * The user has these sessions in front of them: a result (done) or question (blocked) up to now counts as seen on
 * every device. `opened`: just navigated there – that uses up a hand-made unread mark; later calls while it stays
 * open (a result coming in meanwhile) leave such a mark alone.
 */
export function markSeen(server: string, panes: Pane[], opened = false) {
  if (!panes.length) return;
  const make = (doc: SharedState) =>
    panes.flatMap((p): SharedChange[] => {
      const unread = doc.unread[p.pane] === true;
      if (unread && !opened) return [];
      const since = p.since ?? inbox.noticed[`${server}|${p.pane}`];
      return [
        ...(unread ? [{ path: ["unread", p.pane], value: null } satisfies SharedChange] : []),
        ...(wantsYou(p.status) && since !== undefined ? [{ path: ["seen", p.pane], value: since } satisfies SharedChange] : []),
      ];
    });
  // unchanged values send nothing; a failure is tried again on the next tree refresh
  shared.update(server, make).catch(() => {});
}

/** A finished session whose result was looked at (here or on the phone). A newer result counts fresh. */
export const resultSeen = (server: string, pane: Pane) => seenResult(marked(server, pane));

/** "Als ungelesen markieren": the blue dot (and a card) comes back on every device until the session is opened. */
export function markUnread(server: string, panes: string[]) {
  shared.update(server, () => panes.map((p): SharedChange => ({ path: ["unread", p], value: true }))).catch(showError);
}

/** The dot a session shows: a seen result is quiet, one marked unread is blue like a fresh result. */
export const dotStatus = (server: string, pane: Pane) => dotFor(marked(server, pane));

/** Optimistically hide, then refresh that pane soon (it comes back if the agent still waits). */
async function act(e: InboxEntry & { ref: PaneRef }, send: () => Promise<unknown>): Promise<boolean> {
  inbox.answered[e.key] = Date.now();
  delete inbox.errors[e.key];
  try {
    await send();
  } catch (err) {
    delete inbox.answered[e.key];
    inbox.errors[e.key] = err instanceof Error ? err.message : String(err);
    return false;
  }
  setTimeout(async () => {
    await refresh(e.ref.server.id);
    lastFetch[e.id] = undefined;
    await fetchInbox();
  }, 800);
  return true;
}

/** Picks option `index` of the pending ask (`turn` is the ask's id – a newer question isn't answered by mistake). */
export const answer = (e: InboxEntry & { ref: PaneRef }, index: number) =>
  act(e, () => api.answer(e.ref.server.id, e.ref.pane.pane, e.turn, [{ options: [index] }]));

/** Several questions or multi-select (AskCard): one pick per question. */
export const answerPicks = (e: InboxEntry & { ref: PaneRef }, ask: string, picks: api.AskPick[]) =>
  act(e, () => api.answer(e.ref.server.id, e.ref.pane.pane, ask, picks));

/** Sends a message like the composer does. */
export const reply = (e: InboxEntry & { ref: PaneRef }, text: string) =>
  act(e, () => api.prompt(e.ref.server.id, e.ref.pane.pane, text));
