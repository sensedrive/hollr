/**
 * The board's JSON API (/api/*), keyed by repo slug (contract C): GitHub issues, and JIRA tickets with their
 * GitHub family and drift (/api/jira/*, /api/drift/*), and the drift guard (/api/guard). Queue order, runs and
 * logs are the machines' business (`hollr gate sandcastle`, reached through the Hollr host relay, or
 * /api/host/gate when the page runs outside Hollr). Errors answer {error} with 400, 404, 409 (JIRA:
 * `jira-missing`, transition not possible) or 502.
 */
import { hostname } from "node:os";
import { renderMarkdown } from "./body";
import { type Column, COLUMNS, classify, type MovePlan, movePlan } from "./board";
import type { BoardCache } from "./cache";
import { HttpError } from "./env";
import * as github from "./github";
import type { Guard } from "./guard";
import type { JiraAccess } from "./jira";
import { applyDrift, jiraBoard, jiraComment, jiraIssue, jiraLabels, jiraTransition } from "./jiraboard";
import type { JiraCache } from "./jiracache";
import type { LiveRuns } from "./live";
import type { Prefs } from "./prefs";
import type { Gate, Projects } from "./projects";
import type { CommentOut, Issue, IssueDetail, Project } from "./types";

export interface Ctx {
  projects: Projects;
  boards: BoardCache;
  /** `hollr gate` on this machine */
  gate: Gate;
  /** last board settings, kept across tunnel origins */
  prefs: Prefs;
  /** the stored JIRA access (409 jira-missing without one) */
  jira: JiraAccess;
  /** JIRA boards per project key */
  tickets: JiraCache;
  /** phases of this machine's live runs, for the drift rules */
  live: LiveRuns;
  /** the GitHub label/state write of JIRA-driven fixes (github.updateIssue; tests record it) */
  updateIssue: typeof github.updateIssue;
  /** the drift guard: periodic apply of actionable drift */
  guard: Guard;
}

/** Gate commands /api/host/gate passes on – the same allowlist the manifest gives the Hollr relay. */
const HOST_GATE: Record<string, true> = { sandcastle: true };

async function json(req: Request): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await req.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return Object.fromEntries(Object.entries(data));
  } catch {}
  throw new HttpError(400, "Ungültiger JSON-Inhalt.");
}

function issueNumber(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "Ungültige Issue-Nummer.");
  return n;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The issue as the cache has it, else from GitHub (closed before the window, or just created elsewhere). */
async function currentIssue(ctx: Ctx, slug: string, n: number): Promise<Issue> {
  const cached = (await ctx.boards.snapshot(slug)).issues.find((i) => i.number === n);
  return cached ?? (await github.fetchIssue(slug, n)).issue;
}

/** Label names → ids from the repo's labels; unknown names are a 400 naming them. */
async function labelIds(ctx: Ctx, slug: string, names: string[]): Promise<string[]> {
  const byName = new Map((await ctx.boards.snapshot(slug)).labels.map((l) => [l.name, l.id]));
  const unknown = names.filter((l) => !byName.has(l));
  if (unknown.length) throw new HttpError(400, `Unbekannte Labels: ${unknown.join(", ")}`);
  return names.map((l) => byName.get(l) ?? "");
}

const comment = (c: github.RawComment): CommentOut => ({
  author: c.author?.login ?? "ghost",
  createdAt: c.createdAt,
  bodyHtml: renderMarkdown(c.body ?? ""),
});

async function issueDetail(ctx: Ctx, p: Project, n: number): Promise<IssueDetail> {
  const { issue, body, comments } = await github.fetchIssue(p.slug, n);
  if (classify(issue, p.labels) !== "story") await ctx.boards.put(p.slug, issue);
  return { ...issue, bodyHtml: renderMarkdown(body), comments: comments.map(comment) };
}

async function move(ctx: Ctx, p: Project, n: number, to: Column): Promise<Issue> {
  const issue = await currentIssue(ctx, p.slug, n);
  let plan: MovePlan;
  try {
    plan = movePlan(issue, to, p.labels);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  const [add, remove] = await Promise.all([labelIds(ctx, p.slug, plan.add), labelIds(ctx, p.slug, plan.remove)]);
  const updated = await github.updateIssue(issue.id, {
    addLabelIds: add,
    removeLabelIds: remove,
    reopen: plan.reopen,
    close: plan.close,
  });
  if (!updated) return issue;
  await ctx.boards.put(p.slug, updated);
  return updated;
}

async function setLabels(ctx: Ctx, p: Project, n: number, add: string[], drop: string[]): Promise<Issue> {
  await labelIds(ctx, p.slug, [...add, ...drop]);
  const issue = await currentIssue(ctx, p.slug, n);
  const toAdd = add.filter((l) => !issue.labels.includes(l));
  const toRemove = drop.filter((l) => issue.labels.includes(l));
  const updated = await github.updateIssue(issue.id, {
    addLabelIds: await labelIds(ctx, p.slug, toAdd),
    removeLabelIds: await labelIds(ctx, p.slug, toRemove),
    reopen: false,
    close: false,
  });
  if (!updated) return issue;
  await ctx.boards.put(p.slug, updated);
  return updated;
}

async function create(ctx: Ctx, p: Project, b: Record<string, unknown>): Promise<Issue> {
  const title = String(b.title ?? "").trim();
  if (!title) throw new HttpError(400, "Der Titel fehlt.");
  const column = String(b.column ?? "backlog");
  let labels: string[];
  if (column === "queue") labels = [p.labels.queue];
  else if (column === "grill") {
    if (!p.labels.grill) throw new HttpError(400, "Dieses Projekt hat keine Spalte „Zu grillen“.");
    labels = [p.labels.grill];
  } else if (column === "backlog") labels = [];
  else throw new HttpError(400, "Unbekannte Spalte.");
  let body = String(b.body ?? "");
  // the lul-workr child template starts with this section; parentOf() reads it
  if (b.parent !== undefined && b.parent !== null) body = `## Parent\n#${issueNumber(b.parent)}\n\n${body}`;
  const snap = await ctx.boards.snapshot(p.slug);
  const issue = await github.createIssue(snap.repoId, title, body, await labelIds(ctx, p.slug, labels));
  await ctx.boards.put(p.slug, issue);
  return issue;
}

export async function handleApi(req: Request, url: URL, ctx: Ctx): Promise<Response> {
  try {
    const out = await route(req, url, ctx);
    if (out instanceof Response) return out;
    return Response.json(out);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 500) console.error(err);
    return Response.json({ error: message }, { status });
  }
}

async function route(req: Request, url: URL, ctx: Ctx): Promise<unknown> {
  const path = url.pathname;
  const q = url.searchParams;
  const method = req.method;
  const project = (slug: unknown) => ctx.projects.get(String(slug ?? ""));

  if (method === "GET" && path === "/api/projects") return { projects: await ctx.projects.list(q.get("refresh") === "1") };

  if (method === "GET" && path === "/api/board") {
    const answer = await ctx.boards.board(await project(q.get("slug")), q.get("since"), q.get("refresh") === "1");
    // the cache keeps the board as JSON text: no re-serialising of hundreds of issues per poll
    return "same" in answer
      ? { same: true }
      : new Response(answer.json, { headers: { "Content-Type": "application/json;charset=utf-8" } });
  }

  if (method === "GET" && path === "/api/board/closed") {
    const p = await project(q.get("slug"));
    const page = await github.fetchClosedBefore(p.slug, q.get("before") ?? "");
    return { issues: page.issues.filter((i) => classify(i, p.labels) !== "story"), closedOlder: page.closedOlder };
  }

  if (method === "GET" && path === "/api/issue") return issueDetail(ctx, await project(q.get("slug")), issueNumber(q.get("n")));

  if (method === "POST" && path === "/api/move") {
    const b = await json(req);
    const p = await project(b.slug);
    const to = String(b.to ?? "") as Column;
    if (!COLUMNS.includes(to)) throw new HttpError(400, "Unbekannte Spalte.");
    if (to === "grill" && !p.labels.grill) throw new HttpError(400, "Dieses Projekt hat keine Spalte „Zu grillen“.");
    return { issue: await move(ctx, p, issueNumber(b.n), to) };
  }

  if (method === "POST" && path === "/api/labels") {
    const b = await json(req);
    return { issue: await setLabels(ctx, await project(b.slug), issueNumber(b.n), strings(b.add), strings(b.remove)) };
  }

  if (method === "POST" && path === "/api/comment") {
    const b = await json(req);
    const p = await project(b.slug);
    const n = issueNumber(b.n);
    const text = String(b.body ?? "").trim();
    if (!text) throw new HttpError(400, "Der Kommentar ist leer.");
    const issue = await currentIssue(ctx, p.slug, n);
    const added = await github.addComment(issue.id, text);
    await ctx.boards.patch(p.slug, n, (i) => ({ ...i, commentsCount: added.commentsCount, updatedAt: added.createdAt }));
    return { comment: comment(added) };
  }

  if (method === "POST" && path === "/api/issue") {
    const b = await json(req);
    return { issue: await create(ctx, await project(b.slug), b) };
  }

  if (method === "GET" && path === "/api/prefs") return { prefs: ctx.prefs.get() };
  if (method === "POST" && path === "/api/prefs") {
    // the guard's settings go through /api/guard, which also (re)schedules it
    const { guard: _, ...patch } = await json(req);
    return { prefs: ctx.prefs.patch(patch) };
  }

  if (method === "GET" && path === "/api/guard") return ctx.guard.status();
  if (method === "POST" && path === "/api/guard") return ctx.guard.update(await json(req));

  if (method === "GET" && path === "/api/host/servers")
    return { servers: [{ id: "local", label: hostname().replace(/\.local$/, ""), self: true, online: true }] };

  if (method === "POST" && path === "/api/host/gate") {
    const b = await json(req);
    const command = String(b.command ?? "");
    if (!Object.hasOwn(HOST_GATE, command)) throw new HttpError(400, `Gate-Befehl „${command}“ ist nicht freigegeben.`);
    return ctx.gate(command, b.stdin ?? {});
  }

  if (method === "GET" && path === "/api/jira/board") {
    const p = await project(q.get("slug"));
    return jiraBoard(ctx, p, q.get("since"), q.get("refresh") === "1");
  }

  if (method === "GET" && path === "/api/jira/issue")
    return jiraIssue(ctx, await project(q.get("slug")), String(q.get("key") ?? ""));

  if (method === "POST" && path === "/api/jira/transition") {
    const b = await json(req);
    return jiraTransition(ctx, await project(b.slug), String(b.key ?? ""), String(b.to ?? "").trim());
  }

  if (method === "POST" && path === "/api/jira/labels") {
    const b = await json(req);
    return jiraLabels(ctx, await project(b.slug), String(b.key ?? ""), strings(b.add), strings(b.remove));
  }

  if (method === "POST" && path === "/api/jira/comment") {
    const b = await json(req);
    return jiraComment(ctx, await project(b.slug), String(b.key ?? ""), String(b.body ?? ""));
  }

  if (method === "POST" && path === "/api/drift/apply") {
    const b = await json(req);
    return applyDrift(ctx, await project(b.slug), String(b.key ?? ""));
  }

  throw new HttpError(404, "Unbekannter Pfad.");
}
