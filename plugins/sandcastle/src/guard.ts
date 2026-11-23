/**
 * The „Wächter“: keeps GitHub in line with JIRA while nobody looks at the board. When enabled (prefs key
 * `guard`), every interval it fetches what changed on JIRA and GitHub for each project with a JIRA project key
 * and JIRA access, then applies the actionable drift (label-on-gh, state-behind) ticket by ticket through the
 * same code as /api/drift/apply – at most 50 applies per run, the rest next run; a project stops at its first
 * auth or rate-limit error. Info kinds are never touched. The run log lives in memory and in guard.json.
 * While enabled the plugin process does not end itself after 2 h without a request (idleExpired).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DriftItem, type DriftKind, INFO_KINDS } from "./drift";
import { HttpError } from "./env";
import { applyDrift, type JiraCtx, jiraBoard, type TicketOut } from "./jiraboard";
import type { Prefs } from "./prefs";
import type { Projects } from "./projects";
import type { Project } from "./types";

export const IDLE_MS = 2 * 3600_000;
export const DEFAULT_INTERVAL_MIN = 5;
export const MIN_INTERVAL_MIN = 2;
export const MAX_INTERVAL_MIN = 60;
export const MAX_APPLIES = 50;
const MAX_RUNS = 50;
/** a run due while the process was down waits this long after start */
const START_DELAY_MS = 10_000;

/** Whether the process should end: no request for `limit` and no enabled guard keeping it alive. */
export function idleExpired(lastRequest: number, now: number, guardEnabled: boolean, limit = IDLE_MS): boolean {
  return !guardEnabled && now - lastRequest > limit;
}

export interface GuardConfig {
  enabled: boolean;
  intervalMin: number;
}

/** The stored prefs value as config; anything missing or out of range falls back to the defaults. */
export function guardConfig(raw: unknown): GuardConfig {
  const r: Record<string, unknown> = raw && typeof raw === "object" ? Object.fromEntries(Object.entries(raw)) : {};
  const n = r.intervalMin;
  const ok = typeof n === "number" && Number.isInteger(n) && n >= MIN_INTERVAL_MIN && n <= MAX_INTERVAL_MIN;
  return { enabled: r.enabled === true, intervalMin: ok ? n : DEFAULT_INTERVAL_MIN };
}

/** A requested interval in minutes; 400 outside 2–60 or not a whole number. */
export function parseInterval(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_INTERVAL_MIN || v > MAX_INTERVAL_MIN)
    throw new HttpError(400, `Das Intervall muss eine ganze Zahl zwischen ${MIN_INTERVAL_MIN} und ${MAX_INTERVAL_MIN} Minuten sein.`);
  return v;
}

/** Auth or rate-limit errors of JIRA and GitHub: further calls of the project would fail the same way. */
const BLOCKING =
  /jira-missing|lehnt den Zugang ab|(?:HTTP|JIRA|status)\s*(?:401|403|429)\b|rate limit|abuse detection|bad credentials|gh auth login/i;
export const isBlocking = (message: string) => BLOCKING.test(message);

export interface AppliedItem {
  key: string;
  kind: Exclude<DriftKind, "done-candidate" | "no-key">;
  /** label-on-gh: the GitHub issue and label */
  issue?: number;
  label?: string;
  /** state-behind: the JIRA state moved to */
  to?: string;
}

export interface RunEntry {
  at: string;
  /** repo slug; "*" for errors before any project */
  project: string;
  applied: AppliedItem[];
  errors: { key?: string; message: string }[];
  /** stopped at an auth or rate-limit error */
  stopped?: boolean;
}

export interface RunResult {
  at: string;
  finishedAt: string;
  manual: boolean;
  /** projects checked */
  projects: number;
  /** tickets applied (each counts against the 50 per run) */
  tickets: number;
  /** drift items applied */
  applied: number;
  errors: number;
  /** tickets left for the next run (cap) */
  deferred: number;
}

export interface GuardStatus extends GuardConfig {
  lastRun: string | null;
  nextRun: string | null;
  running: boolean;
  lastResult: RunResult | null;
  /** project runs with something applied or failed, newest first */
  recent: RunEntry[];
}

interface Stored {
  lastRun: string | null;
  nextRun: string | null;
  lastResult: RunResult | null;
  runs: RunEntry[];
}

/** What a run needs from the world; guardDeps() is the real one, tests pass fakes. */
export interface GuardDeps {
  projects(): Promise<Project[]>;
  /** throws when there is no JIRA access for the project */
  access(p: Project): void;
  /** fetches the changes on JIRA and GitHub (incremental) and waits for them */
  sync(p: Project): Promise<void>;
  /** tickets with their drift, from the synced caches */
  tickets(p: Project): Promise<{ key: string; drift: DriftItem[] }[]>;
  /** applies a ticket's drift like /api/drift/apply */
  apply(p: Project, key: string): Promise<void>;
}

export function guardDeps(ctx: JiraCtx & { projects: Projects }): GuardDeps {
  return {
    projects: () => ctx.projects.list(),
    access: (p) => void ctx.jira.client(p),
    async sync(p) {
      if (!p.jira.projectKey) return;
      // the live phases are asked in the background; this starts it early for the drift rules
      ctx.live.phases(p.slug);
      await Promise.all([ctx.tickets.sync(p.jira.projectKey, p.jira.states), ctx.boards.sync(p.slug)]);
    },
    async tickets(p) {
      const answer = await jiraBoard(ctx, p, null, false);
      return "tickets" in answer && Array.isArray(answer.tickets) ? (answer.tickets as TicketOut[]) : [];
    },
    apply: async (p, key) => void (await applyDrift(ctx, p, key)),
  };
}

/** The actionable drift of a ticket as log items. */
function actionable(key: string, drift: DriftItem[]): AppliedItem[] {
  const out: AppliedItem[] = [];
  for (const d of drift) {
    if (INFO_KINDS[d.kind]) continue;
    if (d.kind === "label-on-gh") out.push({ key, kind: d.kind, issue: d.issue, label: d.label });
    else if (d.kind === "state-behind") out.push({ key, kind: d.kind, to: d.expected });
  }
  return out;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Guard {
  private cfg: GuardConfig;
  private state: Stored;
  private timer: unknown;
  private running: Promise<RunResult> | undefined;
  private readonly file: string;

  constructor(
    private readonly stateDir: string,
    private readonly prefs: Prefs,
    private readonly deps: GuardDeps,
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = realTimers,
  ) {
    this.file = join(stateDir, "guard.json");
    this.cfg = guardConfig(prefs.get().guard);
    this.state = load(this.file);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Schedules the first run when enabled: when it was due, else 10 s after start for one missed meanwhile. */
  start(): void {
    if (!this.cfg.enabled) return;
    const due = this.state.nextRun ? Date.parse(this.state.nextRun) : Number.NaN;
    const max = this.cfg.intervalMin * 60_000;
    const delay = Number.isNaN(due) ? max : Math.min(max, Math.max(START_DELAY_MS, due - this.now()));
    this.schedule(delay);
  }

  /** Clears the timer (the process ends, or a test does). */
  stop(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  status(): GuardStatus {
    return {
      ...this.cfg,
      lastRun: this.state.lastRun,
      nextRun: this.state.nextRun,
      running: !!this.running,
      lastResult: this.state.lastResult,
      recent: this.state.runs,
    };
  }

  /** `POST /api/guard`: switches, sets the interval (re-scheduling from now), starts a run in the background. */
  update(patch: Record<string, unknown>): GuardStatus {
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean")
      throw new HttpError(400, "„enabled“ muss wahr oder falsch sein.");
    if (patch.runNow !== undefined && typeof patch.runNow !== "boolean")
      throw new HttpError(400, "„runNow“ muss wahr oder falsch sein.");
    const next: GuardConfig = {
      enabled: patch.enabled ?? this.cfg.enabled,
      intervalMin: patch.intervalMin === undefined ? this.cfg.intervalMin : parseInterval(patch.intervalMin),
    };
    if (next.enabled !== this.cfg.enabled || next.intervalMin !== this.cfg.intervalMin) {
      this.prefs.patch({ guard: next });
      this.cfg = next;
      console.log(`Wächter ${next.enabled ? `an, alle ${next.intervalMin} min` : "aus"}.`);
      if (next.enabled) this.schedule(next.intervalMin * 60_000);
      else this.unschedule();
    }
    if (patch.runNow) void this.run(true);
    return this.status();
  }

  /** One run now (the one already running, if any); a timer run reschedules itself afterwards. */
  run(manual = false): Promise<RunResult> {
    this.running ??= this.execute(manual)
      .catch((err): RunResult => {
        // execute() catches per project; this is a bug, logged, and the timer goes on
        console.error("Wächter-Lauf fehlgeschlagen:", err);
        const at = new Date(this.now()).toISOString();
        return { at, finishedAt: at, manual, projects: 0, tickets: 0, applied: 0, errors: 1, deferred: 0 };
      })
      .finally(() => {
        this.running = undefined;
        if (this.cfg.enabled) this.schedule(this.cfg.intervalMin * 60_000);
      });
    return this.running;
  }

  // ---------------------------------------------------------------- internals

  private schedule(ms: number) {
    this.stop();
    this.state.nextRun = new Date(this.now() + ms).toISOString();
    this.save();
    // a run in progress schedules the next one when it ends
    if (this.running) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.run(false);
    }, ms);
  }

  private unschedule() {
    this.stop();
    this.state.nextRun = null;
    this.save();
  }

  private async execute(manual: boolean): Promise<RunResult> {
    const at = new Date(this.now()).toISOString();
    const entries: RunEntry[] = [];
    let budget = MAX_APPLIES;
    let projects = 0;
    let deferred = 0;
    let list: Project[] = [];
    try {
      list = await this.deps.projects();
    } catch (err) {
      entries.push({ at, project: "*", applied: [], errors: [{ message: message(err) }] });
    }
    for (const p of list) {
      if (p.error || !p.jira.projectKey) continue;
      try {
        this.deps.access(p);
      } catch {
        continue;
      }
      projects++;
      const entry: RunEntry = { at, project: p.slug, applied: [], errors: [] };
      try {
        await this.deps.sync(p);
        for (const t of await this.deps.tickets(p)) {
          const items = actionable(t.key, t.drift);
          if (!items.length) continue;
          // switched off meanwhile: a timer run ends here, a manual one was asked for explicitly
          if (!manual && !this.cfg.enabled) break;
          if (budget === 0) {
            deferred++;
            continue;
          }
          budget--;
          try {
            await this.deps.apply(p, t.key);
            entry.applied.push(...items);
          } catch (err) {
            entry.errors.push({ key: t.key, message: message(err) });
            if (isBlocking(message(err))) {
              entry.stopped = true;
              break;
            }
          }
        }
      } catch (err) {
        entry.errors.push({ message: message(err) });
        if (isBlocking(message(err))) entry.stopped = true;
      }
      if (entry.applied.length || entry.errors.length) entries.push(entry);
    }
    const result: RunResult = {
      at,
      finishedAt: new Date(this.now()).toISOString(),
      manual,
      projects,
      tickets: MAX_APPLIES - budget,
      applied: entries.reduce((n, e) => n + e.applied.length, 0),
      errors: entries.reduce((n, e) => n + e.errors.length, 0),
      deferred,
    };
    this.state.lastRun = at;
    this.state.lastResult = result;
    this.state.runs = [...entries.reverse(), ...this.state.runs].slice(0, MAX_RUNS);
    this.save();
    if (result.applied || result.errors || result.deferred)
      console.log(
        `Wächter: ${result.applied} Abweichung(en) in ${result.tickets} Ticket(s) behoben, ${result.errors} Fehler, ${result.deferred} vertagt.`,
      );
    return result;
  }

  private save() {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error("guard.json nicht gespeichert:", err);
    }
  }
}

function load(file: string): Stored {
  const empty: Stored = { lastRun: null, nextRun: null, lastResult: null, runs: [] };
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>;
    return {
      lastRun: typeof data.lastRun === "string" ? data.lastRun : null,
      nextRun: typeof data.nextRun === "string" ? data.nextRun : null,
      lastResult: data.lastResult && typeof data.lastResult === "object" ? data.lastResult : null,
      runs: Array.isArray(data.runs) ? data.runs.slice(0, MAX_RUNS) : [],
    };
  } catch {
    return empty;
  }
}
