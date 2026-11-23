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
  labels: {
    queue: string;
    story: string;
    grill: string | null;
    ready: string | null;
    ciFailed: string | null;
    nogo: string | null;
    workflow: string[];
  };
  jira: {
    baseUrl: string | null;
    projectKey: string | null;
    boardId: string | null;
    cloudId: string | null;
    states: { selected: string | null; inProgress: string | null; testing: string | null; done: string | null };
  };
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

export type GrillMode = "interactive" | "auto";
export type GrillStatus = "running" | "waiting" | "idle" | "done" | "ended";

/** A grill on one machine (gate `status.grills`, server/src/grills.ts). */
export interface Grill {
  /** `${slug}#${n}`, or `${cwd}|${key}` when slug or n is unknown */
  id: string;
  slug: string | null;
  project: string | null;
  n: number | null;
  key: string | null;
  /** null = hand-started without a Grill label */
  mode: GrillMode | null;
  source: "hollr" | "manual";
  pane: string | null;
  status: GrillStatus;
  steps: { n: number; label: string; done: boolean }[];
  /** first open step, 8 when all are done */
  step: number;
  notes: string[];
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface Status {
  machine: { host: string };
  runs: Run[];
  lock: RunRecord | null;
  /** missing on machines with an older hollr */
  grills?: Grill[];
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

// ---- C: plugin /api, JIRA (src/jira.ts, src/drift.ts, src/jiraboard.ts)

export type StatusCategory = "new" | "indeterminate" | "done";

export interface JiraStatus {
  name: string;
  category: StatusCategory;
}

/** A GitHub issue of a ticket's family. */
export interface FamilyMember {
  n: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  /** phase in a live Sandcastle run */
  phase?: string;
}

export interface Family {
  grill?: FamilyMember;
  story?: FamilyMember;
  children: FamilyMember[];
}

export type DriftKind = "label-on-gh" | "state-behind" | "done-candidate" | "no-key";

export interface DriftItem {
  kind: DriftKind;
  issue?: number;
  label?: string;
  /** label-on-gh: the ticket already has the label in JIRA */
  inJira?: boolean;
  expected?: string;
  actual?: string;
}

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  category: StatusCategory;
  labels: string[];
  assignee: { accountId: string; name: string; avatarUrl: string | null } | null;
  type: string;
  subtask: boolean;
  epic: { key: string; summary: string } | null;
  parent: string | null;
  priority: string | null;
  created: string;
  updated: string;
  /** browse link, null without jira.baseUrl */
  url: string | null;
  family: Family;
  derived: "inProgress" | "testing" | null;
  drift: DriftItem[];
}

export interface UnlinkedIssue extends FamilyMember {
  drift: DriftItem[];
}

export interface JiraBoardData {
  etag: string;
  fetchedAt: string;
  stale: boolean;
  refreshError?: string;
  /** workflow order */
  statuses: JiraStatus[];
  tickets: JiraTicket[];
  unlinked: UnlinkedIssue[];
  counts: { drift: number; info: number; tickets: number };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: string;
  category: StatusCategory;
}

export interface JiraIssueDetail {
  ticket: JiraTicket;
  description: string;
  descriptionHtml: string;
  comments: Comment[];
  transitions: JiraTransition[];
}

// ---- C: the drift guard (/api/guard, src/guard.ts)

export interface GuardApplied {
  key: string;
  kind: "label-on-gh" | "state-behind";
  issue?: number;
  label?: string;
  to?: string;
}

export interface GuardStatus {
  enabled: boolean;
  intervalMin: number;
  lastRun: string | null;
  nextRun: string | null;
  running: boolean;
  lastResult: { at: string; finishedAt: string; manual: boolean; projects: number; tickets: number; applied: number; errors: number; deferred: number } | null;
  /** project runs with something applied or failed, newest first */
  recent: { at: string; project: string; applied: GuardApplied[]; errors: { key?: string; message: string }[]; stopped?: boolean }[];
}
