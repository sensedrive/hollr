/** The board's JSON API (/api/*). Errors answer {error} with 400, 404, 409 or 502 (gh / hollr). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blockedByOf, jiraKeyOf, parentOf, renderMarkdown } from "./body";
import { type Card, type Column, COLUMNS, classify, type Labels, type MovePlan, movePlan } from "./board";
import { HttpError } from "./env";
import { inProgress, type Progress } from "./events";
import * as gh from "./gh";
import { getProject, loadProjects, type Project } from "./projects";
import { append, effectiveOrder, moveBefore, readOrder, remove, writeOrder } from "./queue";
import {
  type CurrentRun,
  type RunConfig,
  currentRun,
  loadLastConfig,
  releaseRun,
  startRun,
  validateConfig,
} from "./run";

// ---------------------------------------------------------------- caches (per project)

const ISSUES_TTL = 20_000;
const LABELS_TTL = 600_000;
const issueCache = new Map<string, { at: number; data: Promise<{ open: gh.GhIssue[]; closed: gh.GhIssue[] }> }>();
const labelCache = new Map<string, { at: number; data: Promise<gh.GhLabel[]> }>();

function cached<T>(map: Map<string, { at: number; data: Promise<T> }>, key: string, ttl: number, load: () => Promise<T>) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = load();
  map.set(key, { at: Date.now(), data });
  data.catch(() => map.get(key)?.data === data && map.delete(key));
  return data;
}

const issuesOf = (p: Project) =>
  cached(issueCache, p.id, ISSUES_TTL, async () => {
    const [open, closed] = await Promise.all([gh.listOpen(p.slug), gh.listClosedRecent(p.slug)]);
    return { open: open.map((i) => ({ ...i, state: "open" })), closed: closed.map((i) => ({ ...i, state: "closed" })) };
  });
const labelsOf = (p: Project) => cached(labelCache, p.id, LABELS_TTL, () => gh.listLabels(p.slug));

// ---------------------------------------------------------------- cards

function toCard(issue: gh.GhIssue): Card {
  return {
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((l) => l.name),
    state: issue.state?.toLowerCase() === "closed" ? "closed" : "open",
    parent: parentOf(issue.body ?? ""),
    jira: jiraKeyOf(issue.body ?? ""),
    url: issue.url,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
  };
}

async function cardsOf(p: Project): Promise<Map<number, Card>> {
  const { open, closed } = await issuesOf(p);
  // an issue closed seconds ago can show in both lists while GitHub's search catches up: closed wins
  return new Map([...open, ...closed].map((i) => [i.number, toCard(i)]));
}

/** Open, non-story issues with the queue label. */
const queuedOf = (cards: Map<number, Card>, labels: Labels) =>
  [...cards.values()].filter((c) => classify(c, labels) === "queue").map((c) => c.number);

/** The effective queue order; stored when it changed (the loop reads the file). */
function syncedOrder(p: Project, cards: Map<number, Card>): number[] {
  const stored = readOrder(p.gitCommonDir);
  const order = effectiveOrder(stored, queuedOf(cards, p.labels));
  if (JSON.stringify(order) !== JSON.stringify(stored)) writeOrder(p.gitCommonDir, order);
  return order;
}

/** Changes the stored queue against the order as it was before the change on GitHub. */
function adjustQueue(p: Project, cards: Map<number, Card>, n: number, op: "append" | "remove" | "keep") {
  if (op === "keep") return;
  const base = effectiveOrder(readOrder(p.gitCommonDir), queuedOf(cards, p.labels));
  writeOrder(p.gitCommonDir, op === "append" ? append(base, n) : remove(base, n));
}

/** A card for an issue the gh cache doesn't list (closed long ago, project gone). */
const placeholder = (p: Project | undefined, n: number, title?: string): Card => ({
  number: n,
  title: title ?? `#${n}`,
  labels: [],
  state: "open",
  url: p ? `https://github.com/${p.slug}/issues/${n}` : "",
});

// ---------------------------------------------------------------- runs

interface Ctx {
  stateDir: string;
}

async function activeRun(ctx: Ctx): Promise<CurrentRun | null> {
  return currentRun(ctx.stateDir, await loadProjects(ctx.stateDir));
}

/** Issues the active run of `p` works on right now. */
async function runningIn(ctx: Ctx, p: Project): Promise<Set<number>> {
  const cur = await activeRun(ctx);
  if (!cur || cur.status === "ended" || cur.run.project !== p.id) return new Set();
  return new Set(inProgress(cur.progress));
}

// ---------------------------------------------------------------- board

async function board(ctx: Ctx, p: Project) {
  const [cards, labels, running] = await Promise.all([cardsOf(p), labelsOf(p), runningIn(ctx, p)]);
  const columns: Record<Column, Card[]> = { grill: [], backlog: [], queue: [], done: [] };
  const stories: { number: number; title: string }[] = [];
  for (const card of cards.values()) {
    const col = classify(card, p.labels);
    if (col === "story") stories.push({ number: card.number, title: card.title });
    else columns[col].push({ ...card, running: running.has(card.number) || undefined });
  }
  const order = syncedOrder(p, cards);
  const pos = new Map(order.map((n, i) => [n, i]));
  columns.queue.sort((a, b) => (pos.get(a.number) ?? 0) - (pos.get(b.number) ?? 0));
  const newest = (k: "updatedAt" | "closedAt") => (a: Card, b: Card) => (b[k] ?? "").localeCompare(a[k] ?? "");
  columns.grill.sort(newest("updatedAt"));
  columns.backlog.sort(newest("updatedAt"));
  columns.done.sort(newest("closedAt"));
  const hasGrill = !!p.labels.grill;
  return {
    columns: hasGrill ? columns : { backlog: columns.backlog, queue: columns.queue, done: columns.done },
    stories: stories.sort((a, b) => b.number - a.number),
    labels,
    hasGrill,
  };
}

// ---------------------------------------------------------------- issue detail

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function tail(file: string, lines = 40): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return readFileSync(file, "utf8")
      .replace(ANSI, "")
      .replace(/\r(?!\n)/g, "\n")
      .split("\n")
      .filter((l) => l.trim())
      .slice(-lines)
      .join("\n");
  } catch {
    return undefined;
  }
}

function runInfo(progress: Progress, n: number) {
  let status: "in-arbeit" | "erledigt" | "fehlgeschlagen" | "ohne-commits";
  let reason: string | undefined;
  if (progress.merged.has(n)) status = "erledigt";
  else if (progress.failed.has(n)) {
    status = "fehlgeschlagen";
    reason = progress.failed.get(n);
  } else if (progress.noCommits.has(n)) status = "ohne-commits";
  else if (progress.picked.has(n)) status = "in-arbeit";
  else return undefined;
  const logs: { name: string; tail: string }[] = [];
  const cwd = progress.loop?.cwd;
  for (const role of ["implementer", "reviewer"]) {
    const text = cwd && tail(join(cwd, ".sandcastle", "logs", `sandcastle-issue-${n}-${role}.log`));
    if (text) logs.push({ name: role, tail: text });
  }
  return { status, reason, logs };
}

async function issueDetail(ctx: Ctx, p: Project, n: number) {
  const [issue, cards, cur] = await Promise.all([gh.view(p.slug, n), cardsOf(p), activeRun(ctx)]);
  const parent = parentOf(issue.body ?? "");
  const jira = jiraKeyOf(issue.body ?? "");
  const progress = cur && cur.run.project === p.id ? cur.progress : undefined;
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state.toLowerCase(),
    url: issue.url,
    labels: issue.labels.map((l) => l.name),
    bodyHtml: renderMarkdown(issue.body ?? ""),
    parent: parent ? { number: parent, title: cards.get(parent)?.title ?? `#${parent}` } : undefined,
    jira: jira && p.jiraBaseUrl ? { key: jira, url: `${p.jiraBaseUrl}/browse/${jira}` } : undefined,
    blockedBy: blockedByOf(issue.body ?? ""),
    comments: (issue.comments ?? []).map((c) => ({
      author: c.author?.login ?? "?",
      createdAt: c.createdAt,
      bodyHtml: renderMarkdown(c.body ?? ""),
    })),
    run: progress ? runInfo(progress, n) : undefined,
  };
}

// ---------------------------------------------------------------- run view

async function runView(cur: CurrentRun) {
  const p = cur.project;
  const cards = p ? await cardsOf(p) : new Map<number, Card>();
  const card = (n: number) => cards.get(n) ?? placeholder(p, n, cur.progress.titles.get(n));
  const busy = new Set([...cur.progress.picked]);
  const order = p ? syncedOrder(p, cards) : [];
  return {
    project: { id: cur.run.project, name: p?.name ?? cur.run.project },
    status: cur.status,
    startedAt: cur.run.startedAt,
    endedAt: cur.run.endedAt ?? undefined,
    endReason: cur.run.endReason ?? undefined,
    config: cur.run.config,
    branch: cur.progress.loop?.branch,
    pr: cur.progress.runEnd?.pr ?? undefined,
    inProgress: inProgress(cur.progress).map(card),
    queue: order.filter((n) => !busy.has(n)).map(card),
    done: [...cur.progress.merged].map(card),
    failed: [
      ...[...cur.progress.failed].map(([n, reason]) => ({ card: card(n), reason })),
      ...[...cur.progress.noCommits].map((n) => ({ card: card(n), reason: "Keine Commits" })),
    ],
  };
}

// ---------------------------------------------------------------- routing

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

function invalidate(p: Project) {
  issueCache.delete(p.id);
}

export async function handleApi(req: Request, url: URL, ctx: Ctx): Promise<Response> {
  try {
    return Response.json(await route(req, url, ctx));
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
  const project = (id: unknown) => getProject(ctx.stateDir, String(id ?? ""));

  if (method === "GET" && path === "/api/projects")
    return { projects: await loadProjects(ctx.stateDir, q.get("refresh") === "1") };

  if (method === "GET" && path === "/api/board") return board(ctx, await project(q.get("project")));

  if (method === "POST" && path === "/api/move") {
    const body = await json(req);
    const p = await project(body.project);
    const n = issueNumber(body.number);
    const to = String(body.to ?? "") as Column;
    if (!COLUMNS.includes(to)) throw new HttpError(400, "Unbekannte Spalte.");
    if (to === "grill" && !p.labels.grill) throw new HttpError(400, "Dieses Projekt hat keine Spalte „Zu grillen“.");
    const cards = await cardsOf(p);
    const card = cards.get(n);
    if (!card) throw new HttpError(404, `Issue #${n} ist nicht auf dem Board.`);
    if ((await runningIn(ctx, p)).has(n)) throw new HttpError(409, "Wird gerade bearbeitet.");
    let plan: MovePlan;
    try {
      plan = movePlan(card, to, p.labels);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    if (plan.reopen) await gh.reopen(p.slug, n);
    await gh.edit(p.slug, n, plan.add, plan.remove);
    if (plan.close) await gh.close(p.slug, n);
    adjustQueue(p, cards, n, plan.queue);
    invalidate(p);
    return board(ctx, p);
  }

  if (method === "POST" && path === "/api/queue/move") {
    const body = await json(req);
    const p = await project(body.project);
    const n = issueNumber(body.number);
    const before = body.before === null || body.before === undefined ? null : issueNumber(body.before);
    const cards = await cardsOf(p);
    const queued = queuedOf(cards, p.labels);
    if (!queued.includes(n)) throw new HttpError(400, `#${n} steht nicht in der Warteschlange.`);
    const order = moveBefore(effectiveOrder(readOrder(p.gitCommonDir), queued), n, before);
    writeOrder(p.gitCommonDir, order);
    return { order };
  }

  if (method === "GET" && path === "/api/issue") {
    const p = await project(q.get("project"));
    return issueDetail(ctx, p, issueNumber(q.get("number")));
  }

  if (method === "POST" && path === "/api/issue") {
    const body = await json(req);
    const p = await project(body.project);
    const title = String(body.title ?? "").trim();
    if (!title) throw new HttpError(400, "Der Titel fehlt.");
    const column = String(body.column ?? "backlog");
    let labels: string[];
    if (column === "queue") labels = [p.labels.queue];
    else if (column === "grill") {
      if (!p.labels.grill) throw new HttpError(400, "Dieses Projekt hat keine Spalte „Zu grillen“.");
      labels = [p.labels.grill];
    } else if (column === "backlog") labels = [];
    else throw new HttpError(400, "Unbekannte Spalte.");
    const cards = await cardsOf(p);
    const n = await gh.create(p.slug, title, String(body.body ?? ""), labels);
    if (column === "queue") adjustQueue(p, cards, n, "append");
    invalidate(p);
    return { number: n };
  }

  if (method === "POST" && path === "/api/comment") {
    const body = await json(req);
    const p = await project(body.project);
    const n = issueNumber(body.number);
    const text = String(body.body ?? "").trim();
    if (!text) throw new HttpError(400, "Der Kommentar ist leer.");
    await gh.comment(p.slug, n, text);
    invalidate(p);
    return issueDetail(ctx, p, n);
  }

  if (method === "POST" && path === "/api/labels") {
    const body = await json(req);
    const p = await project(body.project);
    const n = issueNumber(body.number);
    const known = new Set((await labelsOf(p)).map((l) => l.name));
    const add = strings(body.add);
    const drop = strings(body.remove);
    const unknown = [...add, ...drop].filter((l) => !known.has(l));
    if (unknown.length) throw new HttpError(400, `Unbekannte Labels: ${unknown.join(", ")}`);
    const [issue, cards] = await Promise.all([gh.view(p.slug, n), cardsOf(p)]);
    const has = new Set(issue.labels.map((l) => l.name));
    const toAdd = add.filter((l) => !has.has(l));
    const toRemove = drop.filter((l) => has.has(l));
    await gh.edit(p.slug, n, toAdd, toRemove);
    if (toAdd.includes(p.labels.queue)) adjustQueue(p, cards, n, "append");
    else if (toRemove.includes(p.labels.queue)) adjustQueue(p, cards, n, "remove");
    invalidate(p);
    return issueDetail(ctx, p, n);
  }

  if (method === "GET" && path === "/api/run") {
    const cur = await activeRun(ctx);
    const chosen = q.get("project") ?? cur?.run.project ?? null;
    const p = chosen ? await project(chosen).catch(() => undefined) : undefined;
    let queue: Card[] | undefined;
    if (p) {
      const cards = await cardsOf(p);
      queue = syncedOrder(p, cards).map((n) => cards.get(n) ?? placeholder(p, n));
    }
    return {
      run: cur ? await runView(cur) : null,
      lastConfig: chosen ? (loadLastConfig(ctx.stateDir, chosen) ?? undefined) : undefined,
      queue,
    };
  }

  if (method === "POST" && path === "/api/run/start") {
    const body = await json(req);
    const p = await project(body.project);
    let cfg: RunConfig;
    try {
      cfg = validateConfig(body);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    const cards = await cardsOf(p);
    const queueLength = syncedOrder(p, cards).length;
    const run = await startRun(ctx.stateDir, p, cfg, { projects: await loadProjects(ctx.stateDir), queueLength });
    return { run };
  }

  if (method === "POST" && path === "/api/run/release") return { run: releaseRun(ctx.stateDir) };

  throw new HttpError(404, "Unbekannter Pfad.");
}
