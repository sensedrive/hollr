/** A JIRA Cloud stand-in for tests: answers the REST v3 calls the plugin makes, records every call. */
import type { Fetch } from "../src/jira";

export interface FakeIssue {
  key: string;
  summary?: string;
  status: string;
  labels?: string[];
  updated?: string;
}

export const STATUS_CATEGORY: Record<string, string> = {
  Backlog: "new",
  Selected: "new",
  "In Progress": "indeterminate",
  Testing: "indeterminate",
  Done: "done",
};

export interface FakeJira {
  fetch: Fetch;
  calls: { method: string; path: string; body?: unknown; auth: string | null }[];
  issues: FakeIssue[];
  /** status → statuses reachable from it */
  workflow: Record<string, string[]>;
  pageSize: number;
}

const raw = (i: FakeIssue) => ({
  key: i.key,
  fields: {
    summary: i.summary ?? i.key,
    status: { name: i.status, statusCategory: { key: STATUS_CATEGORY[i.status] ?? "new" } },
    labels: i.labels ?? [],
    assignee: null,
    issuetype: { name: "Story", subtask: false, hierarchyLevel: 0 },
    parent: { key: "R-100", fields: { summary: "Epos", issuetype: { name: "Epic", hierarchyLevel: 1 } } },
    priority: { name: "Medium" },
    updated: i.updated ?? "2026-11-20T10:00:00.000+0000",
    created: "2026-11-01T10:00:00.000+0000",
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Text" }] }] },
    comment: { comments: [] },
  },
});

export function fakeJira(issues: FakeIssue[]): FakeJira {
  const fake: FakeJira = {
    calls: [],
    issues,
    pageSize: 2,
    workflow: {
      Backlog: ["Selected"],
      Selected: ["In Progress", "Backlog"],
      "In Progress": ["Testing"],
      Testing: ["Done", "In Progress"],
      Done: [],
    },
    async fetch(url, init) {
      const u = new URL(url);
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const auth = new Headers(init.headers).get("authorization");
      fake.calls.push({ method, path: u.pathname + u.search, body, auth });
      const ok = (data: unknown, status = 200) => new Response(data === undefined ? "" : JSON.stringify(data), { status });
      const issueMatch = u.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/\w+)?$/);
      if (u.pathname === "/rest/api/3/project/R/statuses")
        return ok([
          { name: "Sub-Task", subtask: true, statuses: [{ name: "Sub-Status", statusCategory: { key: "indeterminate" } }] },
          {
            name: "Story",
            subtask: false,
            statuses: ["Done", "Testing", "In Progress", "Selected", "Backlog"].map((name) => ({
              name,
              statusCategory: { key: STATUS_CATEGORY[name] },
            })),
          },
        ]);
      if (u.pathname === "/rest/api/3/search/jql") {
        const start = body.nextPageToken ? Number(body.nextPageToken) : 0;
        const page = fake.issues.slice(start, start + fake.pageSize);
        const next = start + fake.pageSize < fake.issues.length ? String(start + fake.pageSize) : undefined;
        return ok({ issues: page.map(raw), ...(next ? { nextPageToken: next } : {}), isLast: !next });
      }
      if (issueMatch) {
        const issue = fake.issues.find((i) => i.key === issueMatch[1]);
        if (!issue) return ok({ errorMessages: ["Issue does not exist"] }, 404);
        const sub = issueMatch[2];
        if (!sub && method === "GET") return ok(raw(issue));
        if (!sub && method === "PUT") {
          for (const op of body.update.labels) {
            if (op.add) issue.labels = [...(issue.labels ?? []), op.add];
            if (op.remove) issue.labels = (issue.labels ?? []).filter((l) => l !== op.remove);
          }
          issue.updated = "2026-11-23T12:00:00.000+0000";
          return ok(undefined, 204);
        }
        if (sub === "/transitions" && method === "GET")
          return ok({
            transitions: (fake.workflow[issue.status] ?? []).map((to) => ({
              id: `t-${to}`,
              name: `nach ${to}`,
              to: { name: to, statusCategory: { key: STATUS_CATEGORY[to] } },
            })),
          });
        if (sub === "/transitions" && method === "POST") {
          const to = String(body.transition.id).slice(2);
          if (!(fake.workflow[issue.status] ?? []).includes(to)) return ok({ errorMessages: ["no"] }, 400);
          issue.status = to;
          issue.updated = "2026-11-23T12:00:00.000+0000";
          return ok(undefined, 204);
        }
        if (sub === "/comment" && method === "POST")
          return ok({ author: { displayName: "Martin" }, created: "2026-11-23T12:00:00.000+0000", body: body.body });
      }
      return ok({ errorMessages: [`unbekannt ${method} ${u.pathname}`] }, 404);
    },
  };
  return fake;
}
