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
  labels: { queue: string; story: string; grill: string | null };
  jira: { baseUrl: string | null; projectKey: string | null; boardId: string | null };
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
