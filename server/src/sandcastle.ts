/**
 * `hollr gate sandcastle`: Sandcastle runs on this machine for the Hollr board (plugins/sandcastle) – the
 * lul-workr projects checked out here, a status scan of loop processes and their logs, log tails, this
 * machine's queue (`<git-common-dir>/hollr-sandcastle/queue.json`) and the one-run-per-machine lock.
 *
 * Every open board polls `status` every few seconds, from every machine: it runs `ps` once, reads small files
 * and asks herdr for its agents. Everything slower (the project search under $HOME, PR lookups) comes from
 * caches in the state dir that detached children refresh, so a call never waits for them.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  collectGrills,
  type Grill,
  grillLabel,
  grillPrompt,
  readGrillRecords,
  recordGrill,
  validateGrillRequest,
} from "./grills";
import { type Agent, execHerdr, Herdr, newChat, promptWhenReady } from "./herdr";
import { which } from "./tools";

// ── types (the wire format, see the plugin's contract) ──────────────────────────────────────────────

export interface Project {
  /** owner/repo – the key the board uses */
  slug: string;
  name: string;
  root: string;
  gitCommonDir: string;
  defaultBranch: string;
  engine: string;
  /** workflow labels; ready/ciFailed/nogo are null when the project doesn't configure them */
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
    states: {
      selected: string | null;
      inProgress: string | null;
      testing: string | null;
      done: string | null;
    };
  };
  agents: { key: string; label: string; harness: string; model: string }[];
  defaults: { agent: string; parallel: number };
  /** the loop on the default branch knows the queue (lul-workr-setup → Sandcastle nachziehen) */
  queueSupported: boolean;
  error?: string;
}

export interface TicketFlags {
  /** test stack on workr */
  deploy: boolean;
  testnote: boolean;
  video: boolean;
}

export interface RunConfig {
  agent: string;
  provider: string | null;
  model: string | null;
  parallel: number;
  screencast: boolean;
  /** test server on workr for tickets without their own flags */
  deploy: boolean;
  /** branch the run builds on and targets with its PR; null = the project's default branch */
  branch: string | null;
}

/** `<state>/sandcastle/run.json`: the run started from the board – at most one per machine. */
export interface RunRecord {
  id: string;
  slug: string;
  project: string;
  root: string;
  pane: string;
  startedAt: string;
  config: RunConfig;
  /** the loop's working folder, from its `loop-start` event once it ran */
  cwd: string | null;
  endedAt: string | null;
  endReason: string | null;
}

export type LogRole = "planner" | "merger" | "implementer" | "reviewer" | "other";

export interface LogFile {
  path: string;
  name: string;
  role: LogRole;
  issue: number | null;
  size: number;
  mtime: number;
  /** written less than 90 s ago */
  active: boolean;
}

export type Phase =
  | "queued"
  | "planned"
  | "building"
  | "reviewing"
  | "merged"
  | "failed"
  | "no-commits";

export interface RunIssue {
  n: number;
  title: string | null;
  phase: Phase;
  reason: string | null;
  logs: LogFile[];
  flags: TicketFlags | null;
}

export type RunStatus = "running" | "waiting" | "loop-ended" | "ended";

export interface RunProgress {
  total: number;
  merged: number;
  failed: number;
  active: number;
  queued: number;
  percent: number;
}

export interface Run {
  id: string;
  slug: string | null;
  project: string;
  cwd: string;
  branch: string;
  /** the loop process is running */
  alive: boolean;
  pid: number | null;
  startedAt: string | null;
  /** when the loop stopped (its last log write) – also set while the skill still does checks/PR */
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
  progress: RunProgress;
  pr: number | null;
  logs: LogFile[];
}

export interface SandcastleRequest {
  op?: string;
  refresh?: boolean;
  path?: string;
  offset?: number;
  max?: number;
  slug?: string;
  order?: unknown;
  tickets?: unknown;
  config?: Record<string, unknown>;
  /** grill-start */
  n?: unknown;
  key?: unknown;
  mode?: unknown;
  advisor?: unknown;
}

/** What a call may replace – tests inject processes and herdr's agents and keep gh out. */
export interface Deps {
  /** argv of this hollr (background refreshes run `<cli> gate`); absent: no background refresh */
  cli?: string[];
  now?: number;
  procs?: LoopProc[];
  /** herdr's agents; null = herdr unreachable (nothing is concluded from it) */
  agents?: Agent[] | null;
  /** false: never start a `gh pr list` */
  prLookup?: boolean;
  /** opens the omp session for `start` (default: herdr) and returns its pane */
  startSession?: (cwd: string, label: string, prompt: string) => Promise<string>;
  /** the queue-labelled open issues for `start` (default: gh); null = unknown */
  queuedIssues?: (p: Project) => Promise<number[] | null>;
  /** queued issue → its story (`## Parent`), for a loop without queue mode (default: gh) */
  issueParents?: (p: Project, numbers: number[]) => Promise<Map<number, number | null>>;
  /** sends keys to a pane for `stop` (default: herdr) */
  sendKeys?: (pane: string, keys: string[]) => Promise<void>;
  /** pane → its herdr tab and workspace labels (default: herdr) */
  labels?: Map<string, string[]>;
}

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────

const DAY = 24 * 3600_000;
const ACTIVE_MS = 90_000;
const PROJECTS_TTL = 6 * 3600_000;
const PR_TTL = 60_000;
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^\\u0007]*\\u0007`, "g");

const home = () => Bun.env.HOME ?? homedir();
export const stateDir = () =>
  join(Bun.env.HOLLR_STATE_DIR ?? join(home(), ".local", "state", "hollr"), "sandcastle");
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, file);
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function run(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<{ ok: boolean; out: string; err: string }> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { ok: false, out: "", err: err instanceof Error ? err.message : String(err) };
  }
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 30_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, out, err };
  } finally {
    clearTimeout(timer);
  }
}

/** Starts a command in its own session so it outlives this gate call and its SSH channel. */
function spawnDetached(
  cmd: string[],
  opts: { env?: Record<string, string | undefined>; stdin?: string },
) {
  // macOS has no setsid binary: perl's POSIX::setsid (as tools.ts startTool)
  const detach = which("setsid")
    ? ["setsid"]
    : ["perl", "-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV"];
  try {
    const proc = Bun.spawn([...detach, ...cmd], {
      env: opts.env,
      stdin: opts.stdin ? Bun.file(opts.stdin) : "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
  } catch {}
}

/** Claims `marker` for `ms` (its mtime): false while an earlier claim is younger – one refresh at a time. */
function claim(marker: string, ms: number, now: number): boolean {
  if (now - mtimeOf(marker) < ms) return false;
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, String(process.pid));
  return true;
}

// ── projects ───────────────────────────────────────────────────────────────────────────────────────

type LabelKey = "queue" | "story" | "grillTicket" | "grill" | "ready" | "ciFailed" | "nogo";

/** `.lul-workr.json` as far as Sandcastle reads it; labels exist as `github.labels.*` and as `github.*`. */
interface Config {
  project?: unknown;
  repo?: { slug?: unknown; defaultBranch?: unknown };
  jira?: {
    baseUrl?: unknown;
    projectKey?: unknown;
    boardId?: unknown;
    cloudId?: unknown;
    states?: { selected?: unknown; inProgress?: unknown; testing?: unknown; done?: unknown };
  };
  github?: {
    labels?: Partial<Record<LabelKey, unknown>> & { workflow?: unknown };
    queue?: unknown;
    story?: unknown;
    grillTicket?: unknown;
    grill?: unknown;
    ready?: unknown;
    ciFailed?: unknown;
    nogo?: unknown;
  };
  engine?: {
    kind?: unknown;
    sandcastle?: { defaults?: { agent?: unknown; parallel?: unknown }; agents?: unknown };
  };
}

/** The project of a parsed `.lul-workr.json` in `root` (pure; queue support is measured by the caller). */
export function projectFromConfig(
  cfg: Config,
  root: string,
  gitCommonDir: string,
  queueSupported: boolean,
): Project {
  const gh = cfg.github ?? {};
  const label = (key: LabelKey) => str(gh.labels?.[key]) ?? str(gh[key]);
  const states = cfg.jira?.states;
  const parallel = cfg.engine?.sandcastle?.defaults?.parallel;
  const rawAgents = cfg.engine?.sandcastle?.agents;
  const boardId = cfg.jira?.boardId;
  const slug = str(cfg.repo?.slug) ?? "";
  return {
    slug,
    name: str(cfg.project) ?? basename(root),
    root,
    gitCommonDir,
    defaultBranch: str(cfg.repo?.defaultBranch) ?? "main",
    engine: str(cfg.engine?.kind) ?? "implement",
    labels: {
      queue: label("queue") ?? "Sandcastle",
      story: label("story") ?? "story",
      grill: label("grillTicket") ?? label("grill") ?? null,
      ready: label("ready") ?? null,
      ciFailed: label("ciFailed") ?? null,
      nogo: label("nogo") ?? null,
      workflow: Array.isArray(gh.labels?.workflow)
        ? gh.labels.workflow.filter((l): l is string => typeof l === "string" && !!l.trim())
        : [],
    },
    jira: {
      baseUrl: str(cfg.jira?.baseUrl)?.replace(/\/+$/, "") ?? null,
      projectKey: str(cfg.jira?.projectKey) ?? null,
      boardId: typeof boardId === "number" ? String(boardId) : (str(boardId) ?? null),
      cloudId: str(cfg.jira?.cloudId) ?? null,
      states: {
        selected: str(states?.selected) ?? null,
        inProgress: str(states?.inProgress) ?? null,
        testing: str(states?.testing) ?? null,
        done: str(states?.done) ?? null,
      },
    },
    agents: (Array.isArray(rawAgents) ? rawAgents : [])
      .map((a: Record<string, unknown>) => ({
        key: str(a?.key) ?? "",
        label: str(a?.label) ?? str(a?.key) ?? "",
        harness: str(a?.harness) ?? "",
        model: str(a?.model) ?? "",
      }))
      .filter((a) => a.key),
    defaults: {
      agent: str(cfg.engine?.sandcastle?.defaults?.agent) ?? "opus-5.5",
      parallel:
        typeof parallel === "number" && Number.isInteger(parallel) && parallel >= 1 ? parallel : 1,
    },
    queueSupported,
    ...(slug ? {} : { error: ".lul-workr.json: repo.slug fehlt" }),
  };
}

export async function measureQueueSupport(root: string, defaultBranch: string): Promise<boolean> {
  const r = await run(["git", "-C", root, "show", `origin/${defaultBranch}:.sandcastle/queue.mts`]);
  return r.ok && r.out.includes("hollr-sandcastle");
}

/** A checkout of a project's repo; clones of the same slug all count for mapping worktrees to it. */
interface Checkout {
  slug: string;
  root: string;
  gitCommonDir: string;
}

interface ProjectCache {
  /** PROJECTS_VERSION the cache was written with; an older shape is rescanned */
  version?: number;
  at: number;
  projects: Project[];
  checkouts: Checkout[];
}

/** Bumped whenever Project gains fields, so cached projects never miss them. */
const PROJECTS_VERSION = 3;

const projectsFile = () => join(stateDir(), "projects.json");

async function projectAt(dir: string): Promise<Project | undefined> {
  const git = await run([
    "git",
    "-C",
    dir,
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  const [gitDir, gitCommonDir] = git.out.trim().split("\n");
  // worktrees have their own git dir next to the shared one: only main checkouts count
  if (!git.ok || !gitDir || gitDir !== gitCommonDir) return undefined;
  let cfg: Config;
  try {
    cfg = JSON.parse(readFileSync(join(dir, ".lul-workr.json"), "utf8"));
  } catch {
    return {
      ...projectFromConfig({}, dir, gitCommonDir, false),
      error: ".lul-workr.json ist kein gültiges JSON",
    };
  }
  const p = projectFromConfig(cfg, dir, gitCommonDir, false);
  if (!p.error) p.queueSupported = await measureQueueSupport(dir, p.defaultBranch);
  return p;
}

/** Of two checkouts of one repo the board shows one: the folder named like the repo, else the busier one. */
function preferred(a: Project, b: Project): Project {
  const named = (p: Project) =>
    [p.slug.split("/").pop(), p.name].includes(basename(p.root)) ? 1 : 0;
  if (named(a) !== named(b)) return named(a) > named(b) ? a : b;
  return mtimeOf(join(a.gitCommonDir, "index")) >= mtimeOf(join(b.gitCommonDir, "index")) ? a : b;
}

async function discover(): Promise<ProjectCache> {
  // permission errors make find exit 1 – what it printed still counts
  const found = await run(
    [
      "find",
      home(),
      "-maxdepth",
      "5",
      "-name",
      ".lul-workr.json",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.herdr/*",
      "-not",
      "-path",
      "*/.sandcastle/*",
      "-not",
      "-path",
      "*/Library/*",
    ],
    { timeoutMs: 120_000 },
  );
  const dirs = found.out
    .split("\n")
    .filter(Boolean)
    .map((f) => dirname(f));
  const all = (await Promise.all(dirs.map(projectAt))).filter((p): p is Project => !!p);
  const bySlug = new Map<string, Project>();
  const broken: Project[] = [];
  for (const p of all) {
    if (!p.slug) broken.push(p);
    else {
      const seen = bySlug.get(p.slug);
      bySlug.set(p.slug, seen ? preferred(seen, p) : p);
    }
  }
  const projects = [...bySlug.values(), ...broken].sort((a, b) =>
    a.name.localeCompare(b.name, "de"),
  );
  return {
    version: PROJECTS_VERSION,
    at: Date.now(),
    projects,
    checkouts: all
      .filter((p) => p.slug)
      .map((p) => ({ slug: p.slug, root: p.root, gitCommonDir: p.gitCommonDir })),
  };
}

async function rescan(): Promise<ProjectCache> {
  const cache = await discover();
  writeJson(projectsFile(), cache);
  return cache;
}

/**
 * The cached projects: a missing cache is built now (the search takes seconds), an outdated one is
 * returned as is and refreshed by a detached `hollr gate sandcastle {"op":"projects","refresh":true}`.
 */
async function projectCache(deps: Deps, refresh = false): Promise<ProjectCache> {
  if (refresh) return rescan();
  const cache = readJson<ProjectCache>(projectsFile());
  if (!cache?.projects || cache.version !== PROJECTS_VERSION) return rescan();
  const now = deps.now ?? Date.now();
  if (
    now - cache.at > PROJECTS_TTL &&
    deps.cli?.length &&
    claim(join(stateDir(), "projects.refreshing"), 300_000, now)
  ) {
    const req = join(stateDir(), "projects-refresh.json");
    writeFileSync(req, `${JSON.stringify({ op: "projects", refresh: true })}\n`);
    spawnDetached([...deps.cli, "gate"], {
      env: { ...Bun.env, SSH_ORIGINAL_COMMAND: "sandcastle", BUN_BE_BUN: undefined },
      stdin: req,
    });
  }
  return { ...cache, checkouts: cache.checkouts ?? [] };
}

function projectBySlug(cache: ProjectCache, slug: unknown): Project {
  const p = cache.projects.find((x) => x.slug === slug);
  if (!p)
    throw new Error(`Projekt ${String(slug ?? "")} ist auf diesem Rechner nicht ausgecheckt.`);
  if (p.error) throw new Error(p.error);
  return p;
}

// ── queue file ─────────────────────────────────────────────────────────────────────────────────────

export const queueDir = (gitCommonDir: string) => join(gitCommonDir, "hollr-sandcastle");
const queueFile = (gitCommonDir: string) => join(queueDir(gitCommonDir), "queue.json");

/** video needs a test note, either needs the test stack; null: not a flags object. */
export function normalizeFlags(v: unknown): TicketFlags | null {
  if (typeof v !== "object" || v === null) return null;
  const f = v as Record<string, unknown>;
  const video = f.video === true;
  const testnote = f.testnote === true || video;
  return { deploy: f.deploy === true || testnote, testnote, video };
}

const positiveInts = (v: unknown): number[] =>
  Array.isArray(v) ? [...new Set(v.filter((n): n is number => Number.isInteger(n) && n > 0))] : [];

export function readQueue(gitCommonDir: string): {
  order: number[];
  tickets: Record<string, TicketFlags>;
} {
  const data = readJson<{ order?: unknown; tickets?: unknown }>(queueFile(gitCommonDir));
  const tickets: Record<string, TicketFlags> = {};
  if (data?.tickets && typeof data.tickets === "object")
    for (const [k, v] of Object.entries(data.tickets)) {
      const f = normalizeFlags(v);
      if (/^\d+$/.test(k) && f) tickets[k] = f;
    }
  return { order: positiveInts(data?.order), tickets };
}

/**
 * Replaces `order` and merges `tickets` (null removes a ticket's flags); other fields of the file stay –
 * the loop reads only `order`.
 */
export function writeQueue(
  gitCommonDir: string,
  patch: { order?: unknown; tickets?: unknown },
): { order: number[]; tickets: Record<string, TicketFlags> } {
  const file = queueFile(gitCommonDir);
  const raw = readJson<Record<string, unknown>>(file);
  const data: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const current = readQueue(gitCommonDir);
  if (patch.order !== undefined) {
    if (!Array.isArray(patch.order))
      throw new Error("order muss eine Liste von Issue-Nummern sein.");
    current.order = positiveInts(patch.order);
  }
  if (patch.tickets !== undefined) {
    if (typeof patch.tickets !== "object" || patch.tickets === null || Array.isArray(patch.tickets))
      throw new Error("tickets muss ein Objekt sein.");
    for (const [k, v] of Object.entries(patch.tickets)) {
      if (!/^\d+$/.test(k)) throw new Error(`Ungültige Issue-Nummer „${k}“.`);
      const f = normalizeFlags(v);
      if (f) current.tickets[k] = f;
      else delete current.tickets[k];
    }
  }
  writeJson(file, { ...data, version: 1, order: current.order, tickets: current.tickets });
  return current;
}

/**
 * The loop's order rule: `order` kept to the queued issues (open, not a story, queue label), then queued
 * issues it lacks in ascending number order.
 */
export function effectiveOrder(order: number[], queued: number[]): number[] {
  const set = new Set(queued);
  const kept = [...new Set(order)].filter((n) => set.has(n));
  const known = new Set(kept);
  return [...kept, ...[...set].filter((n) => !known.has(n)).sort((a, b) => a - b)];
}

// ── events.jsonl (queue mode: written by the loop and the skill) ───────────────────────────────────

export interface Progress {
  loop?: { cwd: string; branch: string };
  picked: Set<number>;
  merged: Set<number>;
  failed: Map<number, string>;
  noCommits: Set<number>;
  titles: Map<number, string>;
  loopEnded?: string;
  runEnd?: { result: string; pr: number | null };
}

const field = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;

const nums = (v: unknown): number[] =>
  Array.isArray(v)
    ? v.map((x) => Number(typeof x === "object" ? field(x, "id") : x)).filter((n) => n > 0)
    : [];

/**
 * Events at or after `since` (ms); broken lines are skipped; a later event about an issue wins. With `cwd`
 * only what the loop in that folder wrote counts (events.jsonl is shared by all folders of the repo).
 */
export function parseProgress(text: string, since: number, cwd?: string): Progress {
  const p: Progress = {
    picked: new Set(),
    merged: new Set(),
    failed: new Map(),
    noCommits: new Set(),
    titles: new Map(),
  };
  let current: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!(Date.parse(String(field(e, "at") ?? "")) >= since)) continue;
    const t = field(e, "t");
    if (t === "loop-start") current = String(field(e, "cwd") ?? "");
    if (cwd !== undefined && current !== cwd) continue;
    switch (t) {
      case "loop-start":
        p.loop = { cwd: current ?? "", branch: String(field(e, "branch") ?? "") };
        p.loopEnded = undefined;
        break;
      case "picked": {
        const issues = field(e, "issues");
        for (const issue of Array.isArray(issues) ? issues : []) {
          const n = Number(field(issue, "id"));
          if (!(n > 0)) continue;
          p.picked.add(n);
          p.merged.delete(n);
          p.failed.delete(n);
          p.noCommits.delete(n);
          const title = field(issue, "title");
          if (typeof title === "string") p.titles.set(n, title);
        }
        break;
      }
      case "failed": {
        const n = Number(field(e, "issue"));
        if (n > 0) {
          p.failed.set(n, String(field(e, "reason") ?? ""));
          p.merged.delete(n);
          p.noCommits.delete(n);
        }
        break;
      }
      case "no-commits":
        for (const n of nums(field(e, "issues"))) {
          p.noCommits.add(n);
          p.failed.delete(n);
          p.merged.delete(n);
        }
        break;
      case "merged":
        for (const n of nums(field(e, "issues"))) {
          p.merged.add(n);
          p.failed.delete(n);
          p.noCommits.delete(n);
        }
        break;
      case "loop-end":
        p.loopEnded = String(field(e, "reason") ?? "");
        break;
      case "run-end": {
        const pr = field(e, "pr");
        p.runEnd = {
          result: String(field(e, "result") ?? ""),
          pr: typeof pr === "number" ? pr : null,
        };
        break;
      }
    }
  }
  return p;
}

function readProgress(gitCommonDir: string, since: number, cwd?: string): Progress {
  let text = "";
  try {
    text = readFileSync(join(queueDir(gitCommonDir), "events.jsonl"), "utf8");
  } catch {}
  return parseProgress(text, since, cwd);
}

// ── log parsing ────────────────────────────────────────────────────────────────────────────────────

const RUN_START = /^--- Run started: (\S+) ---$/gm;

/** The text of the runs (`--- Run started: <iso> ---` sections) since `since`; no markers: all of it. */
export function sectionsSince(text: string, since: number): string {
  const marks = [...text.matchAll(RUN_START)];
  if (!marks.length) return text;
  let out = "";
  marks.forEach((m, i) => {
    if (!(Date.parse(m[1] ?? "") >= since)) return;
    out += text.slice(m.index, marks[i + 1]?.index ?? text.length);
  });
  return out;
}

/** Start times of the runs in a log (ms). */
const runStarts = (text: string): number[] =>
  [...text.matchAll(RUN_START)].map((m) => Date.parse(m[1] ?? "")).filter((t) => t > 0);

/** Issues of the planner's `<plan>{"issues":[{"id":N,"title":…}]}</plan>` blocks, later titles win. */
export function plannedIssues(text: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  for (const m of text.matchAll(/<plan>\s*([\s\S]*?)\s*<\/plan>/g)) {
    let plan: unknown;
    try {
      plan = JSON.parse(m[1] ?? "");
    } catch {
      continue;
    }
    const issues = field(plan, "issues");
    for (const issue of Array.isArray(issues) ? issues : []) {
      const n = Number(field(issue, "id"));
      const title = field(issue, "title");
      if (n > 0) out.set(n, typeof title === "string" ? title : (out.get(n) ?? null));
    }
  }
  return out;
}

/** Issues the merger brought in: `merge --squash sandcastle/issue-N` or `Closes #N`. */
export function mergedIssues(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/merge --squash\s+sandcastle\/issue-(\d+)|\bCloses #(\d+)/g))
    out.add(Number(m[1] ?? m[2]));
  return out;
}

const ERROR_LINE =
  /\b(error|errors|fehler|failed|fehlgeschlagen|fatal|timeout|timed out|zeitüberschreitung|killed|oom|exit code [1-9]\d*|exited with code [1-9]\d*)\b/i;

/** The last line that looks like an error, without the agent's own tool calls (`Bash(…)` …). */
export function lastErrorLine(text: string): string | null {
  const lines = text.replace(ANSI, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line && !/^\w+\(/.test(line) && ERROR_LINE.test(line)) return line.slice(0, 300);
  }
  return null;
}

/** The last run of an implementer/reviewer log, from its last 256 KiB. */
interface IssueLogRun {
  /** that run started at or after `since` */
  inWindow: boolean;
  /** its `--- Run started` time (ms), null when the tail has no marker */
  started: number | null;
  /** synced commits to the host; false: collected none; null: still running */
  commits: boolean | null;
  error: string | null;
}

function issueLogRun(file: LogFile, since: number): IssueLogRun {
  const text = readTail(file.path, 256 * 1024);
  const marks = [...text.matchAll(RUN_START)];
  const last = marks[marks.length - 1];
  const started = last ? Date.parse(last[1] ?? "") || null : null;
  // no marker in the tail: one long run – its file was written in the window
  const inWindow = started !== null ? started >= since : file.mtime >= since;
  const section = last ? text.slice(last.index) : text;
  return {
    inWindow,
    started,
    commits: /Syncing \d+ commits? to host/.test(section)
      ? true
      : /Collecting commits done/.test(section)
        ? false
        : null,
    error: lastErrorLine(section),
  };
}

function readTail(path: string, max: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function roleOf(name: string): { role: LogRole; issue: number | null } {
  const m = name.match(/^sandcastle-issue-(\d+)-(implementer|reviewer)\.log$/);
  if (m) return { role: m[2] as LogRole, issue: Number(m[1]) };
  if (name.endsWith("-planner.log")) return { role: "planner", issue: null };
  if (name.endsWith("-merger.log")) return { role: "merger", issue: null };
  return { role: "other", issue: null };
}

/** `<cwd>/.sandcastle/logs/*.log` written at or after `since`. */
export function listLogs(cwd: string, since: number, now: number): LogFile[] {
  const dir = join(cwd, ".sandcastle", "logs");
  const out: LogFile[] = [];
  for (const name of listDir(dir)) {
    if (!name.endsWith(".log")) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile() || st.mtimeMs < since) continue;
      out.push({
        path: join(dir, name),
        name,
        ...roleOf(name),
        size: st.size,
        mtime: Math.round(st.mtimeMs),
        active: now - st.mtimeMs < ACTIVE_MS,
      });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── loop processes ─────────────────────────────────────────────────────────────────────────────────

export interface LoopProc {
  pid: number;
  /** process start (ms) */
  start: number;
  args: string;
  cwd: string | null;
  /** SANDCASTLE_* of its environment */
  env: Record<string, string>;
}

const LOOP_ARGS = [
  /\.sandcastle\/main\.m?[jt]s\b/,
  // `yarn sandcastle`, `npm run sandcastle` … (yarn runs as `node …/yarn-4.x.cjs sandcastle`)
  /(?:^|[\s/])(?:yarn|npm|pnpm|bun)(?:-[\d.]+)?(?:\.c?js)?(?:\s+run)?\s+sandcastle(?:\s|$)/,
];

/** `ps -axww -o pid=,lstart=,args=` lines that are Sandcastle loops (pure). */
export function parsePs(text: string, self = process.pid): Omit<LoopProc, "cwd" | "env">[] {
  const out: Omit<LoopProc, "cwd" | "env">[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const args = m[3] ?? "";
    if (pid === self || !LOOP_ARGS.some((re) => re.test(args))) continue;
    out.push({ pid, start: Date.parse(m[2] ?? "") || 0, args });
  }
  return out;
}

/** SANDCASTLE_* variables in `ps eww` output or a NUL-separated environ. */
export function sandcastleEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const m of text.matchAll(/(?:^|[\s\0])(SANDCASTLE_[A-Z_]+)=([^\s\0]*)/g))
    env[m[1] ?? ""] = m[2] ?? "";
  return env;
}

async function loopProcesses(): Promise<LoopProc[]> {
  const env = { ...Bun.env, LC_ALL: "C" };
  const ps = await run(["ps", "-axww", "-o", "pid=,lstart=,args="], { env, timeoutMs: 5000 });
  const found = parsePs(ps.out);
  if (!found.length) return [];
  const pids = found.map((p) => p.pid);
  const cwds = new Map<number, string>();
  const envs = new Map<number, Record<string, string>>();
  if (existsSync("/proc/self/environ")) {
    for (const pid of pids) {
      try {
        cwds.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {}
      try {
        envs.set(pid, sandcastleEnv(readFileSync(`/proc/${pid}/environ`, "utf8")));
      } catch {}
    }
  } else {
    const [lsof, penv] = await Promise.all([
      run(["lsof", "-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], { timeoutMs: 5000 }),
      run(["ps", "eww", "-o", "pid=,command=", "-p", pids.join(",")], { env, timeoutMs: 5000 }),
    ]);
    let pid = 0;
    for (const line of lsof.out.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
    }
    for (const line of penv.out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s/);
      if (m) envs.set(Number(m[1]), sandcastleEnv(line));
    }
  }
  return found.map((p) => ({ ...p, cwd: cwds.get(p.pid) ?? null, env: envs.get(p.pid) ?? {} }));
}

async function herdrAgents(): Promise<Agent[] | null> {
  try {
    return await new Herdr().agents();
  } catch {
    return null;
  }
}

/** pane → [tab label, workspace label]: grills are recognised by their session label. */
async function herdrLabels(): Promise<Map<string, string[]>> {
  const labels = new Map<string, string[]>();
  try {
    const [ws, tabs, panes] = (await Promise.all([
      execHerdr(["workspace", "list"]),
      execHerdr(["tab", "list"]),
      execHerdr(["pane", "list"]),
    ])) as [
      { workspaces?: { workspace_id?: string; label?: string }[] },
      { tabs?: { tab_id?: string; label?: string }[] },
      { panes?: { pane_id?: string; tab_id?: string; workspace_id?: string }[] },
    ];
    const wsLabel = new Map((ws.workspaces ?? []).map((w) => [w.workspace_id, w.label ?? ""]));
    const tabLabel = new Map((tabs.tabs ?? []).map((t) => [t.tab_id, t.label ?? ""]));
    for (const p of panes.panes ?? [])
      if (p.pane_id)
        labels.set(p.pane_id, [tabLabel.get(p.tab_id) ?? "", wsLabel.get(p.workspace_id) ?? ""]);
  } catch {}
  return labels;
}

// ── git facts of a working folder (files only, no git process) ──────────────────────────────────────

/** git dir, common dir and branch of `cwd` from its `.git` (a dir, or a worktree's `gitdir:` file). */
export function gitFacts(
  cwd: string,
): { gitDir: string; commonDir: string; branch: string } | null {
  const dotGit = join(cwd, ".git");
  let gitDir = dotGit;
  let commonDir = dotGit;
  try {
    if (statSync(dotGit).isFile()) {
      const ref = readFileSync(dotGit, "utf8")
        .match(/^gitdir:\s*(.+)$/m)?.[1]
        ?.trim();
      if (!ref) return null;
      gitDir = isAbsolute(ref) ? ref : resolve(cwd, ref);
      const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const branch = head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 9);
    return { gitDir, commonDir, branch };
  } catch {
    return null;
  }
}

/** Working folders of a repo's linked worktrees (`<common>/worktrees/*\/gitdir` → `<folder>/.git`). */
function worktreesOf(gitCommonDir: string): string[] {
  const base = join(gitCommonDir, "worktrees");
  return listDir(base)
    .map((w) => {
      try {
        return dirname(readFileSync(join(base, w, "gitdir"), "utf8").trim());
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

// ── PR lookup (cached, refreshed in the background) ────────────────────────────────────────────────

function cachedPr(
  slug: string | null,
  cwd: string,
  branch: string,
  now: number,
  lookup: boolean,
): number | null {
  const file = join(stateDir(), "pr", `${sha1(`${slug ?? cwd}\n${branch}`).slice(0, 16)}.json`);
  let pr: number | null = null;
  const data = readJson<{ number?: number }[]>(file);
  if (Array.isArray(data) && typeof data[0]?.number === "number") pr = data[0].number;
  if (lookup && now - mtimeOf(file) > PR_TTL && claim(`${file}.pending`, 30_000, now)) {
    // gh's answer lands in the file; an error leaves it empty (= no PR) and is retried after PR_TTL
    const script =
      'cd "$4" 2>/dev/null; gh pr list $1 --head "$2" --state all --json number --limit 1 > "$3.tmp" 2>/dev/null; mv -f "$3.tmp" "$3"';
    spawnDetached(["sh", "-c", script, "sh", slug ? `--repo=${slug}` : "", branch, file, cwd], {
      env: Bun.env,
    });
  }
  return pr;
}

// ── run lock ───────────────────────────────────────────────────────────────────────────────────────

const lockFile = () => join(stateDir(), "run.json");
export const readLock = () => readJson<RunRecord>(lockFile());

/**
 * The lock with what its run did since it started; records the end once it shows (the skill's `run-end`,
 * or its session is gone). `active`: not ended.
 */
function evaluateLock(
  cache: ProjectCache,
  agents: Agent[] | null,
): { lock: RunRecord | null; progress: Progress | null; active: boolean } {
  const lock = readLock();
  if (!lock) return { lock: null, progress: null, active: false };
  const project = cache.projects.find((p) => p.slug === lock.slug);
  const progress = project ? readProgress(project.gitCommonDir, Date.parse(lock.startedAt)) : null;
  if (lock.endedAt) return { lock, progress, active: false };
  let changed = false;
  if (progress?.loop?.cwd && lock.cwd !== progress.loop.cwd) {
    lock.cwd = progress.loop.cwd;
    changed = true;
  }
  const end = progress?.runEnd
    ? progress.runEnd.result === "ok"
      ? "fertig"
      : "abgebrochen"
    : agents && !agents.some((a) => a.pane === lock.pane)
      ? "Sitzung geschlossen"
      : null;
  if (end) {
    lock.endedAt = new Date().toISOString();
    lock.endReason = end;
    changed = true;
  }
  if (changed) writeJson(lockFile(), lock);
  return { lock, progress, active: !lock.endedAt };
}

// ── status ─────────────────────────────────────────────────────────────────────────────────────────

/** percent = merged + failed of all, rounded (pure). */
export function progressOf(issues: RunIssue[]): RunProgress {
  const count = (...phases: Phase[]) => issues.filter((i) => phases.includes(i.phase)).length;
  const merged = count("merged");
  const failed = count("failed", "no-commits");
  return {
    total: issues.length,
    merged,
    failed,
    active: count("building", "reviewing"),
    queued: count("queued", "planned"),
    percent: Math.round((100 * (merged + failed)) / Math.max(issues.length, 1)),
  };
}

interface RunInput {
  cwd: string;
  logs: LogFile[];
  procs: LoopProc[];
  project: Project | null;
  /** the lock, when it belongs to this folder */
  lock: RunRecord | null;
  lockActive: boolean;
  agents: Agent[] | null;
  since: number;
  now: number;
  prLookup: boolean;
}

/** One run: a working folder with a loop process, the board's lock, or logs from the last day. */
function buildRun(a: RunInput): Run {
  const facts = gitFacts(a.cwd);
  const proc = [...a.procs].sort((x, y) => x.start - y.start)[0];
  const env: Record<string, string> = Object.assign({}, ...a.procs.map((p) => p.env));
  const alive = a.procs.length > 0 || a.logs.some((l) => l.active);
  const p = a.project;

  const progress = p ? readProgress(p.gitCommonDir, a.since, a.cwd) : null;
  const branch = facts?.branch ?? progress?.loop?.branch ?? "";
  const queueMode = env.SANDCASTLE_STORY_IDS === "queue" || !!progress?.loop || !!a.lock;
  const queue = p ? readQueue(p.gitCommonDir) : { order: [], tickets: {} };

  // each issue's implementer/reviewer run in the window, read once
  const byIssue = new Map<number, LogFile[]>();
  for (const l of a.logs)
    if (l.issue !== null) byIssue.set(l.issue, [...(byIssue.get(l.issue) ?? []), l]);
  const issueRuns = new Map<
    number,
    { implementer: IssueLogRun | null; reviewer: IssueLogRun | null }
  >();
  for (const [n, logs] of byIssue) {
    const of = (role: LogRole) => {
      const f = logs.find((l) => l.role === role);
      const r = f ? issueLogRun(f, a.since) : null;
      return r?.inWindow ? r : null;
    };
    const runs = { implementer: of("implementer"), reviewer: of("reviewer") };
    if (runs.implementer || runs.reviewer) issueRuns.set(n, runs);
  }
  /** an issue between pick and merge: building or reviewing while the loop runs, else how it ended */
  const unfinished = (n: number): { phase: Phase; reason: string | null } => {
    const { implementer = null, reviewer = null } = issueRuns.get(n) ?? {};
    if (alive)
      return { phase: reviewer ? "reviewing" : implementer ? "building" : "planned", reason: null };
    if (!reviewer && !implementer) return { phase: "planned", reason: null };
    if (implementer?.commits === false) return { phase: "no-commits", reason: null };
    return {
      phase: "failed",
      reason: reviewer?.error ?? implementer?.error ?? "nicht gemergt",
    };
  };
  const text = (role: LogRole) =>
    a.logs
      .filter((l) => l.role === role)
      .map((f) => sectionsSince(readTail(f.path, 4 * 1024 * 1024), a.since))
      .join("\n");
  const plannerText = text("planner");
  const mergerText = text("merger");

  const issues = new Map<number, { title: string | null; phase: Phase; reason: string | null }>();
  if (queueMode && progress) {
    for (const n of progress.picked) issues.set(n, { title: null, ...unfinished(n) });
    for (const [n, reason] of progress.failed)
      issues.set(n, { title: null, phase: "failed", reason });
    for (const n of progress.noCommits)
      issues.set(n, { title: null, phase: "no-commits", reason: null });
    for (const n of progress.merged) issues.set(n, { title: null, phase: "merged", reason: null });
    for (const [n, t] of progress.titles) {
      const i = issues.get(n);
      if (i) i.title = t;
    }
    // what the board queued and the loop has not picked yet – only while this run goes on
    if (alive || a.lockActive)
      for (const n of queue.order)
        if (!issues.has(n)) issues.set(n, { title: null, phase: "queued", reason: null });
  } else {
    const planned = plannedIssues(plannerText);
    const merged = mergedIssues(mergerText);
    for (const n of new Set([...planned.keys(), ...issueRuns.keys()]))
      issues.set(n, {
        title: planned.get(n) ?? null,
        ...(merged.has(n) ? { phase: "merged" as Phase, reason: null } : unfinished(n)),
      });
  }

  const list: RunIssue[] = [...issues.entries()].map(([n, i]) => ({
    n,
    ...i,
    logs: (byIssue.get(n) ?? []).sort((x, y) =>
      x.role === "implementer" ? -1 : y.role === "implementer" ? 1 : 0,
    ),
    flags: queue.tickets[String(n)] ?? null,
  }));
  const order = new Map(queue.order.map((n, i) => [n, i]));
  const rank: Record<Phase, number> = {
    building: 0,
    reviewing: 0,
    planned: 1,
    queued: 2,
    merged: 3,
    "no-commits": 3,
    failed: 3,
  };
  list.sort(
    (x, y) =>
      rank[x.phase] - rank[y.phase] ||
      (order.get(x.n) ?? Number.MAX_SAFE_INTEGER) - (order.get(y.n) ?? Number.MAX_SAFE_INTEGER) ||
      x.n - y.n,
  );

  // the session running the skill: the lock's, else an agent working in this folder
  const lockPane = a.lock ? (a.agents?.find((x) => x.pane === a.lock?.pane) ?? null) : null;
  const here = (a.agents ?? []).filter((x) => x.cwd === a.cwd && x.kind !== "unknown");
  const agent =
    lockPane ??
    here.find((x) => x.status === "blocked" || x.status === "working") ??
    here[0] ??
    null;
  const pane = agent?.pane ?? (a.lockActive ? (a.lock?.pane ?? null) : null);
  const blocked = agent?.status === "blocked";
  const busy = agent?.status === "working" || blocked;
  let status: RunStatus;
  if (alive) status = blocked ? "waiting" : "running";
  else if (a.lockActive) status = blocked ? "waiting" : progress?.loop ? "loop-ended" : "running";
  else if (busy && !progress?.runEnd) status = blocked ? "waiting" : "loop-ended";
  else status = "ended";

  const starts = [
    ...runStarts(plannerText),
    ...runStarts(mergerText),
    ...[...issueRuns.values()].flatMap((r) => [r.implementer?.started, r.reviewer?.started]),
  ].filter((t): t is number => !!t && t >= a.since);
  const startedAt = proc
    ? iso(proc.start)
    : a.lock
      ? a.lock.startedAt
      : starts.length
        ? iso(Math.min(...starts))
        : a.logs.length
          ? iso(Math.min(...a.logs.map((l) => l.mtime)))
          : null;
  const lastWrite = a.logs.length ? Math.max(...a.logs.map((l) => l.mtime)) : null;
  const endedAt = alive ? null : (a.lock?.endedAt ?? (lastWrite ? iso(lastWrite) : null));

  const cfg = a.lock?.config;
  const loopEnv = Object.keys(env).length > 0;
  const agentKey = env.SANDCASTLE_AGENT ?? cfg?.agent ?? (loopEnv ? "opus-5.5" : null);
  const preset = p?.agents.find((x) => x.key === agentKey);
  const model = env.SANDCASTLE_MODEL ?? cfg?.model ?? preset?.model ?? null;
  const provider = env.SANDCASTLE_PROVIDER ?? cfg?.provider ?? null;
  const parallel = Number(
    env.SANDCASTLE_MAX_PARALLEL ?? cfg?.parallel ?? (loopEnv ? 1 : Number.NaN),
  );
  const issueIds = env.SANDCASTLE_ISSUE_IDS ? ` + #${env.SANDCASTLE_ISSUE_IDS}` : "";

  return {
    id: sha1(a.cwd).slice(0, 12),
    slug: p?.slug ?? null,
    project: p?.name ?? a.lock?.project ?? basename(a.cwd),
    cwd: a.cwd,
    branch,
    alive,
    pid: proc?.pid ?? null,
    startedAt,
    endedAt,
    source: a.lock ? "hollr" : "manual",
    pane,
    status,
    config: {
      agent: agentKey,
      agentLabel:
        preset?.label ??
        (agentKey === "custom" && provider ? `${provider} · ${model ?? "?"}` : agentKey),
      model,
      parallel: Number.isInteger(parallel) && parallel > 0 ? parallel : null,
      scope: env.SANDCASTLE_STORY_IDS
        ? `${env.SANDCASTLE_STORY_IDS}${issueIds}`
        : a.lock
          ? "queue"
          : null,
      screencast: cfg ? cfg.screencast : null,
    },
    issues: list,
    progress: progressOf(list),
    pr:
      progress?.runEnd?.pr ??
      (branch && branch !== p?.defaultBranch
        ? cachedPr(p?.slug ?? null, a.cwd, branch, a.now, a.prLookup)
        : null),
    logs: a.logs.filter((l) => l.issue === null),
  };
}

/** Repo (git common dir) → project, clones of a slug included. */
function projectsByCommon(cache: ProjectCache): Map<string, Project> {
  const byCommon = new Map<string, Project>();
  const projectsBySlug = new Map(cache.projects.map((p) => [p.slug, p]));
  for (const c of cache.checkouts) {
    const p = projectsBySlug.get(c.slug);
    if (p) byCommon.set(c.gitCommonDir, p);
  }
  for (const p of cache.projects) if (!p.error) byCommon.set(p.gitCommonDir, p);
  return byCommon;
}

/** Working folders runs and grills can live in: project roots, their worktrees, herdr's worktrees. */
function candidateDirs(cache: ProjectCache, byCommon: Map<string, Project>): Set<string> {
  const dirs = new Set<string>();
  const roots = [...cache.checkouts.map((c) => c.root), ...cache.projects.map((p) => p.root)];
  for (const root of new Set(roots)) {
    dirs.add(root);
    for (const w of listDir(join(root, ".herdr", "worktrees")))
      dirs.add(join(root, ".herdr", "worktrees", w));
  }
  for (const common of byCommon.keys()) for (const w of worktreesOf(common)) dirs.add(w);
  const herdrRoot = join(home(), ".herdr", "worktrees");
  for (const proj of listDir(herdrRoot))
    for (const w of listDir(join(herdrRoot, proj))) dirs.add(join(herdrRoot, proj, w));
  return dirs;
}

const grillsFile = () => join(stateDir(), "grills.json");

function grillsOf(a: {
  cache: ProjectCache;
  byCommon: Map<string, Project>;
  dirs: Iterable<string>;
  agents: Agent[] | null;
  labels: Map<string, string[]>;
  now: number;
}): Grill[] {
  const known = new Map<string, { slug: string; name: string } | null>();
  return collectGrills({
    dirs: a.dirs,
    agents: a.agents,
    labels: a.labels,
    records: readGrillRecords(grillsFile()),
    projectOf: (cwd) => {
      if (!known.has(cwd)) {
        const facts = gitFacts(cwd);
        const p = facts ? a.byCommon.get(facts.commonDir) : undefined;
        known.set(cwd, p ? { slug: p.slug, name: p.name } : null);
      }
      return known.get(cwd) ?? null;
    },
    nameOf: (slug) => a.cache.projects.find((p) => p.slug === slug)?.name ?? null,
    now: a.now,
  });
}

/** All runs on this machine: loop processes, the lock's run, folders with logs from the last 24 h. */
async function scan(
  deps: Deps,
  opts: { agents: boolean },
): Promise<{ runs: Run[]; lock: RunRecord | null; grills: Grill[] }> {
  const now = deps.now ?? Date.now();
  const [cache, procs, agents, labels] = await Promise.all([
    projectCache(deps),
    deps.procs ? Promise.resolve(deps.procs) : loopProcesses(),
    !opts.agents
      ? Promise.resolve(null)
      : deps.agents !== undefined
        ? Promise.resolve(deps.agents)
        : herdrAgents(),
    !opts.agents ? Promise.resolve(null) : (deps.labels ?? herdrLabels()),
  ]);
  const { lock, active } = opts.agents
    ? evaluateLock(cache, agents)
    : { lock: readLock(), active: !readLock()?.endedAt };
  const lockActive = !!lock && active;

  const byCommon = projectsByCommon(cache);
  // candidate folders: cheap to list, most have no recent logs
  const roots = candidateDirs(cache, byCommon);
  const dirs = new Set<string>();
  for (const p of procs) if (p.cwd) dirs.add(p.cwd);
  if (lockActive && lock) dirs.add(lock.cwd ?? lock.root);
  for (const d of roots) dirs.add(d);
  const runs: Run[] = [];
  for (const cwd of dirs) {
    const own = procs.filter((p) => p.cwd === cwd);
    const isLockDir = lockActive && !!lock && (lock.cwd ?? lock.root) === cwd;
    const mine = lock && (lock.cwd ?? lock.root) === cwd ? lock : null;
    const proc = [...own].sort((x, y) => x.start - y.start)[0];
    // a process or the board's run bound the window, else a day of logs counts
    const since = proc
      ? proc.start - 5000
      : mine && (isLockDir || Date.parse(mine.startedAt) >= now - DAY)
        ? Date.parse(mine.startedAt)
        : now - DAY;
    const logs = listLogs(cwd, since, now);
    if (!own.length && !isLockDir && !logs.length) continue;
    const facts = gitFacts(cwd);
    const project = (facts && byCommon.get(facts.commonDir)) ?? null;
    runs.push(
      buildRun({
        cwd,
        logs,
        procs: own,
        project,
        lock: mine && Date.parse(mine.startedAt) >= since - 5000 ? mine : null,
        lockActive: isLockDir,
        agents,
        since,
        now,
        prLookup: deps.prLookup ?? true,
      }),
    );
  }
  runs.sort(
    (a, b) =>
      Number(b.alive) - Number(a.alive) ||
      Number(b.status !== "ended") - Number(a.status !== "ended") ||
      (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
  );
  const grills = labels ? grillsOf({ cache, byCommon, dirs: roots, agents, labels, now }) : [];
  return { runs, lock: lockActive ? lock : null, grills };
}

// ── log tail ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Bytes of a log as text: without `offset` the last `max` bytes from a line start, with `offset` (follow)
 * the bytes from there. Ends at a line end, so the returned `offset` is where the next call continues;
 * an `offset` beyond the size (the file was rewritten) reads the tail again.
 */
export function readLogText(
  path: string,
  offset?: number,
  max = 65536,
): { text: string; offset: number; size: number } {
  const size = statSync(path).size;
  const limit = Math.min(Math.max(Math.floor(max) || 65536, 1024), 1024 * 1024);
  const tail = offset === undefined || !Number.isFinite(offset) || offset > size || offset < 0;
  let start = tail ? Math.max(0, size - limit) : Math.floor(offset);
  const len = Math.min(limit, size - start);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  let from = 0;
  if (tail && start > 0) {
    const nl = buf.indexOf(10);
    from = nl < 0 ? len : nl + 1;
  }
  let to = len;
  const lastNl = buf.lastIndexOf(10);
  // an unfinished last line comes with the next call – unless one line fills the whole window
  if (lastNl >= from) to = lastNl + 1;
  else if (len < limit) to = from;
  const text = buf
    .subarray(from, to)
    .toString("utf8")
    .replace(ANSI, "")
    .replace(/\r(?!\n)/g, "\n");
  start += to;
  return { text, offset: start, size };
}

// ── start / release ────────────────────────────────────────────────────────────────────────────────

export const AGENT_PRESETS = [
  "opus-5.5",
  "opus-5.5-high",
  "opus-5",
  "cursor-grok",
  "cursor-composer",
];
export const PROVIDERS = ["claudeCode", "cursor", "omp"];
const MODEL_RE = /^[\w.:/-]{1,80}$/;

export function validateConfig(raw: Record<string, unknown>, project: Project): RunConfig {
  const agent = String(raw.agent ?? "");
  const known = project.agents.length ? project.agents.map((a) => a.key) : AGENT_PRESETS;
  let provider: string | null = null;
  let model: string | null = null;
  if (agent === "custom") {
    provider = String(raw.provider ?? "");
    model = String(raw.model ?? "").trim();
    if (!PROVIDERS.includes(provider))
      throw new Error(`Unbekannter Anbieter „${provider}“ (${PROVIDERS.join(", ")}).`);
    if (!MODEL_RE.test(model))
      throw new Error("Modell: nur Buchstaben, Ziffern und . : / - _ (höchstens 80 Zeichen).");
  } else if (!known.includes(agent))
    throw new Error(`Unbekannter Agent „${agent}“ (${known.join(", ")}).`);
  const parallel = Number(raw.parallel);
  if (!Number.isInteger(parallel) || parallel < 1)
    throw new Error("Parallelität muss eine ganze Zahl ab 1 sein.");
  const rawBranch = typeof raw.branch === "string" ? raw.branch.trim() : "";
  if (rawBranch && (!BRANCH_RE.test(rawBranch) || rawBranch.includes("..")))
    throw new Error(`Ungültiger Ziel-Branch „${rawBranch}“.`);
  return {
    agent,
    provider,
    model,
    parallel,
    screencast: raw.screencast === true,
    deploy: raw.deploy !== false,
    branch: rawBranch && rawBranch !== project.defaultBranch ? rawBranch : null,
  };
}

/** Git branch names the run accepts as target: no spaces, no leading dash. */
const BRANCH_RE = /^[\w][\w./-]{0,119}$/;

/**
 * The line the omp session gets: the whole skill, scope = this machine's queue – or, for a project whose loop
 * doesn't know the queue yet, the queued tickets as a fixed list (`scope`: stories and stand-alone issues, one
 * batch run; what is queued later waits for the next run).
 */
export function skillPrompt(
  projectName: string,
  cfg: RunConfig,
  ticketWantsDeploy: boolean,
  scope?: number[],
): string {
  const agentArg = cfg.agent === "custom" ? `custom:${cfg.provider}:${cfg.model}` : cfg.agent;
  const umfang = scope?.length ? `${scope.join(",")} --batch` : "warteschlange";
  return [
    `/skill:lul-workr-run-sandcastle ${projectName} ${agentArg} ${cfg.parallel} ${umfang}`,
    cfg.screencast ? " --screencast" : "",
    !cfg.deploy && !ticketWantsDeploy ? " --kein-testserver" : "",
    cfg.branch ? ` --ziel-branch ${cfg.branch}` : "",
  ].join("");
}

/** `## Parent` of an issue body: the story a child belongs to. */
export function parentOf(body: string): number | null {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^##\s*Parent\s*$/i.test(l.trim()));
  if (at < 0) return null;
  for (const l of lines.slice(at + 1)) {
    if (/^##\s/.test(l.trim())) break;
    const n = l.match(/#(\d+)/);
    if (n) return Number(n[1]);
  }
  return null;
}

/** Queued issues → what the skill takes as its scope: a child's story, a stand-alone issue itself; in queue order. */
export function fixedScope(order: number[], parents: Map<number, number | null>): number[] {
  const out: number[] = [];
  for (const n of order) {
    const s = parents.get(n) ?? n;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

async function ghParents(p: Project, numbers: number[]): Promise<Map<number, number | null>> {
  const parents = new Map<number, number | null>();
  await Promise.all(
    numbers.map(async (n) => {
      const r = await run(["gh", "issue", "view", String(n), "--repo", p.slug, "--json", "body"], {
        timeoutMs: 30_000,
      });
      let body = "";
      try {
        body = r.ok ? ((JSON.parse(r.out) as { body?: string }).body ?? "") : "";
      } catch {}
      parents.set(n, parentOf(body));
    }),
  );
  return parents;
}

/** Held while a start runs: two clicks at once must not both pass the "nothing running yet" check. */
function takeStartLock(
  name = "run-start.lock",
  busy = "Ein Lauf wird gerade gestartet.",
): () => void {
  const lock = join(stateDir(), name);
  mkdirSync(stateDir(), { recursive: true });
  // a start takes at most ~1 min; older locks are left over from a crash
  if (Date.now() - mtimeOf(lock) > 180_000) rmSync(lock, { recursive: true, force: true });
  try {
    mkdirSync(lock);
  } catch {
    throw new Error(busy);
  }
  return () => rmSync(lock, { recursive: true, force: true });
}

async function ghQueued(p: Project): Promise<number[] | null> {
  const r = await run(
    [
      "gh",
      "issue",
      "list",
      "--repo",
      p.slug,
      "--state",
      "open",
      "--label",
      p.labels.queue,
      "--limit",
      "500",
      "--json",
      "number,labels",
    ],
    { timeoutMs: 30_000 },
  );
  if (!r.ok) return null;
  try {
    const list = JSON.parse(r.out) as { number: number; labels: { name: string }[] }[];
    return list
      .filter((i) => !i.labels.some((l) => l.name === p.labels.story))
      .map((i) => i.number);
  } catch {
    return null;
  }
}

async function heardSession(cwd: string, label: string, prompt: string): Promise<string> {
  const herdr = new Herdr();
  // in the background: a start from the phone must not pull the Mac's herdr to that tab
  const pane = await newChat(herdr, execHerdr, { kind: "omp", cwd, label, focus: false });
  await promptWhenReady(herdr, pane, prompt);
  return pane;
}

async function startRun(req: SandcastleRequest, deps: Deps) {
  const cache = await projectCache(deps);
  const project = projectBySlug(cache, req.slug);
  const cfg = validateConfig(req.config ?? {}, project);
  const release = takeStartLock();
  try {
    const agents = deps.agents !== undefined ? deps.agents : await herdrAgents();
    const current = evaluateLock(cache, agents);
    if (current.active && current.lock)
      throw new Error(`Auf diesem Rechner läuft schon ein Lauf (${current.lock.project}).`);
    if (project.engine !== "sandcastle")
      throw new Error(
        `Projekt ${project.name} nutzt den Motor ${project.engine}, nicht Sandcastle.`,
      );
    // a loop without queue mode (not yet „Sandcastle nachziehen“) still runs: with the queued tickets as a list
    const queueMode = await measureQueueSupport(project.root, project.defaultBranch);
    // an explicit ticket list goes to the front of the queue, in the given order
    const first = positiveInts(req.tickets);
    if (Array.isArray(req.tickets) && first.length !== req.tickets.length)
      throw new Error("tickets muss eine Liste von Issue-Nummern sein.");
    const queue = first.length
      ? writeQueue(project.gitCommonDir, {
          order: [
            ...first,
            ...readQueue(project.gitCommonDir).order.filter((n) => !first.includes(n)),
          ],
        })
      : readQueue(project.gitCommonDir);
    const labelled = await (deps.queuedIssues ?? ghQueued)(project);
    const order = labelled ? effectiveOrder(queue.order, labelled) : queue.order;
    if (!order.length) throw new Error("Die Warteschlange ist leer.");
    const wantsDeploy = order.some((n) => queue.tickets[String(n)]?.deploy);
    const scope = queueMode
      ? undefined
      : fixedScope(order, await (deps.issueParents ?? ghParents)(project, order));
    // before the session starts: its events must not predate the run
    const startedAt = new Date().toISOString();
    const pane = await (deps.startSession ?? heardSession)(
      project.root,
      `Sandcastle ${project.name}`,
      skillPrompt(project.name, cfg, wantsDeploy, scope),
    );
    const lock: RunRecord = {
      id: String(Date.parse(startedAt)),
      slug: project.slug,
      project: project.name,
      root: project.root,
      pane,
      startedAt,
      config: cfg,
      cwd: null,
      endedAt: null,
      endReason: null,
    };
    writeJson(lockFile(), lock);
    return { lock, pane };
  } finally {
    release();
  }
}

/** Frees the lock without touching the session. */
function releaseRun() {
  const lock = readLock();
  if (lock && !lock.endedAt) {
    lock.endedAt = new Date().toISOString();
    lock.endReason = "manuell freigegeben";
    writeJson(lockFile(), lock);
  }
  return { lock: null };
}

/** Stops the board's run: Ctrl-C into its omp session (aborts the running loop), then frees the lock. */
async function stopRun(deps: Deps) {
  const lock = readLock();
  if (!lock || lock.endedAt) throw new Error("Auf diesem Rechner läuft kein Lauf aus dem Board.");
  const send =
    deps.sendKeys ?? ((pane: string, keys: string[]) => new Herdr().sendKeys(pane, keys));
  await send(lock.pane, ["ctrl+c"]);
  lock.endedAt = new Date().toISOString();
  lock.endReason = "gestoppt";
  writeJson(lockFile(), lock);
  return { lock: null };
}

/** Opens an omp session grilling one ticket – at most one live grill per ticket on this machine. */
async function startGrill(req: SandcastleRequest, deps: Deps): Promise<{ grill: Grill }> {
  const cache = await projectCache(deps);
  const project = projectBySlug(cache, req.slug);
  const g = validateGrillRequest(req);
  const release = takeStartLock(
    `grill-start-${sha1(`${project.slug}#${g.n}`).slice(0, 12)}.lock`,
    `Für #${g.n} wird gerade ein Grill gestartet.`,
  );
  try {
    const now = deps.now ?? Date.now();
    const [agents, labels] = await Promise.all([
      deps.agents !== undefined ? deps.agents : herdrAgents(),
      deps.labels ?? herdrLabels(),
    ]);
    const byCommon = projectsByCommon(cache);
    const dirs = candidateDirs(cache, byCommon);
    const live = grillsOf({ cache, byCommon, dirs, agents, labels, now }).find(
      (x) =>
        x.slug === project.slug &&
        x.n === g.n &&
        (x.status === "running" || x.status === "waiting" || x.status === "idle"),
    );
    if (live)
      throw new Error(`Für #${g.n} läuft schon ein Grill (${hostname().replace(/\.local$/, "")}).`);
    const label = grillLabel(g);
    const startedAt = new Date().toISOString();
    const pane = await (deps.startSession ?? heardSession)(project.root, label, grillPrompt(g));
    recordGrill(grillsFile(), { slug: project.slug, ...g, pane, startedAt }, now);
    // herdr may not list the new pane yet: it is the grill, working
    const started: Agent = {
      pane,
      kind: "omp",
      status: "working",
      title: label,
      cwd: project.root,
      workspace: "",
    };
    const grills = grillsOf({
      cache,
      byCommon,
      dirs,
      agents: [...(agents ?? []).filter((x) => x.pane !== pane), started],
      labels: new Map([...labels, [pane, [label]]]),
      now,
    });
    const grill = grills.find((x) => x.slug === project.slug && x.n === g.n);
    if (!grill) throw new Error(`Grill für #${g.n} gestartet, aber nicht gefunden.`);
    return { grill };
  } finally {
    release();
  }
}

// ── gate entry ─────────────────────────────────────────────────────────────────────────────────────

export async function sandcastle(req: SandcastleRequest, deps: Deps = {}): Promise<unknown> {
  switch (req.op) {
    case "projects":
      return { projects: (await projectCache(deps, req.refresh === true)).projects };
    case "status": {
      const { runs, lock, grills } = await scan(deps, { agents: true });
      return { machine: { host: hostname() }, runs, lock, grills };
    }
    case "log": {
      const path = String(req.path ?? "");
      // only logs the status lists: the gate must not become a reader for arbitrary files
      const { runs } = await scan({ ...deps, prLookup: false }, { agents: false });
      const known = runs.some(
        (r) =>
          r.logs.some((l) => l.path === path) ||
          r.issues.some((i) => i.logs.some((l) => l.path === path)),
      );
      if (!known) throw new Error("Dieses Log gehört zu keinem Lauf auf diesem Rechner.");
      return readLogText(path, req.offset, req.max);
    }
    case "queue":
      return readQueue(projectBySlug(await projectCache(deps), req.slug).gitCommonDir);
    case "queue-set":
      return writeQueue(projectBySlug(await projectCache(deps), req.slug).gitCommonDir, {
        order: req.order,
        tickets: req.tickets,
      });
    case "start":
      return startRun(req, deps);
    case "grill-start":
      return startGrill(req, deps);
    case "release":
      return releaseRun();
    case "stop":
      return stopRun(deps);
    default:
      throw new Error(`Unbekannte Operation „${String(req.op ?? "")}“.`);
  }
}
