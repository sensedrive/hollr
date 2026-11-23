/**
 * The JIRA board: tickets with their GitHub family and drift, and the writes that keep both sides in line.
 * Product labels live in JIRA only: label writes go to JIRA and take the same label off the GitHub family;
 * applying drift moves product labels found on GitHub into JIRA (when missing there) and off GitHub, and moves
 * the JIRA state forward. Every write puts the answer into the caches.
 */
import { renderMarkdown } from "./body";
import type { BoardCache } from "./cache";
import {
  type DerivedState,
  type DriftConfig,
  type DriftItem,
  type Families,
  type FamilyMember,
  type InMain,
  families,
  INFO_KINDS,
  jiraLabel,
  planApply,
  ticketDrift,
} from "./drift";
import { HttpError } from "./env";
import type { updateIssue } from "./github";
import type { JiraAccess, JiraClient, JiraStatus, JiraTicket } from "./jira";
import type { JiraCache } from "./jiracache";
import type { LiveRuns } from "./live";
import { pullsByTicket } from "./pulls";
import { releasesByKey } from "./releases";
import type { Project, PullOut, Released } from "./types";

export interface JiraCtx {
  boards: BoardCache;
  jira: JiraAccess;
  tickets: JiraCache;
  live: LiveRuns;
  /** the GitHub label/state write (github.updateIssue; tests record it) */
  updateIssue: typeof updateIssue;
}

export interface TicketOut extends JiraTicket {
  /** browse link, null without jira.baseUrl */
  url: string | null;
  family: { grill?: FamilyMember; story?: FamilyMember; children: FamilyMember[] };
  derived: DerivedState | null;
  drift: DriftItem[];
  /** pull requests of the ticket (key in title/branch/body, else closing a family issue), main PR first */
  prs: PullOut[];
  /** whether the work is merged into the default branch (src/drift.ts inMain); null: nothing on GitHub */
  inMain: InMain | null;
  /** the version tag the ticket's code first shipped in, and later ones adding to it; null when none */
  released: Released | null;
}

interface View {
  client: JiraClient;
  projectKey: string;
  statuses: JiraStatus[];
  tickets: JiraTicket[];
  fam: Families;
  /** ticket key → its pull requests, main PR first */
  prs: Map<string, PullOut[]>;
  /** ticket key → the release its code first shipped in */
  released: Map<string, Released>;
  cfg: DriftConfig;
  fetchedAt: number;
  stale: boolean;
  error?: string;
}

function projectKeyOf(p: Project): string {
  if (!p.jira.projectKey)
    throw new HttpError(400, `Projekt ${p.name} hat keinen JIRA-Projektschlüssel (.lul-workr.json jira.projectKey).`);
  return p.jira.projectKey;
}

async function view(ctx: JiraCtx, p: Project, refresh = false): Promise<View> {
  const projectKey = projectKeyOf(p);
  const client = ctx.jira.client(p);
  const [j, gh] = await Promise.all([
    ctx.tickets.board(projectKey, p.jira.states, refresh),
    ctx.boards.current(p.slug, refresh),
  ]);
  const cfg: DriftConfig = { labels: p.labels, states: p.jira.states, statuses: j.snap.statuses, defaultBranch: p.defaultBranch };
  const error = [
    j.error && `JIRA: ${j.error}`,
    gh.error && `GitHub: ${gh.error}`,
    gh.snap.releasesError && `Releases (Stand vom letzten Abruf): ${gh.snap.releasesError}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const fam = families(gh.snap.issues, p.labels, ctx.live.phases(p.slug));
  const known = new Set([...j.snap.tickets.map((t) => t.key), ...fam.byKey.keys()]);
  return {
    client,
    projectKey,
    statuses: j.snap.statuses,
    tickets: j.snap.tickets,
    fam,
    prs: pullsByTicket(gh.snap.pulls, known, fam.byKey),
    released: releasesByKey(gh.snap.releases),
    cfg,
    fetchedAt: j.fetchedAt,
    stale: j.stale || gh.stale,
    ...(error ? { error } : {}),
  };
}

function ticketOut(p: Project, v: View, t: JiraTicket): TicketOut {
  const family = v.fam.byKey.get(t.key);
  const prs = v.prs.get(t.key) ?? [];
  const released = v.released.get(t.key) ?? null;
  const { derived, drift, inMain } = ticketDrift(t, family, v.cfg, prs, released);
  return {
    ...t,
    url: p.jira.baseUrl ? `${p.jira.baseUrl.replace(/\/+$/, "")}/browse/${t.key}` : null,
    family: family ?? { children: [] },
    prs,
    inMain,
    released,
    derived,
    drift,
  };
}

export type JiraBoardAnswer = { same: true } | Record<string, unknown>;

/** `GET /api/jira/board`: `{same:true}` when nothing changed since the etag `since`. */
export async function jiraBoard(
  ctx: JiraCtx,
  p: Project,
  since: string | null,
  refresh: boolean,
): Promise<JiraBoardAnswer> {
  const v = await view(ctx, p, refresh);
  const tickets = v.tickets.map((t) => ticketOut(p, v, t));
  const unlinked = v.fam.unlinked.map((m) => ({ ...m, drift: [{ kind: "no-key", issue: m.n }] as DriftItem[] }));
  const items = [...tickets.flatMap((t) => t.drift), ...unlinked.flatMap((u) => u.drift)];
  const body = {
    statuses: v.statuses,
    tickets,
    unlinked,
    counts: {
      drift: items.filter((d) => !INFO_KINDS[d.kind]).length,
      info: items.filter((d) => INFO_KINDS[d.kind]).length,
      tickets: tickets.filter((t) => t.drift.some((d) => !INFO_KINDS[d.kind])).length,
    },
  };
  const etag = Bun.hash(JSON.stringify(body)).toString(36);
  if (since && since === etag) return { same: true };
  return {
    etag,
    fetchedAt: new Date(v.fetchedAt).toISOString(),
    stale: v.stale,
    ...(v.error ? { refreshError: v.error } : {}),
    ...body,
  };
}

/** The ticket from JIRA again, into the cache, composed with its family. */
async function refetched(ctx: JiraCtx, p: Project, key: string): Promise<TicketOut> {
  const v = await view(ctx, p);
  const ticket = await v.client.ticket(key);
  await ctx.tickets.put(v.projectKey, p.jira.states, ticket);
  return ticketOut(p, v, ticket);
}

export async function jiraIssue(ctx: JiraCtx, p: Project, key: string) {
  const v = await view(ctx, p);
  const d = await v.client.detail(key);
  await ctx.tickets.put(v.projectKey, p.jira.states, d.ticket);
  return {
    ticket: ticketOut(p, v, d.ticket),
    description: d.description,
    descriptionHtml: renderMarkdown(d.description),
    comments: d.comments.map((c) => ({ author: c.author, createdAt: c.created, bodyHtml: renderMarkdown(c.text) })),
    transitions: d.transitions,
  };
}

export async function jiraTransition(ctx: JiraCtx, p: Project, key: string, to: string) {
  if (!to) throw new HttpError(400, "Der Zielstatus fehlt.");
  await (await view(ctx, p)).client.transition(key, to);
  return { ticket: await refetched(ctx, p, key) };
}

export async function jiraComment(ctx: JiraCtx, p: Project, key: string, text: string) {
  if (!text.trim()) throw new HttpError(400, "Der Kommentar ist leer.");
  const c = await (await view(ctx, p)).client.comment(key, text.trim());
  return { comment: { author: c.author, createdAt: c.created, bodyHtml: renderMarkdown(c.text) } };
}

/** Labels on the JIRA ticket; a label written here that a GitHub family issue carries comes off GitHub. */
export async function jiraLabels(ctx: JiraCtx, p: Project, key: string, add: string[], remove: string[]) {
  if (!add.length && !remove.length) throw new HttpError(400, "Keine Label-Änderung.");
  await (await view(ctx, p)).client.setLabels(key, add, remove);
  const ticket = await refetched(ctx, p, key);
  const touched = new Set([...add, ...remove].map((l) => l.toLowerCase()));
  const onGh = ticket.drift.filter(
    (d) => d.kind === "label-on-gh" && !!d.label && touched.has(jiraLabel(d.label).toLowerCase()),
  );
  if (!onGh.length) return { ticket };
  await removeGhLabels(ctx, p, planApply(ticket, onGh, (await view(ctx, p)).cfg).gh);
  return { ticket: ticketOut(p, await view(ctx, p), ticket) };
}

/**
 * Applies a ticket's drift: product labels found on GitHub go into JIRA first (if missing there), then off
 * GitHub; the JIRA state moves forward to the derived one.
 */
export async function applyDrift(ctx: JiraCtx, p: Project, key: string) {
  const v = await view(ctx, p);
  const cached = v.tickets.find((t) => t.key === key) ?? (await v.client.ticket(key));
  const current = ticketOut(p, v, cached);
  const plan = planApply(current, current.drift, v.cfg);
  if (plan.jiraAdd.length) await v.client.setLabels(key, plan.jiraAdd, []);
  await removeGhLabels(ctx, p, plan.gh);
  if (plan.transition.length) await v.client.transitionForward(key, plan.transition);
  return { ticket: await refetched(ctx, p, key) };
}

/** Takes labels off GitHub issues of the cached board (names compare case-insensitively). */
async function removeGhLabels(ctx: JiraCtx, p: Project, changes: { n: number; remove: string[] }[]) {
  if (!changes.length) return;
  const snap = await ctx.boards.snapshot(p.slug);
  const ids = new Map(snap.labels.map((l) => [l.name.toLowerCase(), l.id]));
  for (const c of changes) {
    const issue = snap.issues.find((i) => i.number === c.n);
    if (!issue) continue;
    const has = new Set(issue.labels.map((l) => l.toLowerCase()));
    const removeLabelIds = c.remove
      .filter((l) => has.has(l.toLowerCase()))
      .map((l) => ids.get(l.toLowerCase()))
      .filter((id): id is string => !!id);
    if (!removeLabelIds.length) continue;
    const updated = await ctx.updateIssue(issue.id, { addLabelIds: [], removeLabelIds, reopen: false, close: false });
    if (updated) await ctx.boards.put(p.slug, updated);
  }
}
