import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_MS, STALE_MS } from "../src/cache";
import { HttpError } from "../src/env";
import { adfToText, type Fetch, JiraClient, type JiraSnapshot, type JiraTicket, jiraCredentials, orderStatuses } from "../src/jira";
import { JiraCache } from "../src/jiracache";
import { phasesOf } from "../src/live";
import { NOW, project } from "./fixtures";
import { fakeJira } from "./jirafake";

const states = project().jira.states;
const CREDS = { site: "x.atlassian.net", email: "m@x.de", token: "geheim" };

describe("orderStatuses", () => {
  test("main types only, unique, category first, configured states in their order", () => {
    const s = (name: string, key: string) => ({ name, statusCategory: { key } });
    expect(
      orderStatuses(
        [
          { subtask: true, statuses: [s("Sub", "new")] },
          { statuses: [s("Done", "done"), s("Testing", "indeterminate"), s("Blocked", "indeterminate"), s("Selected", "new")] },
          { statuses: [s("In Progress", "indeterminate"), s("Backlog", "new"), s("Selected", "new")] },
        ],
        states,
      ).map((x) => x.name),
    ).toEqual(["Backlog", "Selected", "In Progress", "Testing", "Blocked", "Done"]);
  });
});

describe("adfToText", () => {
  test("paragraphs, headings, lists, safe links, mentions, code", () => {
    const text = (t: string, marks?: unknown[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
    expect(
      adfToText({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [text("Ziel")] },
          {
            type: "paragraph",
            content: [
              text("Siehe "),
              text("Doku", [{ type: "link", attrs: { href: "https://x.de" } }]),
              text(" und "),
              text("böse", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
              { type: "hardBreak" },
              { type: "mention", attrs: { text: "@Martin" } },
            ],
          },
          { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("eins")] }] }] },
          { type: "codeBlock", content: [text("x = 1")] },
          { type: "mediaSingle", content: [{ type: "media" }] },
        ],
      }),
    ).toBe("## Ziel\n\nSiehe [Doku](https://x.de) und böse\n@Martin\n\n- eins\n\n```\nx = 1\n```\n\n[Anhang]");
    expect(adfToText(null)).toBe("");
  });
});

describe("credentials", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-secrets-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("read from the secrets file; missing or without token → null", () => {
    const file = join(dir, "secrets.json");
    expect(jiraCredentials(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ jira: { site: "https://x.atlassian.net/", email: "m@x.de", token: "t" } }));
    expect(jiraCredentials(file)).toEqual({ site: "x.atlassian.net", email: "m@x.de", token: "t" });
    writeFileSync(file, JSON.stringify({ jira: { site: "x.atlassian.net", email: "m@x.de", token: "" } }));
    expect(jiraCredentials(file)).toBeNull();
  });
});

describe("JiraClient", () => {
  test("pages with nextPageToken until the last page", async () => {
    const jira = fakeJira(Array.from({ length: 5 }, (_, i) => ({ key: `R-${i + 1}`, status: "Selected" })));
    const tickets = await new JiraClient(CREDS, jira.fetch).search("project = R");
    expect(tickets.map((t) => t.key)).toEqual(["R-1", "R-2", "R-3", "R-4", "R-5"]);
    expect(tickets[0]).toMatchObject({ category: "new", epic: { key: "R-100", summary: "Epos" }, parent: null });
    expect(jira.calls.length).toBe(3);
  });

  test("changes since: relative minutes with a 2 min margin (JQL dates would be in the user's time zone)", async () => {
    const jira = fakeJira([]);
    await new JiraClient(CREDS, jira.fetch).fetchChanged("R", new Date(NOW - 10 * 60_000).toISOString(), NOW);
    expect((jira.calls[0]?.body as { jql: string }).jql).toBe("project = R AND updated >= -12m ORDER BY Rank ASC");
  });

  test("errors carry JIRA's message, never the token; 401 names the token check", async () => {
    const answer = (status: number, body: unknown): Fetch => async () => new Response(JSON.stringify(body), { status });
    const fail = async (f: Fetch) => {
      try {
        await new JiraClient(CREDS, f).ticket("R-1");
      } catch (err) {
        return err as HttpError;
      }
      throw new Error("no error");
    };
    const e404 = await fail(answer(404, { errorMessages: ["Issue does not exist"] }));
    expect([e404.status, e404.message]).toEqual([404, "JIRA 404: Issue does not exist"]);
    const e401 = await fail(answer(401, {}));
    expect(e401.status).toBe(502);
    expect(e401.message).toContain("Token");
    expect(e401.message).not.toContain("geheim");
    const timeout = await fail(async () => {
      throw new DOMException("t", "TimeoutError");
    });
    expect(timeout.message).toContain("Zeitüberschreitung");
  });

  test("at most 4 requests at a time", async () => {
    let active = 0;
    let peak = 0;
    const slow: Fetch = async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
      return new Response("{}");
    };
    const c = new JiraClient(CREDS, slow);
    await Promise.all(Array.from({ length: 10 }, () => c.request("GET", "/x")));
    expect(peak).toBe(4);
  });

  test("transition: unknown target is a 409, nothing posted", async () => {
    const jira = fakeJira([{ key: "R-1", status: "Backlog" }]);
    const c = new JiraClient(CREDS, jira.fetch);
    await expect(c.transition("R-1", "Done")).rejects.toThrow("nicht nach „Done“");
    expect(jira.calls.filter((x) => x.method === "POST")).toEqual([]);
  });

  test("transitionForward takes a direct transition when the workflow offers one", async () => {
    const jira = fakeJira([{ key: "R-1", status: "Backlog" }]);
    jira.workflow.Backlog = ["Selected", "Testing"];
    await new JiraClient(CREDS, jira.fetch).transitionForward("R-1", ["Selected", "In Progress", "Testing"]);
    expect(jira.issues[0]?.status).toBe("Testing");
    expect(jira.calls.filter((x) => x.method === "POST").length).toBe(1);
  });
});

describe("JiraCache", () => {
  let dir: string;
  let clock: number;
  let calls: string[];
  let full: JiraSnapshot;
  let changed: JiraTicket[];
  const t = (key: string, status: string, updated: string, category: JiraTicket["category"] = "new"): JiraTicket => ({
    key,
    summary: key,
    status,
    category,
    labels: [],
    assignee: null,
    type: "Story",
    subtask: false,
    epic: null,
    parent: null,
    priority: null,
    created: "",
    updated,
  });
  const make = () =>
    new JiraCache(
      dir,
      {
        async fetchBoard(key) {
          calls.push(`full ${key}`);
          return structuredClone(full);
        },
        async fetchChanged(key, since) {
          calls.push(`changed ${key} ${since}`);
          return structuredClone(changed);
        },
      },
      () => clock,
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-jira-"));
    clock = NOW;
    calls = [];
    changed = [];
    full = {
      statuses: [{ name: "Selected", category: "new" }],
      tickets: [t("R-1", "Selected", "2026-11-20T10:00:00Z"), t("R-2", "Selected", "2026-11-20T10:00:00Z")],
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("stale → background changes merged in place, new ones appended; disk copy for the next process", async () => {
    const c = make();
    expect((await c.board("R", states)).snap.tickets.map((x) => x.key)).toEqual(["R-1", "R-2"]);
    clock += STALE_MS + 1;
    changed = [t("R-3", "Selected", "2026-11-23T11:00:00Z"), t("R-1", "In Progress", "2026-11-23T11:00:00Z", "indeterminate")];
    const stale = await c.board("R", states);
    expect(stale.stale).toBe(true);
    await Bun.sleep(1);
    const fresh = await c.board("R", states);
    expect(fresh.stale).toBe(false);
    expect(fresh.snap.tickets.map((x) => `${x.key}:${x.status}`)).toEqual(["R-1:In Progress", "R-2:Selected", "R-3:Selected"]);
    expect(calls).toEqual(["full R", `changed R ${new Date(NOW).toISOString()}`]);
    await c.saved();
    calls = [];
    expect((await make().board("R", states)).snap.tickets.length).toBe(3);
    expect(calls).toEqual([]);
  });

  test("full fetch every 10 min and on refresh; old done tickets leave", async () => {
    const c = make();
    await c.board("R", states);
    full.tickets.push(t("R-9", "Done", "2026-10-01T10:00:00Z", "done"));
    await c.board("R", states, true);
    expect(calls).toEqual(["full R", "full R"]);
    expect((await c.board("R", states)).snap.tickets.map((x) => x.key)).toEqual(["R-1", "R-2"]);
    clock += FULL_MS + 1;
    await c.board("R", states);
    await Bun.sleep(1);
    expect(calls.at(-1)).toBe("full R");
    await c.saved();
  });

  test("a written ticket beats an older fetched copy", async () => {
    const c = make();
    await c.board("R", states);
    await c.put("R", states, t("R-1", "Testing", "2026-11-23T12:00:00Z", "indeterminate"));
    clock += STALE_MS + 1;
    changed = [t("R-1", "Selected", "2026-11-20T10:00:00Z")];
    await c.board("R", states);
    await Bun.sleep(1);
    expect((await c.board("R", states)).snap.tickets.find((x) => x.key === "R-1")?.status).toBe("Testing");
    await c.saved();
  });

  test("bad project key is a 400", async () => {
    await expect(make().board("r; drop", states)).rejects.toBeInstanceOf(HttpError);
  });
});

describe("live phases", () => {
  test("only runs of the repo that have not ended", () => {
    const status = {
      runs: [
        { slug: "o/r", status: "running", issues: [{ n: 3, phase: "building" }] },
        { slug: "o/r", status: "ended", issues: [{ n: 4, phase: "merged" }] },
        { slug: "o/x", status: "running", issues: [{ n: 5, phase: "building" }] },
      ],
    };
    expect([...phasesOf(status, "o/r")]).toEqual([[3, "building"]]);
    expect(phasesOf({ echo: 1 }, "o/r").size).toBe(0);
  });
});
