/**
 * Sandcastle runs started from the board: at most one per computer (`<stateDir>/run.json` is the lock).
 * A run is the skill lul-workr-run-sandcastle in a new omp session; its progress comes from events.jsonl.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstLine, HttpError, hollr } from "./env";
import { type Progress, parseProgress } from "./events";
import { measureQueueSupport, type Project } from "./projects";
import { queueDir } from "./queue";

export const AGENTS = ["opus-5.5", "opus-5.5-high", "opus-5", "cursor-grok", "cursor-composer", "custom"];
export const PROVIDERS = ["claudeCode", "cursor", "omp"];
const MODEL_RE = /^[\w.:/-]{1,80}$/;

export interface RunConfig {
  agent: string;
  provider: string | null;
  model: string | null;
  parallel: number;
  screencast: boolean;
}

export interface RunRecord {
  id: string;
  project: string;
  pane: string;
  startedAt: string;
  config: RunConfig;
  endedAt: string | null;
  endReason: string | null;
}

export type RunStatus = "running" | "waiting" | "loop-ended" | "ended";

export interface AgentInfo {
  pane: string;
  status: string;
}

export function validateConfig(raw: Record<string, unknown>): RunConfig {
  const agent = String(raw.agent ?? "");
  if (!AGENTS.includes(agent)) throw new Error(`Unbekannter Agent „${agent}“.`);
  let provider: string | null = null;
  let model: string | null = null;
  if (agent === "custom") {
    provider = String(raw.provider ?? "");
    model = String(raw.model ?? "").trim();
    if (!PROVIDERS.includes(provider)) throw new Error(`Unbekannter Anbieter „${provider}“ (${PROVIDERS.join(", ")}).`);
    if (!MODEL_RE.test(model)) throw new Error("Modell: nur Buchstaben, Ziffern und . : / - _ (höchstens 80 Zeichen).");
  }
  const parallel = Number(raw.parallel);
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error("Parallelität muss eine ganze Zahl ab 1 sein.");
  return { agent, provider, model, parallel, screencast: raw.screencast === true };
}

/** The line the omp session gets: the whole skill, scope = the board's queue. */
export function skillPrompt(projectName: string, cfg: RunConfig): string {
  const agentArg = cfg.agent === "custom" ? `custom:${cfg.provider}:${cfg.model}` : cfg.agent;
  return `/skill:lul-workr-run-sandcastle ${projectName} ${agentArg} ${cfg.parallel} warteschlange${cfg.screencast ? " --screencast" : ""}`;
}

function writeJson(file: string, data: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export const readRun = (stateDir: string) => readJson<RunRecord>(join(stateDir, "run.json"));
export const writeRun = (stateDir: string, run: RunRecord) => writeJson(join(stateDir, "run.json"), run);
export const loadLastConfig = (stateDir: string, projectId: string) =>
  readJson<RunConfig>(join(stateDir, `config-${projectId}.json`));

export function readProgress(project: Project, since: string): Progress {
  const file = join(queueDir(project.gitCommonDir), "events.jsonl");
  return parseProgress(existsSync(file) ? readFileSync(file, "utf8") : "", since);
}

/** herdr's agents via `hollr agents`; null when that fails (then nothing is concluded from it). */
export async function listAgents(): Promise<AgentInfo[] | null> {
  const r = await hollr(["agents"], { timeoutMs: 10_000 });
  if (!r.ok) return null;
  try {
    const list: unknown = JSON.parse(r.out);
    return Array.isArray(list)
      ? list.filter((a): a is AgentInfo => typeof a?.pane === "string" && typeof a?.status === "string")
      : null;
  } catch {
    return null;
  }
}

/** The run's state; `ended` carries what to record when it just ended (run.json is still open). */
export function status(
  run: RunRecord,
  progress: Progress,
  agents: AgentInfo[] | null,
): { status: RunStatus; ended?: { endedAt: string; endReason: string } } {
  if (run.endedAt) return { status: "ended" };
  const now = new Date().toISOString();
  if (progress.runEnd)
    return {
      status: "ended",
      ended: { endedAt: now, endReason: progress.runEnd.result === "ok" ? "fertig" : "abgebrochen" },
    };
  const agent = agents?.find((a) => a.pane === run.pane);
  if (agents && !agent) return { status: "ended", ended: { endedAt: now, endReason: "Sitzung geschlossen" } };
  if (agent?.status === "blocked") return { status: "waiting" };
  if (progress.loopEnded) return { status: "loop-ended" };
  return { status: "running" };
}

export interface CurrentRun {
  run: RunRecord;
  status: RunStatus;
  progress: Progress;
  project?: Project;
}

/** The latest run (also an ended one) with its state; records the end in run.json when it just happened. */
export async function currentRun(stateDir: string, projects: Project[]): Promise<CurrentRun | null> {
  const run = readRun(stateDir);
  if (!run) return null;
  const project = projects.find((p) => p.id === run.project);
  const progress = project
    ? readProgress(project, run.startedAt)
    : parseProgress("", run.startedAt);
  const s = status(run, progress, run.endedAt ? null : await listAgents());
  if (s.ended) {
    run.endedAt = s.ended.endedAt;
    run.endReason = s.ended.endReason;
    writeRun(stateDir, run);
  }
  return { run, status: s.status, progress, project };
}

/** Held while a run starts: two clicks at once must not both pass the "no active run" check. */
function takeStartLock(stateDir: string): () => void {
  const lock = join(stateDir, "run-start.lock");
  mkdirSync(stateDir, { recursive: true });
  try {
    // a start takes at most ~2 min (session new: 90 s); older locks are left over from a crash
    if (Date.now() - statSync(lock).mtimeMs > 180_000) rmSync(lock, { recursive: true, force: true });
  } catch {}
  try {
    mkdirSync(lock);
  } catch {
    throw new HttpError(409, "Ein Lauf wird gerade gestartet.");
  }
  return () => rmSync(lock, { recursive: true, force: true });
}

/**
 * Starts the skill in a new omp session. The active-run check runs under the start lock, so of two
 * concurrent starts only one gets through.
 */
export async function startRun(
  stateDir: string,
  project: Project,
  cfg: RunConfig,
  ctx: { projects: Project[]; queueLength: number },
): Promise<RunRecord> {
  const release = takeStartLock(stateDir);
  try {
    const active = await currentRun(stateDir, ctx.projects);
    if (active && active.status !== "ended")
      throw new HttpError(409, `Auf diesem Rechner läuft schon ein Lauf (${active.project?.name ?? active.run.project}).`);
    if (project.engine !== "sandcastle")
      throw new HttpError(400, `Projekt ${project.name} nutzt den Motor ${project.engine}, nicht Sandcastle.`);
    if (!(await measureQueueSupport(project.root, project.defaultBranch)))
      throw new HttpError(
        400,
        "Die Schleife dieses Projekts kennt die Warteschlange noch nicht (lul-workr-setup → Sandcastle nachziehen).",
      );
    if (!ctx.queueLength) throw new HttpError(400, "Die Warteschlange ist leer.");
    // before the session starts: its events must not predate the run
    const startedAt = new Date().toISOString();
    const r = await hollr(
      [
        "session", "new", "--kind", "omp", "--cwd", project.root,
        "--label", `Sandcastle ${project.name}`, "--prompt", skillPrompt(project.name, cfg),
      ],
      { timeoutMs: 90_000 },
    );
    let pane = "";
    try {
      pane = String(JSON.parse(r.out.trim().split("\n").pop() ?? "{}").pane ?? "");
    } catch {}
    if (!r.ok || !pane) throw new HttpError(502, `Sitzung startet nicht: ${firstLine(r.err || r.out)}`);
    const run: RunRecord = {
      id: String(Date.parse(startedAt)),
      project: project.id,
      pane,
      startedAt,
      config: cfg,
      endedAt: null,
      endReason: null,
    };
    writeRun(stateDir, run);
    writeJson(join(stateDir, `config-${project.id}.json`), cfg);
    return run;
  } finally {
    release();
  }
}

/** Frees the lock without touching the session. */
export function releaseRun(stateDir: string): RunRecord | null {
  const run = readRun(stateDir);
  if (!run || run.endedAt) return run;
  run.endedAt = new Date().toISOString();
  run.endReason = "manuell freigegeben";
  writeRun(stateDir, run);
  return run;
}
