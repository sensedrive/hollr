/**
 * Ticket search over every project of this machine (`GET /api/search`, the desktop's ⌘K palette through the
 * `plugins` gate op `api`): the cached JIRA tickets and GitHub issues, plus – for 3 or more characters – a live
 * JIRA search per project, so old done tickets are found too. Every source has its own time limit: a cold cache
 * or a slow JIRA leaves its hits out rather than holding up the answer (the cache keeps loading meanwhile).
 */
import type { BoardCache } from "./cache";
import type { JiraAccess, JiraTicket } from "./jira";
import type { JiraCache } from "./jiracache";
import type { Projects } from "./projects";
import type { Issue, Project } from "./types";

export interface SearchCtx {
  projects: Projects;
  boards: BoardCache;
  tickets: JiraCache;
  jira: JiraAccess;
}

export interface SearchItem {
  kind: "jira" | "issue";
  key?: string;
  n?: number;
  title: string;
  status: string;
  type?: string;
  slug: string;
  project: string;
}

/** A search hit before ranking: `updated` (ISO) orders the hits that aren't exact. */
export interface Candidate extends SearchItem {
  updated: string;
}

const SOURCE_MS = 4000;
const LIVE_MAX = 10;
const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/** The query's words, lower case. */
export const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * The candidates every word of `q` matches (in key or `#n` and title, case-insensitively), without duplicates:
 * the exact key or `#n` (also a bare number) first, then the newest by update; at most `limit`.
 */
export function matchAndRank(candidates: Candidate[], q: string, limit: number): SearchItem[] {
  const ws = words(q);
  if (!ws.length) return [];
  const exact = q.trim().toLowerCase().replace(/^#/, "");
  const id = (c: Candidate) => (c.kind === "jira" ? `j:${c.key}` : `i:${c.slug}#${c.n}`);
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const hay = `${c.kind === "jira" ? c.key : `#${c.n}`} ${c.title}`.toLowerCase();
    if (!ws.every((w) => hay.includes(w))) continue;
    const prev = best.get(id(c));
    if (!prev || prev.updated < c.updated) best.set(id(c), c);
  }
  const isExact = (c: Candidate) => (c.kind === "jira" ? c.key?.toLowerCase() === exact : String(c.n) === exact);
  return [...best.values()]
    .sort((a, b) => Number(isExact(b)) - Number(isExact(a)) || b.updated.localeCompare(a.updated))
    .slice(0, limit)
    .map(({ updated: _, ...item }) => item);
}

async function within<T>(p: Promise<T>, ms = SOURCE_MS): Promise<T | undefined> {
  const { promise: timeout, resolve } = Promise.withResolvers<undefined>();
  const timer = setTimeout(resolve, ms);
  try {
    return await Promise.race([p, timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const fromTicket = (p: Project, t: JiraTicket): Candidate => ({
  kind: "jira",
  key: t.key,
  title: t.summary,
  status: t.status,
  type: t.type,
  slug: p.slug,
  project: p.name,
  updated: t.updated,
});

const fromIssue = (p: Project, i: Issue): Candidate => ({
  kind: "issue",
  n: i.number,
  title: i.title,
  status: i.state === "open" ? "offen" : "geschlossen",
  slug: p.slug,
  project: p.name,
  updated: i.updatedAt,
});

/** Lucene's reserved characters would make JIRA refuse the text query. */
const textQuery = (q: string) => q.replace(/[+\-&|!(){}[\]^"~*?:\\/#]/g, " ").replace(/\s+/g, " ").trim();

/** JIRA itself, for tickets the cache doesn't hold (done before its window): the key, else the text. */
async function live(ctx: SearchCtx, p: Project, key: string, q: string): Promise<JiraTicket[]> {
  const client = ctx.jira.client(p);
  const asKey = q.trim().toUpperCase();
  if (KEY.test(asKey)) return asKey.startsWith(`${key}-`) ? [await client.ticket(asKey)] : [];
  const text = textQuery(q);
  return text.length >= 3 ? client.searchText(key, text, LIVE_MAX) : [];
}

async function ofProject(ctx: SearchCtx, p: Project, q: string): Promise<Candidate[]> {
  const key = p.jira.projectKey;
  const [gh, cached, found] = await Promise.all([
    within(ctx.boards.current(p.slug)),
    key ? within(ctx.tickets.board(key, p.jira.states)) : undefined,
    key && q.trim().length >= 3 ? within(live(ctx, p, key, q)) : undefined,
  ]);
  return [
    ...(gh?.snap.issues ?? []).map((i) => fromIssue(p, i)),
    ...(cached?.snap.tickets ?? []).map((t) => fromTicket(p, t)),
    ...(found ?? []).map((t) => fromTicket(p, t)),
  ];
}

export async function searchTickets(ctx: SearchCtx, q: string, limit: number): Promise<{ items: SearchItem[] }> {
  if (!words(q).length) return { items: [] };
  const projects = ((await within(ctx.projects.list())) ?? []).filter((p) => !p.error && p.slug);
  const all = await Promise.all(projects.map((p) => ofProject(ctx, p, q)));
  return { items: matchAndRank(all.flat(), q, limit) };
}
