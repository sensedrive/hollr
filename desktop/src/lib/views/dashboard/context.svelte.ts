// What each session on the dashboard is about (TODO, current step, last words, branch) and the web ports of
// every server. Fetched only while the dashboard shows: omp's timeline (ETag, 40 items), other agents' session
// log; every 4 s while a session works, else every 20 s. Ports every 30 s.
import * as api from "$lib/api";
import { history, ports as loadPorts, type WebPort } from "$lib/agent";
import { contextFromHistory, contextFromTimeline, type Project, type SessionContext } from "$lib/dashboard";
import type { PaneRef } from "$lib/store.svelte";

/** A session as the dashboard lists it. */
export interface WorkRow {
  ref: PaneRef;
  project: Project;
  ctx?: SessionContext;
  /** last activity seen (ms) */
  changed?: number;
  /** dev servers in its project */
  ports: WebPort[];
}

export const sessionCtx = $state({
  byId: {} as Record<string, SessionContext | undefined>,
  /** "serverId|pane" → last change this app saw (status or content, ms) */
  changed: {} as Record<string, number | undefined>,
  ports: {} as Record<string, WebPort[] | undefined>,
});

/** not reactive: fetch bookkeeping per pane */
const etags: Record<string, string | undefined> = {};
const lastFetch: Record<string, number | undefined> = {};
const lastStatus: Record<string, string | undefined> = {};
const fingerprint: Record<string, string | undefined> = {};
const inflight = new Set<string>();
const portsAt: Record<string, number | undefined> = {};

/** Fetches the context of every agent session in `refs` that is due. Failures keep what was there. */
export async function fetchContexts(refs: PaneRef[], now = Date.now()) {
  const due: PaneRef[] = [];
  for (const r of refs) {
    if (!r.pane.agent) continue;
    const status = r.pane.status;
    if (lastStatus[r.id] !== status) {
      // a status change is activity, and a new turn may be there
      if (lastStatus[r.id] !== undefined) sessionCtx.changed[r.id] = now;
      lastStatus[r.id] = status;
      lastFetch[r.id] = undefined;
    }
    const every = status === "working" ? 4000 : 20_000;
    if (!inflight.has(r.id) && (lastFetch[r.id] === undefined || now - lastFetch[r.id]! >= every)) due.push(r);
  }
  await Promise.all(due.map((r) => load(r, now)));
}

async function load(r: PaneRef, now: number) {
  inflight.add(r.id);
  lastFetch[r.id] = now;
  try {
    let ctx: SessionContext;
    if (r.pane.agent === "omp") {
      const tl = await api.timeline(r.server.id, r.pane.pane, sessionCtx.byId[r.id] ? etags[r.id] : undefined, 40);
      if (!tl) return;
      etags[r.id] = tl.etag;
      ctx = contextFromTimeline(tl);
    } else {
      const h = await history(r.server.id, r.pane.pane, 30);
      ctx = contextFromHistory(h.events ?? [], r.pane.status === "working");
    }
    const print = JSON.stringify(ctx);
    if (fingerprint[r.id] !== undefined && fingerprint[r.id] !== print) sessionCtx.changed[r.id] = Date.now();
    else if (sessionCtx.changed[r.id] === undefined && ctx.turnStartedAt) sessionCtx.changed[r.id] = ctx.turnStartedAt;
    fingerprint[r.id] = print;
    sessionCtx.byId[r.id] = ctx;
  } catch {
    // keep what we had
  } finally {
    inflight.delete(r.id);
  }
}

/** Web ports per server (dev servers a session started show as a quick "open" on its card). */
export async function fetchPorts(servers: string[], now = Date.now()) {
  await Promise.all(
    servers
      .filter((s) => now - (portsAt[s] ?? 0) >= 30_000)
      .map(async (s) => {
        portsAt[s] = now;
        try {
          sessionCtx.ports[s] = await loadPorts(s);
        } catch {}
      }),
  );
}
