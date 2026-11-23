/** Test data shared by the cache and HTTP tests. */
import type { RepoSnapshot } from "../src/github";
import type { Issue, Project, Pull, Release } from "../src/types";

export const NOW = Date.parse("2026-11-23T12:00:00Z");

export function issue(n: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `I_${n}`,
    number: n,
    title: `Issue ${n}`,
    state: "open",
    labels: [],
    assignees: [],
    author: "martin",
    parent: null,
    jira: null,
    blockedBy: [],
    updatedAt: "2026-11-20T10:00:00Z",
    closedAt: null,
    url: `https://github.com/o/r/issues/${n}`,
    commentsCount: 0,
    ...over,
  };
}

export function pull(n: number, over: Partial<Pull> = {}): Pull {
  return {
    n,
    title: `PR ${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    state: "open",
    checks: null,
    review: null,
    branch: `feature/pr-${n}`,
    base: "main",
    head: `c${n}`,
    mergedAt: null,
    closedAt: null,
    updatedAt: "2026-11-20T10:00:00Z",
    keys: [],
    codeKeys: [],
    closes: [],
    ...over,
  };
}

export function snapshot(issues: Issue[], pulls: Pull[] = [], releases: Release[] = []): RepoSnapshot {
  return {
    repoId: "R_1",
    viewer: "martin",
    issues,
    pulls,
    releases,
    labels: [
      { id: "L_q", name: "Sandcastle", color: "0e8a16" },
      { id: "L_s", name: "story", color: "5319e7" },
      { id: "L_g", name: "grillTicket", color: "d93f0b" },
      { id: "L_b", name: "bug", color: "d73a4a" },
      { id: "L_be", name: "backend", color: "ededed" },
      { id: "L_fe", name: "Frontend", color: "ededed" },
    ],
    assignees: [{ login: "martin", name: "Martin", avatarUrl: "https://avatars.example/m" }],
    closedOlder: 42,
  };
}

export function project(over: Partial<Project> = {}): Project {
  return {
    slug: "o/r",
    name: "r",
    root: "/tmp/r",
    gitCommonDir: "/tmp/r/.git",
    defaultBranch: "main",
    engine: "sandcastle",
    labels: {
      queue: "Sandcastle",
      story: "story",
      grill: "grillTicket",
      ready: "ready-for-agent",
      ciFailed: "ci-failed",
      nogo: null,
      workflow: ["release"],
    },
    jira: {
      baseUrl: "https://x.atlassian.net",
      projectKey: "R",
      boardId: null,
      cloudId: null,
      states: { selected: "Selected", inProgress: "In Progress", testing: "Testing", done: "Done" },
    },
    agents: [],
    defaults: { agent: "opus-5.5", parallel: 1 },
    queueSupported: true,
    ...over,
  };
}
