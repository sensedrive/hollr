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
  /** missing on machines with an older hollr */
  lulWorkr?: LulWorkrFacts;
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

/** What a run does after the PR (skill flags --kein-testserver / --no-testnote / --testnote / --screencast). */
export type RunTest = "none" | "note" | "instructions" | "video";

/** `start`/`preview` config of the gate. */
export interface RunConfig {
  agent: string;
  provider?: string;
  model?: string;
  parallel: number;
  test: RunTest;
  /** several stories in a fixed scope: one batch or one run per story */
  split: "batch" | "single";
  branch?: string;
}

/** `preview`: the skill line a start would send; scope = stories/issues of a loop without queue mode, else null. */
export interface RunPreview {
  prompt: string;
  queueMode: boolean;
  order: number[];
  scope: number[] | null;
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
    /** the board's test-server choice; null for runs not started from the board */
    test: RunTest | null;
  };
  issues: RunIssue[];
  progress: { total: number; merged: number; failed: number; active: number; queued: number; percent: number };
  pr: number | null;
  logs: LogFile[];
  /** the run's batch flow (skippr's „Ablauf-Log v1“); absent on older hollr, null without a flow file */
  flow?: Flow | null;
  /** what the run's agent last said and is doing (its session log); absent on older hollr */
  agent?: { say: string | null; doing: string | null; at: string | null } | null;
}

export type FlowRole = "planner" | "implementer" | "reviewer" | "merger";
export type StageState = "pending" | "running" | "ok" | "failed" | "skipped";

/** A batch flow folded from its event file (server/src/flows.ts Flow). */
export interface Flow {
  kind: string;
  id: string;
  project: string | null;
  ticket: string | null;
  branch: string | null;
  worktree: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  outcome: "ok" | "failed" | "aborted" | null;
  /** worktree, sandcastle, checks, pr, deploy, testplan in this order, then stages seen beyond them */
  stages: { stage: string; state: StageState; startedAt: string | null; endedAt: string | null; reason: string | null; data: Record<string, unknown> }[];
  /** running stage, else a failed one, else the next pending one while the flow goes on */
  current: string | null;
  pass: { n: number; state: "running" | "ended"; reason: string | null; pid: number | null; host: string | null } | null;
  iteration: { n: number; max: number | null } | null;
  /** roles running now; `since` = when the role started (absent on older hollr) */
  active: { role: FlowRole; assignment: number | null; since?: string }[];
  assignments: {
    id: number;
    title: string | null;
    branch: string | null;
    role: FlowRole | null;
    result: "running" | "merged" | "failed" | "rejected";
    by: string | null;
    reason: string | null;
    reviewed: boolean;
    commits: number;
  }[];
  paused: string | null;
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

/** One step of a grill from its Ablauf-Log flow (server/src/grills.ts flowSteps). */
export interface GrillStep {
  n: number;
  stage: string;
  label: string;
  state: "pending" | "running" | "ok" | "failed" | "skipped";
  /** ok or skipped */
  done: boolean;
  reason: string | null;
}

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
  /** the 7 steps from the Ablauf-Log; null = no flow for this grill (progress unknown) */
  steps: GrillStep[] | null;
  /** first step not done, 1–7; 8 when all are done; null without a flow */
  step: number | null;
  /** `flow.paused` reason while the flow waits („wartet auf Antworten an #247“) */
  paused: string | null;
  /** id of the grill's flow in the Ablauf-Log */
  flow: string | null;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface Status {
  /** lulWorkr: `lul-workr --version` of the machine, null = not installed; missing with an older hollr */
  machine: { host: string; lulWorkr?: string | null };
  runs: Run[];
  lock: RunRecord | null;
  /** missing on machines with an older hollr */
  grills?: Grill[];
}

export interface QueueState {
  order: number[];
  tickets: Record<string, TicketFlags>;
}

/** Where a project's loop comes from (server `LulWorkrFacts`, lul-workr-init `engine/src/project.ts`). */
export interface LulWorkrFacts {
  /** `lulWorkr` of `.lul-workr.json`, e.g. `^1.1` */
  required: string | null;
  configVersion: number | null;
  mode: "bundle" | "forked" | "none";
  /** the machine's lul-workr satisfies `required`; null without a range */
  satisfied: boolean | null;
}

/** One tool of gate `tools` (the Werkzeuge screen) – only what the Versionen view reads. */
export interface ToolState {
  name: string;
  version?: string;
  /** newest release (cached 1 h by the machine); undefined = unknown */
  latest?: string;
  latestError?: string;
  updateAvailable?: boolean;
  running: boolean;
  exit?: number;
  log?: string;
}

export interface LogChunk {
  text: string;
  offset: number;
  size: number;
}

// ---- A: setup ops (Maschine wechseln) – gate sandcastle setup-*

/** The only files setup copies between machines. */
export type SetupFilePath = ".lul-workr.json" | ".env" | ".sandcastle/.env";

export interface SetupFileInfo {
  path: SetupFilePath;
  exists: boolean;
  size: number;
  secret: boolean;
  /** names of secret-looking keys, never values */
  keys: string[];
}

export interface SetupJob {
  kind: "clone" | "install";
  running: boolean;
  exit: number | null;
  log: string | null;
  startedAt: string | null;
}

export interface CheckItem {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix: "clone" | "files" | "install" | null;
  /** only a hint, never stops the move (the central sandcastle.env) */
  hint: boolean;
}

export interface SetupCheck {
  host: string;
  slug: string;
  /** the checkout, or where the clone goes */
  path: string;
  cloned: boolean;
  /** the machine's project scan lists it */
  known: boolean;
  pm: { name: string; lockfile: string | null; version: string | null } | null;
  items: CheckItem[];
  jobs: { clone: SetupJob | null; install: SetupJob | null };
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
  /** „Blockiert von“ entries without #N; absent in board copies cached before (the next full fetch fills it) */
  blockedNotes?: string[];
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

export type PullState = "open" | "draft" | "merged" | "closed";

/** A pull request (src/pulls.ts PullOut); checks and review are only known for open ones. */
export interface PullRequest {
  n: number;
  title: string;
  url: string;
  state: PullState;
  checks: "success" | "failure" | "pending" | null;
  /** approved | changes-requested | review-required */
  review: string | null;
  /** head branch */
  branch: string;
  /** base branch */
  base: string;
  mergedAt: string | null;
  /** documentation only (src/pulls.ts isDocsPull): never counts as the ticket's code */
  docs: boolean;
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
  /** PRs closing an issue of the board, main PR first */
  pulls: (PullRequest & { closes: number[] })[];
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

export type DriftKind = "label-on-gh" | "state-behind" | "done-candidate" | "done-not-in-main" | "no-key";

export interface DriftItem {
  kind: DriftKind;
  issue?: number;
  label?: string;
  /** label-on-gh: the ticket already has the label in JIRA */
  inJira?: boolean;
  expected?: string;
  actual?: string;
  /** done-not-in-main: the open/draft build PR keeping the work out of main (absent: no merged PR at all) */
  pr?: { n: number; state: PullState; checks: PullRequest["checks"] };
}

/** Whether the work is merged into the default branch (src/drift.ts inMain; released counts as yes); null: nothing on GitHub. */
export type InMain = "yes" | "partly" | "no";

/** The version tag a ticket's code first shipped in, and the later ones that added to it (src/types.ts Released). */
export interface Released {
  version: string;
  at: string;
  later: { version: string; at: string }[];
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
  derived: "selected" | "inProgress" | "testing" | null;
  drift: DriftItem[];
  /** its pull requests, main PR first */
  prs: PullRequest[];
  inMain: InMain | null;
  released: Released | null;
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
