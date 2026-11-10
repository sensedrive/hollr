// "Braucht dich" state: which agents wait for the user, what they ask, and what was already answered or
// dismissed (memory only). The count works from the tree statuses alone; the dashboard additionally fetches
// the timelines of those panes (ETag, at most every 5 s each) for question, options and last answer.
import * as api from "./api";
import { history } from "./agent";
import { buildEntries, fromHistory, fromTimeline, isDue, wantsYou, type InboxDetail, type InboxEntry } from "./inbox";
import { allPanes, refresh, type PaneRef } from "./store.svelte";
import { isHidden } from "./hiddenSpaces.svelte";

export type { InboxEntry } from "./inbox";

const SEEN_KEY = "hollr.inbox.seen";
const SINCE_KEY = "hollr.inbox.since";
const STATUS_KEY = "hollr.inbox.status";

function loadNums(key: string): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number") out[k] = v;
    return out;
  } catch {
    return {};
  }
}
function loadStrings(key: string): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}
const persist = (key: string, value: object) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: seen state lasts this session only */
  }
};

export const inbox = $state({
  details: {} as Record<string, InboxDetail | undefined>,
  /** "serverId|pane" → when it was first seen waiting/finished */
  since: loadNums(SINCE_KEY) as Record<string, number | undefined>,
  dismissed: {} as Record<string, boolean | undefined>,
  /** "serverId|pane" → last time that session was open in front of the user (see markSeen) */
  seen: loadNums(SEEN_KEY) as Record<string, number | undefined>,
  answered: {} as Record<string, number | undefined>,
  /** a failed answer, per entry key */
  errors: {} as Record<string, string | undefined>,
  /** bumped every few seconds so answered entries come back on time */
  now: Date.now(),
});

/** not reactive: fetch bookkeeping per pane */
const etags: Record<string, string | undefined> = {};
const lastFetch: Record<string, number | undefined> = {};
const lastStatus: Record<string, string | undefined> = loadStrings(STATUS_KEY);
const inflight = new Set<string>();

const agentPanes = () => allPanes().filter((r) => r.pane.agent);

/** The inbox with its pane refs (reactive: reads app.trees and the inbox state). Spaces taken off the list
 *  stay out unless the agent waits for you. */
export function inboxEntries(): (InboxEntry & { ref: PaneRef })[] {
  const refs = new Map(agentPanes().filter((r) => !isHidden(r)).map((r) => [r.id, r]));
  return buildEntries([...refs.values()].map((r) => ({ id: r.id, status: r.pane.status })), inbox, inbox.now).map((e) => ({
    ...e,
    ref: refs.get(e.id)!,
  }));
}

/** After a tree refresh: note when panes started waiting, forget the details of the rest. Call untracked. */
export function trackInbox(now = Date.now()) {
  const seen = new Set<string>();
  let dirty = false;
  for (const r of agentPanes()) {
    seen.add(r.id);
    const status = r.pane.status;
    if (lastStatus[r.id] !== status) {
      lastStatus[r.id] = status;
      if (wantsYou(status)) inbox.since[r.id] = now;
      else forget(r.id);
      dirty = true;
      // a status change means a new turn may be there – fetch on the next round
      lastFetch[r.id] = undefined;
    }
  }
  for (const id of Object.keys(lastStatus)) if (!seen.has(id)) forget(id), delete lastStatus[id], (dirty = true);
  inbox.now = now;
  if (dirty) {
    persist(SINCE_KEY, inbox.since);
    persist(SEEN_KEY, inbox.seen);
    persist(STATUS_KEY, lastStatus);
  }
}

function forget(id: string) {
  delete inbox.details[id];
  delete inbox.since[id];
  delete inbox.seen[id];
  delete etags[id];
  delete lastFetch[id];
}

/** Fetches the detail of every waiting/finished pane that is due. Failures just leave the entry plain. */
export async function fetchInbox(now = Date.now()) {
  inbox.now = now;
  await Promise.all(
    agentPanes()
      .filter((r) => wantsYou(r.pane.status) && isDue(lastFetch[r.id], now) && !inflight.has(r.id))
      .map((r) => load(r, now)),
  );
}

async function load(r: PaneRef, now: number) {
  inflight.add(r.id);
  lastFetch[r.id] = now;
  const status = r.pane.status;
  // the pane moved on while we waited for the answer → drop it
  const current = () => lastStatus[r.id] === status;
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

/** Hide until the next event of that pane. */
export const dismiss = (e: InboxEntry) => (inbox.dismissed[e.key] = true);

/** The user has this session open right now: its result (done / error) up to now counts as seen. */
export function markSeen(id: string, now = Date.now()) {
  const prev = inbox.seen[id];
  if (prev !== undefined && prev >= (inbox.since[id] ?? 0)) return;
  inbox.seen[id] = now;
  persist(SEEN_KEY, inbox.seen);
}

/** A finished session whose window was open after it finished. A newer result (status flipped again) counts fresh. */
export function resultSeen(id: string): boolean {
  const seen = inbox.seen[id];
  if (seen === undefined) return false;
  const since = inbox.since[id];
  return since === undefined || seen >= since;
}

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
