// "Braucht dich": agents that wait for the user (or just finished) as compact inbox entries.
// Pure part – the timeline → entry rules, ordering and throttling. State and fetching live in inbox.svelte.ts.
import type { HistoryEvent } from "./agent";
import type { Timeline } from "./api";

export type InboxKind = "waiting" | "ask" | "done" | "error";

/** What a pane's timeline (or history) says about the current turn. */
export interface InboxDetail {
  kind: InboxKind;
  /** identifies the turn – a dismissed entry comes back once this changes */
  turn: string;
  question?: string;
  options?: string[];
  /** last answer or error, plain text */
  text?: string;
}

/** A pane as the tree knows it (status working|blocked|idle|done). */
export interface InboxPane {
  id: string;
  status: string;
}

export interface InboxEntry extends InboxDetail {
  id: string;
  /** dismiss/answer key: pane + turn */
  key: string;
  /** first seen in this state (ms) */
  since: number;
}

/** how often one pane's timeline is fetched at most */
export const FETCH_EVERY = 5000;
/** an answered entry stays hidden this long – if the agent still waits afterwards, it comes back */
export const ANSWERED_MS = 15_000;

/** Only waiting and finished agents belong in the inbox. */
export const wantsYou = (status: string) => status === "blocked" || status === "done";

/** Markdown → one plain line, cut at `max` characters. */
export function plain(markdown: string, max = 200): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>|]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** omp's timeline: a pending ask, the error that ended the turn, or the last answer. */
export function fromTimeline(status: string, tl: Pick<Timeline, "items">): InboxDetail {
  const items = tl.items;
  const ask = items.findLast((i) => i.k === "ask" && i.pending);
  if (ask?.k === "ask") {
    // several questions (or multi-select) need the chat: no one-tap options here
    const oneTap = !ask.questions && !ask.multi;
    return { kind: "ask", turn: ask.id, question: plain(ask.question), options: oneTap ? ask.options : [] };
  }
  // only look at the current turn (after the last user message)
  const start = items.findLastIndex((i) => i.k === "user") + 1;
  const turn = items.slice(start);
  const last = items.at(-1)?.id ?? "";
  const text = turn.findLast((i) => i.k === "text");
  const snippet = text?.k === "text" ? plain(text.text) || undefined : undefined;
  if (status === "blocked") return { kind: "waiting", turn: last, text: snippet };
  const end = turn.findLast((i) => i.k === "end");
  if (end?.k === "end" && end.status === "error")
    return { kind: "error", turn: end.id, text: end.error ? plain(end.error) : undefined };
  return { kind: "done", turn: end?.id ?? last, text: snippet };
}

/** Other agents: only the session log's last answer. */
export function fromHistory(status: string, events: HistoryEvent[]): InboxDetail {
  const answer = events.findLast((e) => e.t === "answer");
  const text = answer?.t === "answer" ? plain(answer.text) || undefined : undefined;
  return { kind: status === "blocked" ? "waiting" : "done", turn: `h${events.length}`, text };
}

const RANK: Record<InboxKind, number> = { ask: 0, waiting: 0, error: 1, done: 2 };

/**
 * The inbox: waiting agents first (longest waiting on top), then errors, then finished ones (newest on top).
 * Without a fetched detail the entry is built from the status alone.
 */
export function buildEntries(
  panes: InboxPane[],
  s: {
    details: Record<string, InboxDetail | undefined>;
    since: Record<string, number | undefined>;
    dismissed: Record<string, boolean | undefined>;
    answered: Record<string, number | undefined>;
  },
  now: number,
): InboxEntry[] {
  const out: InboxEntry[] = [];
  for (const p of panes) {
    if (!wantsYou(p.status)) continue;
    const since = s.since[p.id] ?? now;
    const fetched = s.details[p.id];
    // a detail from the other state (e.g. still "done" while the tree already says "blocked") is stale
    const fits = fetched && (p.status === "blocked") === (fetched.kind === "ask" || fetched.kind === "waiting");
    const detail: InboxDetail = fits ? fetched : { kind: p.status === "blocked" ? "waiting" : "done", turn: `@${since}` };
    const key = `${p.id}#${detail.turn}`;
    if (s.dismissed[key]) continue;
    const answered = s.answered[key];
    if (answered && now - answered < ANSWERED_MS) continue;
    out.push({ ...detail, id: p.id, key, since });
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.kind === "done" ? b.since - a.since : a.since - b.since));
}

/** Per pane at most every FETCH_EVERY ms. */
export const isDue = (lastFetch: number | undefined, now: number, every = FETCH_EVERY) =>
  lastFetch === undefined || now - lastFetch >= every;
