/**
 * What the UI talks to, mirrored from the shared contract: A = `hollr gate sandcastle` on any machine (via the host
 * relay), C = this plugin's own /api (GitHub only). Kept self-contained so server refactors can't break the bundle.
 */

// ---- A: gate `sandcastle`

export interface Project {
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

export type Phase = "queued" | "planned" | "building" | "reviewing" | "merged" | "failed" | "no-commits";
export type RunStatus = "running" | "waiting" | "loop-ended" | "ended";

export interface LogFile {
  path: string;
  name: string;
  role: "planner" | "merger" | "implementer" | "reviewer" | "other";
  issue: number | null;
  size: number;
  mtime: number;
  active: boolean;
}

export interface TicketFlags {
  deploy: boolean;
  testnote: boolean;
  video: boolean;
}

export interface RunIssue {
  n: number;
  title: string | null;
  phase: Phase;
  reason: string | null;
  logs: LogFile[];
  flags: TicketFlags | null;
}

export interface Run {
  id: string;
  slug: string | null;
  project: string;
  cwd: string;
  branch: string;
  alive: boolean;
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  source: "hollr" | "manual";
  pane: string | null;
  status: RunStatus;
  config: {
    agent: string | null;
    agentLabel: string | null;
    model: string | null;
    parallel: number | null;
    scope: string | null;
    screencast: boolean | null;
  };
  issues: RunIssue[];
  progress: { total: number; merged: number; failed: number; active: number; queued: number; percent: number };
  pr: number | null;
  logs: LogFile[];
}

/** The machine's lock (run.json); only `project` is relied on. */
export interface RunRecord {
  id?: string;
  project?: string;
  pane?: string | null;
  startedAt?: string;
  [k: string]: unknown;
}

export interface Status {
  machine: { host: string };
  runs: Run[];
  lock: RunRecord | null;
}

export interface QueueState {
  order: number[];
  tickets: Record<string, TicketFlags>;
}

export interface LogChunk {
  text: string;
  offset: number;
  size: number;
}

// ---- B: host relay

export interface Server {
  id: string;
  label: string;
  self: boolean;
  online: boolean;
}

// ---- C: plugin /api

export type Column = "grill" | "backlog" | "queue" | "done";

export interface Issue {
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

export interface Label {
  name: string;
  color?: string;
}

export interface Assignee {
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface BoardData {
  etag: string;
  fetchedAt: string;
  stale: boolean;
  issues: Issue[];
  labels: Label[];
  assignees: Assignee[];
  stories: { number: number; title: string }[];
  hasGrill: boolean;
  closedOlder: number;
  /** gh login of the plugin machine's user, for `@ich` */
  viewer?: string | null;
  refreshError?: string;
}

export interface Comment {
  author: string;
  createdAt: string;
  bodyHtml: string;
}

export interface IssueDetail extends Issue {
  bodyHtml: string;
  comments: Comment[];
}
