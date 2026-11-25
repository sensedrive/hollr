/** Shapes the plugin API answers with (contract C) – types only, shared with ui/. */

/** A lul-workr project as `hollr gate sandcastle {"op":"projects"}` reports it (contract A). */
export interface Project {
  /** owner/repo */
  slug: string;
  name: string;
  root: string;
  gitCommonDir: string;
  defaultBranch: string;
  engine: string;
  /** workflow labels (GitHub owns them); ready/ciFailed/nogo are null when not configured */
  labels: {
    queue: string;
    story: string;
    grill: string | null;
    ready: string | null;
    ciFailed: string | null;
    nogo: string | null;
    /** further labels the project keeps on GitHub as workflow labels (`github.labels.workflow`) */
    workflow: string[];
  };
  jira: {
    baseUrl: string | null;
    projectKey: string | null;
    boardId: string | null;
    cloudId: string | null;
    /** JIRA status names of the lul-workr workflow steps */
    states: { selected: string | null; inProgress: string | null; testing: string | null; done: string | null };
  };
  agents: { key: string; label: string; harness: string; model: string }[];
  defaults: { agent: string; parallel: number };
  queueSupported: boolean;
  error?: string;
}

/** Per-ticket test wishes in the machine's queue.json (contract A). */
export interface TicketFlags {
  deploy: boolean;
  testnote: boolean;
  video: boolean;
}

export interface Issue {
  /** GraphQL node id (mutations) */
  id: string;
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  author: string;
  parent: number | null;
  jira: string | null;
  blockedBy: number[];
  /** „Blockiert von“ entries without #N (free text such as a release): the loop keeps the issue blocked */
  blockedNotes: string[];
  updatedAt: string;
  closedAt: string | null;
  url: string;
  commentsCount: number;
}

export interface LabelInfo {
  name: string;
  color: string;
}

export interface Assignee {
  login: string;
  name: string | null;
  avatarUrl: string;
}

export type PullState = "open" | "draft" | "merged" | "closed";
export type ChecksState = "success" | "failure" | "pending";

/** A pull request as the board cache keeps it (src/pulls.ts). */
export interface Pull {
  n: number;
  title: string;
  url: string;
  state: PullState;
  /** status rollup of the last commit; only fetched for open PRs (null otherwise or without checks) */
  checks: ChecksState | null;
  /** approved | changes-requested | review-required; only fetched for open PRs */
  review: string | null;
  /** head branch */
  branch: string;
  base: string;
  /** the head commit (src/github.ts fetches codeKeys once per head) */
  head: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  /** JIRA keys named in title or head branch, else in the body's start */
  keys: string[];
  /**
   * JIRA keys its code commits name (not merges, not `docs`, src/releases.ts codeKeys) – how a Sandcastle batch PR,
   * whose title names no ticket, belongs to every ticket it builds. Read while the PR is open, kept after.
   */
  codeKeys: string[];
  /** issues it closes: GitHub's closing references and `Closes #n` in the body */
  closes: number[];
}

/** A pull request in the API answers (JIRA ticket `prs`, Werkbank `pulls`). */
export type PullOut = Pick<Pull, "n" | "title" | "url" | "state" | "checks" | "review" | "branch" | "base" | "mergedAt"> & {
  /** documentation only (src/pulls.ts isDocsPull): never counts as the ticket's code */
  docs: boolean;
};

/** A version tag and the JIRA keys of the code commits it shipped (src/releases.ts, cached by tag). */
export interface Release {
  /** vX.Y.Z as tagged */
  tag: string;
  /** the commit the tag points at */
  oid: string;
  /** the commit of the previous version tag (the range starts there); null for the first one */
  base: string | null;
  /** when the tag was set (tagger date, else commit date) */
  at: string;
  /** keys named by non-merge, non-docs commits in base..oid */
  keys: string[];
}

/** The release a ticket's code first shipped in, and the later ones that added to it (src/releases.ts releasesByKey). */
export interface Released {
  version: string;
  at: string;
  later: { version: string; at: string }[];
}

export interface BoardData {
  etag: string;
  /** ISO time of the GitHub fetch the data comes from */
  fetchedAt: string;
  /** older than 15 s – a refresh is under way */
  stale: boolean;
  /** open issues + closed in the last 14 days, stories left out (they are in `stories`) */
  issues: Issue[];
  labels: LabelInfo[];
  assignees: Assignee[];
  stories: { number: number; title: string }[];
  hasGrill: boolean;
  /** closed issues before the 14-day window („Ältere laden“) */
  closedOlder: number;
  /** gh login of this machine – the filter's `@ich` */
  viewer: string;
  /** open PRs and those merged/closed in the last 30 days that close an issue of the board, main PR order */
  pulls: (PullOut & { closes: number[] })[];
  /** the last background refresh failed (the data is the previous one) */
  refreshError?: string;
}

export interface ClosedPage {
  issues: Issue[];
  /** closed issues still older than the oldest in `issues` */
  closedOlder: number;
}

export interface CommentOut {
  author: string;
  createdAt: string;
  bodyHtml: string;
}

export interface IssueDetail extends Issue {
  bodyHtml: string;
  comments: CommentOut[];
}
