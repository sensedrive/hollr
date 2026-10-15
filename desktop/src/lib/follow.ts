// The omp chat as a stream (`hollr gate follow`, see src-tauri/src/follow.rs) instead of a
// `timeline` poll: a full timeline first, then only what changed.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Timeline, TimelineItem } from "./api";

export type FollowMsg =
  | ({ t: "full" } & Timeline)
  | { t: "delta"; head: Omit<Timeline, "items">; order: string[]; items: TimelineItem[]; etag?: string }
  | { t: "ping" }
  | { t: "error"; error: string };

/** What a stream line means for the view. */
export type Applied =
  | { kind: "timeline"; timeline: Timeline }
  | { kind: "none" }
  /** a delta that doesn't fit what we have: reconnect (the server starts with a full one) */
  | { kind: "resync" }
  | { kind: "error"; error: string }
  /** an older server without `follow`: poll instead */
  | { kind: "unsupported" };

/** Delta onto the current timeline: id→item overlaid with the new/changed items, ordered by `order`. */
export function mergeDelta(cur: Timeline, d: Extract<FollowMsg, { t: "delta" }>): Timeline | null {
  const byId = new Map(cur.items.map((i) => [i.id, i]));
  for (const i of d.items) byId.set(i.id, i);
  const items: TimelineItem[] = [];
  for (const id of d.order) {
    const i = byId.get(id);
    if (!i) return null;
    items.push(i);
  }
  // head is the whole timeline minus items: fields that went away (todo, turnStartedAt …) go too
  return { ...d.head, items, etag: d.etag };
}

export function applyLine(cur: Timeline | null, line: string): Applied {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line);
  } catch {
    return { kind: "none" };
  }
  if (!m || typeof m !== "object") return { kind: "none" };
  if (m.t === undefined && typeof m.error === "string") {
    return m.error === "not_allowed" ? { kind: "unsupported" } : { kind: "error", error: m.error };
  }
  const msg = m as FollowMsg;
  switch (msg.t) {
    case "full": {
      const { t: _, ...timeline } = msg;
      return { kind: "timeline", timeline };
    }
    case "delta": {
      if (!cur) return { kind: "resync" };
      const timeline = mergeDelta(cur, msg);
      return timeline ? { kind: "timeline", timeline } : { kind: "resync" };
    }
    case "error":
      return { kind: "error", error: msg.error };
    default:
      return { kind: "none" };
  }
}

/** Waits before reconnect number `n` (0, 2, 4, 8, 15 s). */
export const backoff = (n: number) => (n <= 0 ? 0 : Math.min(2 ** n, 15) * 1000);

/** Follows one pane until the returned stop is called; reconnects when the stream ends. */
export function followTimeline(
  server: string,
  pane: string,
  on: {
    timeline: (tl: Timeline) => void;
    error: (e: string) => void;
    /** the server has no `follow` – the stream is over, poll instead */
    unsupported: () => void;
  },
): () => void {
  let stopped = false;
  let id: number | null = null;
  /** events that arrived before follow_start returned the id */
  let early: { id: number; line?: string; end?: boolean }[] = [];
  let cur: Timeline | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unlisten: (() => void) | undefined;

  const end = () => {
    if (id !== null) invoke("follow_stop", { id }).catch(() => {});
    id = null;
  };
  const reconnect = () => {
    end();
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(connect, backoff(attempt++));
  };
  const onEvent = (e: { id: number; line?: string; end?: boolean }) => {
    if (e.end) return reconnect();
    if (e.line === undefined) return;
    const a = applyLine(cur, e.line);
    if (a.kind === "timeline") {
      cur = a.timeline;
      attempt = 0;
      on.timeline(a.timeline);
    } else if (a.kind === "resync") {
      cur = null;
      reconnect();
    } else if (a.kind === "error") on.error(a.error);
    else if (a.kind === "unsupported") {
      stopped = true;
      end();
      on.unsupported();
    }
  };
  async function connect() {
    if (stopped) return;
    id = null;
    early = [];
    try {
      const got = await invoke<number>("follow_start", { server, pane });
      if (stopped) return void invoke("follow_stop", { id: got }).catch(() => {});
      id = got;
      for (const e of early.splice(0)) if (e.id === got) onEvent(e);
    } catch (e) {
      on.error(e instanceof Error ? e.message : String(e));
      reconnect();
    }
  }

  listen<{ id: number; line?: string; end?: boolean }>("hollr-follow", (e) => {
    if (stopped) return;
    if (id === null) early.push(e.payload);
    else if (e.payload.id === id) onEvent(e.payload);
  }).then((u) => {
    if (stopped) return u();
    unlisten = u;
    connect();
  });

  return () => {
    stopped = true;
    clearTimeout(timer);
    end();
    unlisten?.();
  };
}
