/**
 * Usage history (beta): the watcher records the provider limits and how long agents work on this
 * machine, so the apps can chart consumption over time.
 *   usage-history.jsonl  {at, limits:[{p,a,l,w,u,r}]}   – when a value moved, at least hourly
 *   activity.jsonl       {at, host, work:{omp: s, …}} – agent working seconds per hour
 * Kept for 30 days in ~/.local/state/hollr.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export interface LimitRow {
  provider: string;
  account?: string;
  label: string;
  window: string;
  used: number;
  resetsAt?: number;
}

interface CompactLimit {
  p: string;
  a?: string;
  l: string;
  w: string;
  u: number;
  r?: number;
}

export interface UsageSample {
  at: number;
  limits: CompactLimit[];
}

export interface ActivityBucket {
  at: number;
  host: string;
  work: Record<string, number>;
}

const KEEP_MS = 30 * 86_400_000;
const HOUR = 3_600_000;

const dir = () => Bun.env.HOLLR_STATE_DIR ?? join(homedir(), ".local", "state", "hollr");
const usageFile = () => join(dir(), "usage-history.jsonl");
const activityFile = () => join(dir(), "activity.jsonl");
/** the running hour, rewritten every minute so the apps see it before the hour is over */
const currentFile = () => join(dir(), "activity-current.json");

/** One row per provider/account/limit/window – `omp usage` can report an account twice. */
export function dedupeLimits<T extends LimitRow>(limits: T[]): T[] {
  const best = new Map<string, T>();
  for (const l of limits) {
    const key = [l.provider, l.account ?? "", l.label, l.window].join("|");
    const prev = best.get(key);
    if (!prev || l.used > prev.used) best.set(key, l);
  }
  return [...best.values()];
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {}
  }
  return out;
}

function append(file: string, row: object) {
  mkdirSync(dir(), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/** Drops rows older than 30 days (rewrites the file only when something is dropped). */
export function prune(now = Date.now()) {
  for (const file of [usageFile(), activityFile()]) {
    const rows = readLines<{ at: number }>(file);
    const kept = rows.filter((r) => now - r.at < KEEP_MS);
    if (kept.length !== rows.length)
      writeFileSync(
        file,
        kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""),
      );
  }
}

export class UsageRecorder {
  private last?: { at: number; key: string };
  private bucket?: ActivityBucket;
  private lastTick = 0;
  private working: string[] = [];
  private savedAt = 0;

  /** Called with fresh limits (every ~10 min): stores them when anything moved, or hourly. */
  recordLimits(limits: LimitRow[], now = Date.now()) {
    if (!limits.length) return;
    const compact: CompactLimit[] = dedupeLimits(limits).map((l) => ({
      p: l.provider,
      ...(l.account ? { a: l.account } : {}),
      l: l.label,
      w: l.window,
      u: Math.round(l.used * 1000) / 1000,
      ...(l.resetsAt ? { r: l.resetsAt } : {}),
    }));
    const key = JSON.stringify(compact.map((c) => [c.p, c.a, c.l, c.w, c.u]));
    if (this.last && this.last.key === key && now - this.last.at < HOUR) return;
    this.last = { at: now, key };
    append(usageFile(), { at: now, limits: compact } satisfies UsageSample);
  }

  /** Called on every watcher poll with the agents that are working right now. */
  tick(working: string[], now = Date.now()) {
    const dt = this.lastTick ? Math.min(now - this.lastTick, 30_000) / 1000 : 0;
    this.lastTick = now;
    const hour = Math.floor(now / HOUR) * HOUR;
    if (this.bucket && this.bucket.at !== hour) this.flush();
    this.bucket ??= { at: hour, host: hostname(), work: {} };
    // the time since the last poll belongs to the agents that were working then
    for (const kind of this.working)
      this.bucket.work[kind] = Math.round(((this.bucket.work[kind] ?? 0) + dt) * 10) / 10;
    this.working = working;
    if (now - this.savedAt >= 60_000) {
      this.savedAt = now;
      mkdirSync(dir(), { recursive: true });
      writeFileSync(currentFile(), JSON.stringify(this.bucket));
    }
  }

  flush() {
    if (this.bucket && Object.keys(this.bucket.work).length) append(activityFile(), this.bucket);
    this.bucket = undefined;
  }

  /** The running hour, not yet written (shown live in the app). */
  current(): ActivityBucket | undefined {
    return this.bucket;
  }
}

/** For the apps: the last `days` of limit samples and agent activity on this machine. */
export function usageHistory(days = 7, now = Date.now()) {
  const since = now - Math.min(days, 30) * 86_400_000;
  const samples = readLines<UsageSample>(usageFile()).filter((s) => s.at >= since);
  // keep the payload small: at most ~500 samples, evenly thinned
  const step = Math.ceil(samples.length / 500) || 1;
  const thinned = samples.filter((_, i) => i % step === 0 || i === samples.length - 1);
  const activity = readLines<ActivityBucket>(activityFile()).filter((b) => b.at >= since);
  try {
    const current = JSON.parse(readFileSync(currentFile(), "utf8")) as ActivityBucket;
    if (current.at >= since && !activity.some((b) => b.at === current.at)) activity.push(current);
  } catch {}
  return { host: hostname(), now, samples: thinned, activity };
}
