/**
 * Flows from skippr's event contract „Ablauf-Log v1“: one append-only NDJSON file per flow execution at
 * `<git-common-dir>/lul-workr/flows/<kind>-<flowId>.ndjson`, written by the lul-workr skills and the Sandcastle
 * loop (`main.mts`). The sandcastle gate folds each file into a `Flow` – stages, pass, iteration, roles and
 * assignments – for the board: `batch` flows are Sandcastle runs, `skill` flows with `skill: grill|auto-grill`
 * are grills (stages = the grill's 7 steps).
 *
 * Every status poll is its own gate process, so the read offset and the folded state per file live in a cache
 * file in the state dir: a poll reads only the bytes appended since the last one.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type FlowRole = "planner" | "implementer" | "reviewer" | "merger";
export type StageState = "pending" | "running" | "ok" | "failed" | "skipped";
export type AssignmentResult = "running" | "merged" | "failed" | "rejected";

/** The stages of a batch in their order (vorlage.md „Abläufe und Etappen“); `teardown` follows after acceptance. */
export const BATCH_STAGES = [
  "worktree",
  "sandcastle",
  "checks",
  "pr",
  "deploy",
  "testplan",
] as const;

/** The grill skills' stages, steps 1–7 in order (Ablauf-Log contract of lul-workr-grill-jira-ticket). */
export const GRILL_STAGES = [
  "read",
  "grill",
  "jira-comment",
  "spec",
  "design",
  "story",
  "report",
] as const;
/** `flow.started` data.skill of a grill */
export const GRILL_SKILLS: readonly string[] = ["grill", "auto-grill"];

export interface FlowStage {
  stage: string;
  state: StageState;
  startedAt: string | null;
  endedAt: string | null;
  reason: string | null;
  /** what `stage.ended` carried besides stage/outcome/reason (worktree: path/branch/base, pr: url, …) */
  data: Record<string, unknown>;
}

export interface FlowAssignment {
  id: number;
  title: string | null;
  branch: string | null;
  /** the role working on it now (the merger counts for every reviewed assignment while it runs) */
  role: FlowRole | null;
  /** running = not finished yet, whether a role works on it or not */
  result: AssignmentResult;
  /** rejected: reviewer | implementer; failed: sandbox | timeout | quota | merge_conflict | checks_red | other */
  by: string | null;
  reason: string | null;
  /** the reviewer finished it without rejecting */
  reviewed: boolean;
  /** commits of its last implementer run */
  commits: number;
}

export interface Flow {
  kind: string;
  id: string;
  file: string;
  project: string | null;
  ticket: string | null;
  /** skill flows: `flow.started` data.skill (grill, auto-grill, …) */
  skill: string | null;
  /** skill flows: `flow.started` data.issue (a grill's GitHub issue) */
  issue: number | null;
  branch: string | null;
  worktree: string | null;
  startedAt: string;
  /** time of the last event */
  updatedAt: string;
  endedAt: string | null;
  /** ok: `flow.ended` ok or the last stage done; failed: a stage failed and none runs; aborted: `flow.ended` aborted */
  outcome: "ok" | "failed" | "aborted" | null;
  stages: FlowStage[];
  /** the running stage, else a failed one, else the next pending one while the flow goes on */
  current: string | null;
  pass: {
    n: number;
    state: "running" | "ended";
    /** finished | waiting_for_skipper | iteration_limit | quota | auth | aborted */
    reason: string | null;
    pid: number | null;
    host: string | null;
  } | null;
  iteration: { n: number; max: number | null } | null;
  /** roles running now; `since` = the `role.started` timestamp */
  active: { role: FlowRole; assignment: number | null; since: string }[];
  assignments: FlowAssignment[];
  /** `flow.paused` reason (batch: offline | sleep; grill: „wartet auf Antworten an #N“) until `flow.resumed` */
  paused: string | null;
  /** last applied `seq`: lines at or below it are duplicates */
  seq: number;
  /** `flow.ended` seen: its outcome is final */
  closed: boolean;
}

const ROLES: Record<string, FlowRole> = {
  planner: "planner",
  implementer: "implementer",
  reviewer: "reviewer",
  merger: "merger",
};
const roleOf = (v: unknown): FlowRole | undefined =>
  typeof v === "string" && Object.hasOwn(ROLES, v) ? ROLES[v] : undefined;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : {};
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;
/** `commits` is a SHA list in the contract, a count in older writers */
const count = (v: unknown): number =>
  Array.isArray(v) ? v.length : typeof v === "number" && v > 0 ? v : 0;

const pending = (stage: string): FlowStage => ({
  stage,
  state: "pending",
  startedAt: null,
  endedAt: null,
  reason: null,
  data: {},
});

/** An unfolded flow; a `skill-…` file starts without stages (they come with `flow.started`), others as a batch. */
export function emptyFlow(file: string): Flow {
  const skill = basename(file).startsWith("skill-");
  return {
    kind: "",
    id: "",
    file,
    project: null,
    ticket: null,
    skill: null,
    issue: null,
    branch: null,
    worktree: null,
    startedAt: "",
    updatedAt: "",
    endedAt: null,
    outcome: null,
    stages: skill ? [] : BATCH_STAGES.map(pending),
    current: skill ? null : "worktree",
    pass: null,
    iteration: null,
    active: [],
    assignments: [],
    paused: null,
    seq: -1,
    closed: false,
  };
}

function stageOf(f: Flow, stage: string): FlowStage {
  let s = f.stages.find((x) => x.stage === stage);
  if (!s) {
    s = pending(stage);
    f.stages.push(s);
  }
  return s;
}

function assignmentOf(f: Flow, id: number): FlowAssignment {
  let a = f.assignments.find((x) => x.id === id);
  if (!a) {
    a = {
      id,
      title: null,
      branch: null,
      role: null,
      result: "running",
      by: null,
      reason: null,
      reviewed: false,
      commits: 0,
    };
    f.assignments.push(a);
  }
  return a;
}

/** Folds one parsed line into `f` (mutates it); unknown types and foreign versions change nothing. */
export function applyEvent(f: Flow, e: unknown): void {
  const ev = rec(e);
  if (ev.v !== 1) return;
  const seq = int(ev.seq);
  if (seq !== null) {
    if (seq <= f.seq) return;
    f.seq = seq;
  }
  const ts = text(ev.ts) ?? f.updatedAt;
  const flow = rec(ev.flow);
  f.kind ||= text(flow.kind) ?? "";
  f.id ||= text(flow.id) ?? "";
  f.project ??= text(ev.project);
  f.ticket ??= text(ev.ticket);
  if (!f.startedAt) f.startedAt = ts;
  f.updatedAt = ts;
  const d = rec(ev.data);
  switch (ev.type) {
    case "flow.started":
      f.startedAt = ts;
      f.branch = text(d.branch) ?? f.branch;
      f.worktree = text(d.worktree) ?? f.worktree;
      if (f.kind === "skill") {
        f.skill = text(d.skill) ?? f.skill;
        f.issue = int(d.issue) ?? f.issue;
        // a grill's stages are its 7 steps in order; a batch's pending seed does not belong to a skill
        const order: readonly string[] =
          f.skill && GRILL_SKILLS.includes(f.skill) ? GRILL_STAGES : [];
        const seen = f.stages.filter((s) => s.state !== "pending" || order.includes(s.stage));
        f.stages = [
          ...order.map((stage) => seen.find((s) => s.stage === stage) ?? pending(stage)),
          ...seen.filter((s) => !order.includes(s.stage)),
        ];
      }
      break;
    case "flow.ended":
      f.closed = true;
      f.endedAt = ts;
      f.outcome = d.outcome === "aborted" ? "aborted" : "ok";
      break;
    case "flow.paused":
      f.paused = text(d.reason) ?? "offline";
      break;
    case "flow.resumed":
      f.paused = null;
      break;
    case "stage.started": {
      const name = text(d.stage);
      if (!name) return;
      const s = stageOf(f, name);
      Object.assign(s, { state: "running", startedAt: ts, endedAt: null, reason: null, data: {} });
      break;
    }
    case "stage.ended": {
      const name = text(d.stage);
      if (!name) return;
      const s = stageOf(f, name);
      const { stage: _s, outcome, reason, ...rest } = d;
      s.state = outcome === "failed" ? "failed" : outcome === "skipped" ? "skipped" : "ok";
      s.endedAt = ts;
      s.reason = text(reason);
      s.data = rest;
      if (name === "worktree") {
        f.worktree = text(rest.path) ?? f.worktree;
        f.branch = text(rest.branch) ?? f.branch;
      }
      break;
    }
    case "pass.started":
      f.pass = {
        n: int(ev.pass) ?? (f.pass?.n ?? 0) + 1,
        state: "running",
        reason: null,
        pid: int(d.pid),
        host: text(d.host),
      };
      f.active = [];
      for (const a of f.assignments) a.role = null;
      break;
    case "pass.ended":
      f.pass = {
        ...(f.pass ?? { n: int(ev.pass) ?? 1, pid: null, host: null }),
        state: "ended",
        reason: text(d.reason),
      };
      f.active = [];
      for (const a of f.assignments) a.role = null;
      break;
    case "iteration.started":
      f.iteration = { n: int(d.iteration) ?? (f.iteration?.n ?? 0) + 1, max: int(d.max) };
      break;
    case "plan.ready":
      for (const x of Array.isArray(d.assignments) ? d.assignments : []) {
        const id = Number(rec(x).id);
        if (!(id > 0)) continue;
        const a = assignmentOf(f, id);
        a.title = text(rec(x).title) ?? a.title;
        a.branch = text(rec(x).branch) ?? a.branch;
      }
      break;
    case "role.started": {
      const role = roleOf(d.role);
      if (!role) return;
      const id = int(d.assignment);
      f.active.push({ role, assignment: id, since: ts });
      if (id !== null) assignmentOf(f, id).role = role;
      else if (role === "merger")
        for (const a of f.assignments) if (a.result === "running" && a.reviewed) a.role = "merger";
      break;
    }
    case "role.ended": {
      const role = roleOf(d.role);
      if (!role) return;
      const id = int(d.assignment);
      const i = f.active.findIndex((x) => x.role === role && x.assignment === id);
      if (i >= 0) f.active.splice(i, 1);
      if (id !== null) {
        const a = assignmentOf(f, id);
        if (a.role === role) a.role = null;
        if (role === "implementer") a.commits = count(d.commits);
        if (role === "reviewer" && d.completed !== false && a.result === "running")
          a.reviewed = true;
      } else if (role === "merger")
        for (const a of f.assignments) if (a.role === "merger") a.role = null;
      break;
    }
    case "assignment.rejected":
    case "assignment.failed":
    case "assignment.merged": {
      const id = int(d.assignment);
      if (id === null) return;
      const a = assignmentOf(f, id);
      a.role = null;
      a.result =
        ev.type === "assignment.merged"
          ? "merged"
          : ev.type === "assignment.failed"
            ? "failed"
            : "rejected";
      a.by =
        ev.type === "assignment.rejected"
          ? text(d.by)
          : ev.type === "assignment.failed"
            ? text(d.kind)
            : null;
      a.reason =
        ev.type === "assignment.rejected"
          ? text(d.reason)
          : ev.type === "assignment.failed"
            ? text(d.message)
            : null;
      break;
    }
    case "assignment.decided": {
      const id = int(d.assignment);
      if (id === null) return;
      // replan / accept_anyway put it back into the batch; regrill / discard leave it where it is
      if (d.decision === "replan" || d.decision === "accept_anyway") {
        const a = assignmentOf(f, id);
        Object.assign(a, {
          result: "running",
          by: null,
          reason: null,
          reviewed: d.decision === "accept_anyway",
        });
      }
      break;
    }
    default:
      return;
  }
  settle(f, ts);
}

/** outcome, endedAt and current stage from the stages (after every event). */
function settle(f: Flow, ts: string): void {
  if (!f.closed) {
    const running = f.stages.find((s) => s.state === "running");
    const failed = f.stages.find((s) => s.state === "failed");
    const lastStage =
      f.kind === "skill"
        ? f.skill && GRILL_SKILLS.includes(f.skill)
          ? "report"
          : null
        : "testplan";
    const last = f.stages.find((s) => s.stage === lastStage);
    const outcome = running
      ? null
      : failed
        ? "failed"
        : last && (last.state === "ok" || last.state === "skipped")
          ? "ok"
          : null;
    if (outcome !== f.outcome) {
      f.outcome = outcome;
      f.endedAt = outcome ? ts : null;
    }
  }
  f.current =
    f.stages.find((s) => s.state === "running")?.stage ??
    f.stages.find((s) => s.state === "failed")?.stage ??
    (f.outcome ? null : (f.stages.find((s) => s.state === "pending")?.stage ?? null));
}

/** Folds NDJSON text; broken lines are skipped. */
export function foldFlow(textIn: string, file = "", into = emptyFlow(file)): Flow {
  for (const line of textIn.split("\n")) {
    if (!line.trim()) continue;
    try {
      applyEvent(into, JSON.parse(line));
    } catch {}
  }
  return into;
}

/** A flow still going: not ended, and its pass process alive on this host or an event in the last two hours. */
export function flowLive(
  f: Flow,
  now: number,
  host: string,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  if (f.outcome) return false;
  if (
    f.pass?.state === "running" &&
    f.pass.pid &&
    (!f.pass.host || f.pass.host === host) &&
    alive(f.pass.pid)
  )
    return true;
  return now - Date.parse(f.updatedAt) < 2 * 3600_000;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

/** The PR number of the `pr` stage's url. */
export function flowPr(f: Flow): number | null {
  const url = f.stages.find((s) => s.stage === "pr")?.data.url;
  const m = typeof url === "string" ? /\/pull\/(\d+)/.exec(url) : null;
  return m ? Number(m[1]) : null;
}

// ── reading with a persistent offset cache ─────────────────────────────────────────────────────────

interface CacheEntry {
  size: number;
  /** bytes folded so far (up to the last complete line) */
  offset: number;
  flow: Flow;
}

interface FlowCache {
  version: number;
  files: Record<string, CacheEntry>;
}

/** Bumped whenever Flow changes shape, so cached folds are redone. */
const CACHE_VERSION = 2;
const MAX_AGE = 14 * 24 * 3600_000;

export const flowsDir = (gitCommonDir: string) => join(gitCommonDir, "lul-workr", "flows");

function readFrom(file: string, offset: number, size: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The flows of the given kinds (`batch`, `skill`) in the given repos (git common dirs), newest first. Each file is
 * read only from where the last call stopped; `cacheFile` keeps offsets and folds between gate calls.
 */
export function readFlows(
  gitCommonDirs: Iterable<string>,
  cacheFile: string,
  now: number,
  kinds: readonly string[],
): Map<string, Flow[]> {
  let cache: FlowCache | null = null;
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8")) as FlowCache;
  } catch {}
  if (cache?.version !== CACHE_VERSION || typeof cache.files !== "object")
    cache = { version: CACHE_VERSION, files: {} };
  let changed = false;
  const seen = new Set<string>();
  const out = new Map<string, Flow[]>();
  for (const common of new Set(gitCommonDirs)) {
    const dir = flowsDir(common);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    const flows: Flow[] = [];
    for (const name of names) {
      const fileKind = kinds.find((k) => name.startsWith(`${k}-`));
      if (!fileKind || !name.endsWith(".ndjson")) continue;
      const file = join(dir, name);
      let size: number;
      let mtime: number;
      try {
        const st = statSync(file);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime > MAX_AGE) continue;
      seen.add(file);
      let entry = cache.files[file];
      // rewritten or truncated: fold from the start
      if (!entry || size < entry.offset) entry = { size: 0, offset: 0, flow: emptyFlow(file) };
      if (size > entry.offset) {
        let chunk = "";
        try {
          chunk = readFrom(file, entry.offset, size);
        } catch {
          continue;
        }
        // a line still being written waits for the next call
        const end = chunk.lastIndexOf("\n");
        if (end >= 0) {
          const complete = chunk.slice(0, end + 1);
          foldFlow(complete, file, entry.flow);
          entry.offset += Buffer.byteLength(complete);
        }
        entry.size = size;
        cache.files[file] = entry;
        changed = true;
      }
      if (entry.flow.kind ? kinds.includes(entry.flow.kind) : !!entry.flow.startedAt)
        flows.push(entry.flow);
    }
    flows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    out.set(common, flows);
  }
  for (const file of Object.keys(cache.files))
    if (!seen.has(file)) {
      try {
        statSync(file);
      } catch {
        delete cache.files[file];
        changed = true;
      }
    }
  if (changed) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(cache));
      renameSync(tmp, cacheFile);
    } catch {}
  }
  return out;
}
