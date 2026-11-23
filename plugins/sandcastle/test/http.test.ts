import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardCache } from "../src/cache";
import { HttpError } from "../src/env";
import { toIssue } from "../src/github";
import { type Ctx, handleApi } from "../src/http";
import { Projects } from "../src/projects";
import { issue, NOW, project, snapshot } from "./fixtures";

let dir: string;
let gateCalls: { command: string; stdin: unknown }[];
let ctx: Ctx;

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
  const fetchers = {
    fetchBoard: async () => snapshot([issue(1, { labels: ["Sandcastle"] }), issue(2, { labels: ["story"] })]),
    fetchChanged: async () => [],
  };
  ctx = { projects: new Projects(dir, gate, () => NOW), boards: new BoardCache(dir, fetchers, () => NOW), gate };
});
afterEach(async () => {
  await ctx.boards.saved();
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
