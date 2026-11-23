import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardCache } from "../src/cache";
import { HttpError } from "../src/env";
import { toIssue } from "../src/github";
import type { DriftItem } from "../src/drift";
import { Guard, guardDeps, type Timers } from "../src/guard";
import { type Ctx, handleApi } from "../src/http";
import { JiraAccess, type JiraCredentials } from "../src/jira";
import { JiraCache } from "../src/jiracache";
import { LiveRuns } from "../src/live";
import { Prefs } from "../src/prefs";
import { Projects } from "../src/projects";
import type { Issue, Pull, Release, Released } from "../src/types";
import { issue, NOW, project, pull, snapshot } from "./fixtures";
import { type FakeJira, fakeJira } from "./jirafake";

let dir: string;
let gateCalls: { command: string; stdin: unknown }[];
let ctx: Ctx;
let ghIssues: Issue[];
let ghPulls: Pull[];
let ghReleases: Release[];
let ghReleasesError: string | null;
let jira: FakeJira;
let creds: JiraCredentials | null;
/** GitHub label writes: issue id, removed label ids, and how many JIRA calls had happened before */
let ghWrites: { id: string; remove: string[]; jiraCallsBefore: number }[];
/** timers the guard set (none fire on their own) */
let timers: { fn: () => void; ms: number }[];
const TOKEN = "geheim-token-123";

async function gate(command: string, stdin: unknown): Promise<unknown> {
  gateCalls.push({ command, stdin });
  const op = stdin && typeof stdin === "object" && "op" in stdin ? stdin.op : undefined;
  if (op === "projects") return { projects: [project(), project({ slug: "o/kaputt", error: "repo.slug fehlt" })] };
  if (op === "boom") throw new HttpError(400, "Unbekannte Operation.");
  return { echo: stdin };
}

async function call(path: string, init?: { method?: string; body?: unknown }) {
  const url = new URL(`http://127.0.0.1:1${path}`);
  const req = new Request(url, {
    method: init?.method ?? "GET",
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const res = await handleApi(req, url, ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-http-"));
  gateCalls = [];
  ghIssues = [issue(1, { labels: ["Sandcastle"] }), issue(2, { labels: ["story"] })];
  ghPulls = [];
  ghReleases = [];
  ghReleasesError = null;
  jira = fakeJira([]);
  creds = { site: "x.atlassian.net", email: "m@x.de", token: TOKEN };
  const fetchers = {
    fetchBoard: async () => ({
      ...snapshot(structuredClone(ghIssues), structuredClone(ghPulls), structuredClone(ghReleases)),
      releasesError: ghReleasesError,
    }),
    fetchChanged: async () => ({ issues: [], pulls: [] }),
  };
  const access = new JiraAccess(() => creds, jira.fetch);
  const base: Omit<Ctx, "guard"> = {
    projects: new Projects(dir, gate, () => NOW),
    boards: new BoardCache(dir, fetchers, () => NOW),
    gate,
    prefs: new Prefs(dir),
    jira: access,
    tickets: new JiraCache(
      dir,
      {
        fetchBoard: (key, states) => access.client().fetchBoard(key, states),
        fetchChanged: (key, since) => access.client().fetchChanged(key, since),
      },
      () => NOW,
    ),
    live: new LiveRuns(gate, () => NOW),
    async updateIssue(id, change) {
      ghWrites.push({ id, remove: change.removeLabelIds, jiraCallsBefore: jira.calls.length });
      const names = new Map(snapshot([]).labels.map((l) => [l.id, l.name]));
      const gone = new Set(change.removeLabelIds.map((x) => names.get(x)?.toLowerCase()));
      const before = ghIssues.find((i) => i.id === id);
      if (!before) return null;
      return { ...before, labels: before.labels.filter((l) => !gone.has(l.toLowerCase())), updatedAt: "2026-11-23T12:00:00Z" };
    },
  };
  timers = [];
  const fakeTimers: Timers = {
    set: (fn, ms) => timers.push({ fn, ms }),
    clear: () => {},
  };
  ctx = { ...base, guard: new Guard(dir, base.prefs, guardDeps(base), () => NOW, fakeTimers) };
  ghWrites = [];
});
afterEach(async () => {
  await ctx.boards.saved();
  await ctx.tickets.saved();
  rmSync(dir, { recursive: true, force: true });
});

describe("API", () => {
  test("projects come from the local gate and are kept for the next process", async () => {
    const r = await call("/api/projects");
    expect((r.body.projects as { slug: string }[]).map((p) => p.slug)).toEqual(["o/r", "o/kaputt"]);
    expect(gateCalls).toEqual([{ command: "sandcastle", stdin: { op: "projects" } }]);
    gateCalls = [];
    const again = new Projects(dir, gate, () => NOW);
    expect((await again.list()).length).toBe(2);
    expect(gateCalls).toEqual([]);
    await call("/api/projects?refresh=1");
    expect(gateCalls).toEqual([{ command: "sandcastle", stdin: { op: "projects", refresh: true } }]);
  });

  test("prefs survive a new process; null removes a key", async () => {
    await call("/api/prefs", { method: "POST", body: { slug: "o/r", view: "runs" } });
    await call("/api/prefs", { method: "POST", body: { view: null, filter: "l:bug" } });
    ctx.prefs = new Prefs(dir);
    expect((await call("/api/prefs")).body.prefs).toEqual({ slug: "o/r", filter: "l:bug" });
  });

  test("board by slug; since=etag answers {same:true}", async () => {
    const r = await call("/api/board?slug=o/r");
    expect(r.status).toBe(200);
    expect((r.body.issues as unknown[]).length).toBe(1);
    expect(r.body.stories).toEqual([{ number: 2, title: "Issue 2" }]);
    const same = await call(`/api/board?slug=o/r&since=${r.body.etag}`);
    expect(same.body).toEqual({ same: true });
  });

  test("unknown and broken projects", async () => {
    expect((await call("/api/board?slug=o/nix")).status).toBe(404);
    const broken = await call("/api/board?slug=o/kaputt");
    expect(broken.status).toBe(400);
    expect(broken.body.error).toBe("repo.slug fehlt");
  });

  test("input errors are 400 before GitHub is asked", async () => {
    expect((await call("/api/move", { method: "POST", body: { slug: "o/r", n: 1, to: "nirgends" } })).status).toBe(400);
    expect((await call("/api/comment", { method: "POST", body: { slug: "o/r", n: 1, body: "  " } })).status).toBe(400);
    expect((await call("/api/issue", { method: "POST", body: { slug: "o/r", title: "" } })).status).toBe(400);
    const labels = await call("/api/labels", { method: "POST", body: { slug: "o/r", n: 1, add: ["gibtsnicht"] } });
    expect(labels.status).toBe(400);
    expect(labels.body.error).toContain("gibtsnicht");
  });

  test("host gate fallback: only sandcastle passes; gate errors are {error}", async () => {
    const ok = await call("/api/host/gate", { method: "POST", body: { command: "sandcastle", stdin: { op: "status" } } });
    expect(ok.body).toEqual({ echo: { op: "status" } });
    for (const command of ["tools", "constructor", ""])
      expect((await call("/api/host/gate", { method: "POST", body: { command, stdin: {} } })).status).toBe(400);
    const err = await call("/api/host/gate", { method: "POST", body: { command: "sandcastle", stdin: { op: "boom" } } });
    expect(err).toEqual({ status: 400, body: { error: "Unbekannte Operation." } });
    const servers = await call("/api/host/servers");
    expect((servers.body.servers as { id: string; self: boolean }[])[0]).toMatchObject({ id: "local", self: true });
  });
});

describe("toIssue", () => {
  test("maps a GraphQL node and reads parent, JIRA and blockers from the body", () => {
    expect(
      toIssue({
        id: "I_9",
        number: 9,
        title: "T",
        state: "CLOSED",
        url: "u",
        updatedAt: "2026-11-20T10:00:00Z",
        closedAt: "2026-11-21T10:00:00Z",
        body: "## Parent\n#3\n\n## JIRA\nGHACCP-7\n\n## Blockiert von\n- #4\n- #5",
        author: null,
        labels: { nodes: [{ name: "bug" }] },
        assignees: { nodes: [{ login: "martin" }] },
        comments: { totalCount: 2 },
      }),
    ).toEqual({
      id: "I_9",
      number: 9,
      title: "T",
      state: "closed",
      labels: ["bug"],
      assignees: ["martin"],
      author: "ghost",
      parent: 3,
      jira: "GHACCP-7",
      blockedBy: [4, 5],
      updatedAt: "2026-11-20T10:00:00Z",
      closedAt: "2026-11-21T10:00:00Z",
      url: "u",
      commentsCount: 2,
    });
  });
});

describe("JIRA API", () => {
  const keyed = (n: number, key: string, over: Partial<Issue> = {}) => issue(n, { jira: key, ...over });
  beforeEach(() => {
    ghIssues = [
      keyed(9, "R-1", { labels: ["grillTicket"], state: "closed", closedAt: "2026-11-21T10:00:00Z" }),
      keyed(10, "R-1", { labels: ["story", "backend"] }),
      issue(11, { parent: 10, labels: ["Sandcastle", "backend", "help wanted", "wayfinder:x"] }),
      keyed(20, "R-2", { labels: ["story"], state: "closed", closedAt: "2026-11-21T10:00:00Z" }),
      issue(21, { parent: 20, state: "closed", closedAt: "2026-11-21T10:00:00Z" }),
      issue(30, { title: "ohne Schlüssel", labels: ["shop"] }),
      keyed(40, "R-4", { labels: ["frontend"] }),
      keyed(50, "R-5", { labels: ["story"], state: "closed", closedAt: "2026-11-21T10:00:00Z" }),
    ];
    jira.issues.push(
      { key: "R-1", status: "Backlog", labels: ["backend"] },
      { key: "R-2", status: "Testing" },
      { key: "R-3", status: "Backlog" },
      { key: "R-4", status: "In Progress" },
      { key: "R-5", status: "Backlog" },
    );
  });

  type Ticket = {
    key: string;
    status: string;
    drift: DriftItem[];
    derived: string | null;
    family: unknown;
    prs: { n: number; state: string; checks: string | null; [k: string]: unknown }[];
    released: Released | null;
  };
  const tickets = (body: Record<string, unknown>) => body.tickets as Ticket[];
  const ticket = (body: Record<string, unknown>, key: string) => tickets(body).find((t) => t.key === key) as Ticket;

  test("without stored credentials every JIRA call answers 409 jira-missing", async () => {
    creds = null;
    for (const r of [
      await call("/api/jira/board?slug=o/r"),
      await call("/api/jira/issue?slug=o/r&key=R-1"),
      await call("/api/drift/apply", { method: "POST", body: { slug: "o/r", key: "R-1" } }),
    ])
      expect(r).toEqual({ status: 409, body: { error: "jira-missing" } });
    expect(jira.calls).toEqual([]);
  });

  test("another site than the project's is a 409 naming both", async () => {
    creds = { site: "y.atlassian.net", email: "m@x.de", token: TOKEN };
    const r = await call("/api/jira/board?slug=o/r");
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("y.atlassian.net");
  });

  test("board: statuses in workflow order, paged tickets with family and drift, etag", async () => {
    const r = await call("/api/jira/board?slug=o/r");
    expect(r.status).toBe(200);
    expect(r.body.statuses).toEqual([
      { name: "Backlog", category: "new" },
      { name: "Selected", category: "new" },
      { name: "In Progress", category: "indeterminate" },
      { name: "Testing", category: "indeterminate" },
      { name: "Done", category: "done" },
    ]);
    // 5 tickets, 2 per page → 3 search calls, each with basic auth (never the bare token)
    const searches = jira.calls.filter((c) => c.path === "/rest/api/3/search/jql");
    expect(searches.map((c) => (c.body as { nextPageToken?: string }).nextPageToken)).toEqual([undefined, "2", "4"]);
    expect((searches[0]?.body as { jql: string }).jql).toBe(
      'project = R AND (statusCategory != Done OR status changed to "Done" after -14d) ORDER BY Rank ASC',
    );
    expect(searches[0]?.auth).toBe(`Basic ${Buffer.from(`m@x.de:${TOKEN}`).toString("base64")}`);
    expect(tickets(r.body).map((t) => t.key)).toEqual(["R-1", "R-2", "R-3", "R-4", "R-5"]);

    const r1 = ticket(r.body, "R-1");
    expect(r1.family).toMatchObject({ grill: { n: 9 }, story: { n: 10 }, children: [{ n: 11, state: "open" }] });
    expect(r1.derived).toBe("selected");
    expect(r1.drift).toEqual([
      { kind: "label-on-gh", issue: 10, label: "backend", inJira: true },
      { kind: "label-on-gh", issue: 11, label: "backend", inJira: true },
      { kind: "state-behind", expected: "Selected", actual: "Backlog" },
    ]);
    // all closed, but no build PR merged into main: not yet a done candidate
    expect(ticket(r.body, "R-2")).toMatchObject({ drift: [], inMain: "no" });
    expect(ticket(r.body, "R-3")).toMatchObject({ derived: null, drift: [], family: { children: [] } });
    expect(ticket(r.body, "R-4").drift).toEqual([{ kind: "label-on-gh", issue: 40, label: "frontend", inJira: false }]);
    expect(r.body.unlinked).toEqual([
      { n: 30, title: "ohne Schlüssel", state: "open", labels: ["shop"], drift: [{ kind: "no-key", issue: 30 }] },
    ]);
    // info: only the keyless issue – R-2 is no done candidate while nothing is merged into main
    expect(r.body.counts).toEqual({ drift: 5, info: 1, tickets: 3 });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);

    expect((await call(`/api/jira/board?slug=o/r&since=${r.body.etag}`)).body).toEqual({ same: true });
  });

  test("board: pull requests per ticket – key in title/branch/body, else closing a family issue; main PR first", async () => {
    ghPulls = [
      pull(100, { title: "📝 docs: Spec (R-1)", keys: ["R-1"], state: "merged", mergedAt: "2026-11-20T10:00:00Z", closedAt: "2026-11-20T10:00:00Z" }),
      pull(101, { branch: "feature/R-1-bau", keys: ["R-1"], state: "draft", checks: "pending" }),
      // no ticket key (UTF-8 is none), closes a child of R-2
      pull(102, { keys: ["UTF-8"], closes: [21], state: "merged", mergedAt: "2026-11-21T10:00:00Z", closedAt: "2026-11-21T10:00:00Z" }),
      pull(103, { closes: [999] }),
    ];
    const r = await call("/api/jira/board?slug=o/r");
    const prs = (key: string) => ticket(r.body, key).prs;
    expect(prs("R-1").map((p) => [p.n, p.state, p.checks, p.docs])).toEqual([
      [101, "draft", "pending", false],
      [100, "merged", null, true],
    ]);
    expect(prs("R-2").map((p) => p.n)).toEqual([102]);
    expect(prs("R-3")).toEqual([]);
    expect(prs("R-1")[0]).toEqual({
      n: 101,
      base: "main",
      title: "PR 101",
      url: "https://github.com/o/r/pull/101",
      state: "draft",
      checks: "pending",
      review: null,
      branch: "feature/R-1-bau",
      mergedAt: null,
      docs: false,
    });
  });

  test("board: live from version tags – first release and later ones; a failed release fetch is reported", async () => {
    const rel = (tag: string, at: string, keys: string[]): Release => ({ tag, oid: `c-${tag}`, base: null, at, keys });
    ghReleases = [rel("v1.0.0", "2026-11-01T10:00:00.000Z", ["R-1"]), rel("v1.1.0", "2026-11-10T10:00:00.000Z", ["R-1", "R-2"])];
    ghReleasesError = "gh: HTTP 502";
    const r = await call("/api/jira/board?slug=o/r");
    expect(ticket(r.body, "R-1").released).toEqual({
      version: "v1.0.0",
      at: "2026-11-01T10:00:00.000Z",
      later: [{ version: "v1.1.0", at: "2026-11-10T10:00:00.000Z" }],
    });
    expect(ticket(r.body, "R-2").released?.version).toBe("v1.1.0");
    expect(ticket(r.body, "R-3").released).toBeNull();
    expect(r.body.refreshError).toBe("Releases (Stand vom letzten Abruf): gh: HTTP 502");
  });

  test("issue detail: description and comments as safe HTML, transitions", async () => {
    const r = await call("/api/jira/issue?slug=o/r&key=R-2");
    expect(r.body.description).toBe("Text");
    expect(r.body.descriptionHtml).toContain("<p>Text</p>");
    expect(r.body.transitions).toEqual([
      { id: "t-Done", name: "nach Done", to: "Done", category: "done" },
      { id: "t-In Progress", name: "nach In Progress", to: "In Progress", category: "indeterminate" },
    ]);
    expect((await call("/api/jira/issue?slug=o/r&key=kaputt")).status).toBe(400);
  });

  test("transition by status name; one the workflow doesn't offer is a 409", async () => {
    const r = await call("/api/jira/transition", { method: "POST", body: { slug: "o/r", key: "R-2", to: "Done" } });
    expect(r.status).toBe(200);
    expect((r.body.ticket as Ticket).status).toBe("Done");
    expect(jira.calls.at(-2)).toMatchObject({
      method: "POST",
      path: "/rest/api/3/issue/R-2/transitions",
      body: { transition: { id: "t-Done" } },
    });
    // the cache took the answer: the board shows it without another full fetch
    expect(ticket((await call("/api/jira/board?slug=o/r")).body, "R-2").status).toBe("Done");
    const no = await call("/api/jira/transition", { method: "POST", body: { slug: "o/r", key: "R-3", to: "Testing" } });
    expect(no.status).toBe(409);
  });

  test("labels: written to JIRA only; the same label comes off the GitHub family", async () => {
    const r = await call("/api/jira/labels", { method: "POST", body: { slug: "o/r", key: "R-4", add: ["frontend"] } });
    expect(r.status).toBe(200);
    expect(jira.calls.find((c) => c.method === "PUT")).toMatchObject({
      path: "/rest/api/3/issue/R-4",
      body: { update: { labels: [{ add: "frontend" }] } },
    });
    expect(ghWrites.map(({ id, remove }) => ({ id, remove }))).toEqual([{ id: "I_40", remove: ["L_fe"] }]);
    expect((r.body.ticket as Ticket).drift).toEqual([]);
    // a label GitHub doesn't carry: JIRA only
    ghWrites = [];
    await call("/api/jira/labels", { method: "POST", body: { slug: "o/r", key: "R-3", add: ["neu"] } });
    expect(ghWrites).toEqual([]);
    const bad = await call("/api/jira/labels", { method: "POST", body: { slug: "o/r", key: "R-4", add: ["mit leer"] } });
    expect(bad.status).toBe(400);
  });

  test("drift/apply: product labels into JIRA first, then off GitHub; state forward", async () => {
    ghIssues[2] = issue(11, { parent: 10, labels: ["Sandcastle", "backend", "Frontend"] });
    const before = await call("/api/jira/board?slug=o/r");
    expect(ticket(before.body, "R-1").drift).toContainEqual({ kind: "label-on-gh", issue: 11, label: "Frontend", inJira: false });
    const r = await call("/api/drift/apply", { method: "POST", body: { slug: "o/r", key: "R-1" } });
    expect(r.status).toBe(200);
    const put = jira.calls.findIndex((c) => c.method === "PUT");
    expect(jira.calls[put]).toMatchObject({ path: "/rest/api/3/issue/R-1", body: { update: { labels: [{ add: "Frontend" }] } } });
    expect(ghWrites.map(({ id, remove }) => ({ id, remove }))).toEqual([
      { id: "I_10", remove: ["L_be"] },
      { id: "I_11", remove: ["L_be", "L_fe"] },
    ]);
    expect(ghWrites.every((w) => w.jiraCallsBefore > put)).toBe(true);
    expect((r.body.ticket as Ticket).status).toBe("Selected");
    expect((r.body.ticket as Ticket).drift).toEqual([]);
  });

  test("comment goes to JIRA as ADF", async () => {
    const r = await call("/api/jira/comment", { method: "POST", body: { slug: "o/r", key: "R-1", body: "Hallo\nWelt" } });
    expect(r.body.comment).toMatchObject({ author: "Martin" });
    expect(jira.calls.at(-1)?.body).toEqual({
      body: {
        version: 1,
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hallo" }, { type: "hardBreak" }, { type: "text", text: "Welt" }] },
        ],
      },
    });
    expect((await call("/api/jira/comment", { method: "POST", body: { slug: "o/r", key: "R-1", body: " " } })).status).toBe(400);
  });

  test("drift/apply walks the JIRA state forward step by step to the derived one", async () => {
    await call("/api/jira/board?slug=o/r");
    const r = await call("/api/drift/apply", { method: "POST", body: { slug: "o/r", key: "R-5" } });
    expect(r.status).toBe(200);
    expect((r.body.ticket as Ticket).status).toBe("Testing");
    const posts = jira.calls.filter((c) => c.method === "POST" && c.path.endsWith("/transitions"));
    expect(posts.map((c) => (c.body as { transition: { id: string } }).transition.id)).toEqual([
      "t-Selected",
      "t-In Progress",
      "t-Testing",
    ]);
    // everything on GitHub is closed, but nothing is merged into main: no done candidate yet
    expect((r.body.ticket as Ticket).drift).toEqual([]);
  });

  test("guard run: all actionable drift through drift/apply, the info kinds untouched", async () => {
    const result = await ctx.guard.run(true);
    expect(result).toMatchObject({ manual: true, projects: 1, tickets: 3, applied: 5, errors: 0, deferred: 0 });
    const at = new Date(NOW).toISOString();
    expect((await call("/api/guard")).body.recent).toEqual([
      {
        at,
        project: "o/r",
        applied: [
          { key: "R-1", kind: "label-on-gh", issue: 10, label: "backend" },
          { key: "R-1", kind: "label-on-gh", issue: 11, label: "backend" },
          { key: "R-1", kind: "state-behind", to: "Selected" },
          { key: "R-4", kind: "label-on-gh", issue: 40, label: "frontend" },
          { key: "R-5", kind: "state-behind", to: "Testing" },
        ],
        errors: [],
      },
    ]);
    expect((await call("/api/jira/board?slug=o/r")).body.counts).toMatchObject({ drift: 0, tickets: 0 });
    // R-2 is only a done candidate: never moved to Done
    expect(jira.calls.some((c) => c.method === "POST" && c.path === "/rest/api/3/issue/R-2/transitions")).toBe(false);
    expect(ghWrites.map((w) => w.id)).toEqual(["I_10", "I_11", "I_40"]);
  });
});

describe("guard API", () => {
  test("disabled by default; settings validated, stored and scheduled", async () => {
    expect((await call("/api/guard")).body).toEqual({
      enabled: false,
      intervalMin: 5,
      lastRun: null,
      nextRun: null,
      running: false,
      lastResult: null,
      recent: [],
    });
    for (const body of [{ intervalMin: 1 }, { intervalMin: 61 }, { intervalMin: 2.5 }, { intervalMin: "5" }, { enabled: "ja" }])
      expect((await call("/api/guard", { method: "POST", body })).status).toBe(400);
    const on = await call("/api/guard", { method: "POST", body: { enabled: true, intervalMin: 2 } });
    expect(on.body).toMatchObject({ enabled: true, intervalMin: 2, nextRun: new Date(NOW + 120_000).toISOString() });
    expect(timers.at(-1)?.ms).toBe(120_000);
    expect(ctx.prefs.get().guard).toEqual({ enabled: true, intervalMin: 2 });
    // /api/prefs cannot switch the guard behind its back
    await call("/api/prefs", { method: "POST", body: { guard: { enabled: false }, view: "jira" } });
    expect(ctx.prefs.get()).toEqual({ guard: { enabled: true, intervalMin: 2 }, view: "jira" });
    const off = await call("/api/guard", { method: "POST", body: { enabled: false } });
    expect(off.body).toMatchObject({ enabled: false, intervalMin: 2, nextRun: null });
  });
});
