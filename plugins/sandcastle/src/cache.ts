/**
 * Boards per repo, stale-while-revalidate: answered from memory (or, in a fresh process, from the copy in the
 * state dir) at once; older than 15 s starts a refresh in the background. Refreshes are cheap – only issues and
 * pull requests updated since the last fetch, plus all open pull requests – with a full fetch every 10 min for
 * labels, users, deleted or transferred issues. Writes put GitHub's answer into the cache right away; for 2 min it
 * beats fetched copies that are older (GitHub's search index lags behind closing and reopening).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classify } from "./board";
import { HttpError } from "./env";
import { CLOSED_DAYS, type Changes, PULL_DAYS, type RepoSnapshot } from "./github";
import { closingPulls } from "./pulls";
import type { Issue, Project, Pull } from "./types";

export const STALE_MS = 15_000;
export const FULL_MS = 10 * 60_000;
const OVERRIDE_MS = 2 * 60_000;
/** our clock vs GitHub's, and updates landing while a fetch runs */
const SKEW_MS = 2 * 60_000;
const DAY = 86_400_000;
/** GitHub owner (letters, digits, dashes) / repo – also keeps the cache file name inside boards/ */
const SLUG = /^[A-Za-z0-9-]+\/[\w-][\w.-]*$/;

export interface Fetchers {
  fetchBoard(slug: string, now: number): Promise<RepoSnapshot>;
  fetchChanged(slug: string, since: string): Promise<Changes>;
}

interface Stored {
  snap: RepoSnapshot;
  /** last successful fetch (full or changes) */
  fetchedAt: number;
  fullAt: number;
}

interface Entry extends Stored {
  /** the board JSON without etag/fetchedAt/stale, for the labels it was made with */
  body?: { labelsKey: string; json: string; etag: string };
  refreshing?: Promise<void>;
  error?: string;
  overrides: Map<number, { issue: Issue; until: number }>;
}

export type BoardAnswer = { same: true } | { json: string };

export class BoardCache {
  private writes = 0;
  private saving: Promise<void> = Promise.resolve();
  private entries = new Map<string, Entry>();
  private loading = new Map<string, Promise<Entry>>();

  constructor(
    private dir: string,
    private gh: Fetchers,
    private now: () => number = Date.now,
  ) {}

  /** The board of `project`; `{same:true}` when its etag is `since`. `refresh`: wait for fresh data first. */
  async board(project: Project, since?: string | null, refresh = false): Promise<BoardAnswer> {
    const e = await this.entry(project.slug);
    // refresh=1 is the reload button: everything again, so labels and users created meanwhile show up now
    if (refresh) await this.refresh(project.slug, e, true);
    const stale = !refresh && this.revalidate(project.slug, e);
    const body = this.body(e, project);
    if (since && since === body.etag) return { same: true };
    const head = `{"etag":${JSON.stringify(body.etag)},"fetchedAt":${JSON.stringify(new Date(e.fetchedAt).toISOString())},"stale":${stale}`;
    const error = e.error ? `,"refreshError":${JSON.stringify(e.error)}` : "";
    return { json: `${head}${error},${body.json.slice(1)}` };
  }

  /** The snapshot (loading it if needed) – for writes that need label ids, repo id, the current issue. */
  async snapshot(slug: string): Promise<RepoSnapshot> {
    return (await this.entry(slug)).snap;
  }

  /** The snapshot like board() keeps it fresh (background refresh when stale, full and awaited on `refresh`). */
  async current(slug: string, refresh = false): Promise<{ snap: RepoSnapshot; stale: boolean; error?: string }> {
    const e = await this.entry(slug);
    if (refresh) await this.refresh(slug, e, true);
    const stale = !refresh && this.revalidate(slug, e);
    return { snap: e.snap, stale, error: e.error };
  }

  /** Fetches what changed since the last fetch (a full fetch when one is due) and waits for it; throws its error. */
  async sync(slug: string): Promise<void> {
    await this.refresh(slug, await this.entry(slug));
  }

  /** Takes a written issue as GitHub answered it. */
  async put(slug: string, issue: Issue): Promise<void> {
    const e = await this.entry(slug);
    e.overrides.set(issue.number, { issue, until: this.now() + OVERRIDE_MS });
    this.merge(e, [issue]);
    this.changed(slug, e);
  }

  /** Changes a cached issue locally (what GitHub's answer doesn't carry, e.g. the comment count). */
  async patch(slug: string, n: number, change: (issue: Issue) => Issue): Promise<Issue | undefined> {
    const e = await this.entry(slug);
    const old = e.snap.issues.find((i) => i.number === n);
    if (!old) return undefined;
    const issue = change(old);
    await this.put(slug, issue);
    return issue;
  }

  /** Resolves once the disk copies written so far are in place. */
  saved(): Promise<void> {
    return this.saving;
  }

  // ---------------------------------------------------------------- internals

  /** Starts a background refresh when the data is older than 15 s; answers whether it is. */
  private revalidate(slug: string, e: Entry): boolean {
    const stale = this.now() - e.fetchedAt > STALE_MS;
    if (stale) void this.refresh(slug, e).catch(() => {});
    return stale;
  }

  private file(slug: string) {
    return join(this.dir, "boards", `${slug.replace("/", "__")}.json`);
  }

  private entry(slug: string): Promise<Entry> {
    if (!SLUG.test(slug)) return Promise.reject(new HttpError(400, `Ungültiges Repo „${slug}“.`));
    const hit = this.entries.get(slug);
    if (hit) return Promise.resolve(hit);
    let p = this.loading.get(slug);
    if (!p) {
      p = this.load(slug).finally(() => this.loading.delete(slug));
      this.loading.set(slug, p);
    }
    return p;
  }

  private async load(slug: string): Promise<Entry> {
    let stored: Stored | undefined;
    try {
      stored = JSON.parse(readFileSync(this.file(slug), "utf8"));
    } catch {}
    const fromDisk = !!stored?.snap?.issues;
    if (!stored || !fromDisk) {
      const now = this.now();
      stored = { snap: await this.gh.fetchBoard(slug, now), fetchedAt: now, fullAt: now };
    } else if (!stored.snap.pulls) {
      // a copy from before pull requests: none until the next refresh, which is a full one
      stored = { ...stored, snap: { ...stored.snap, pulls: [] }, fullAt: 0 };
    }
    const e: Entry = { ...stored, overrides: new Map() };
    this.entries.set(slug, e);
    if (!fromDisk) this.persist(slug, e);
    return e;
  }

  private refresh(slug: string, e: Entry, full = false): Promise<void> {
    e.refreshing ??= (async () => {
      const now = this.now();
      try {
        if (full || now - e.fullAt > FULL_MS) {
          e.snap = await this.gh.fetchBoard(slug, now);
          e.fullAt = now;
          this.merge(e, []);
        } else {
          const c = await this.gh.fetchChanged(slug, new Date(e.fetchedAt - SKEW_MS).toISOString());
          this.merge(e, c.issues, c.pulls);
        }
        e.fetchedAt = now;
        e.error = undefined;
        this.changed(slug, e);
      } catch (err) {
        e.error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        e.refreshing = undefined;
      }
    })();
    return e.refreshing;
  }

  /**
   * Puts fetched issues in, then the still valid overrides that are newer than what was fetched. `pulls` (a
   * refresh): the open ones replace all open ones cached, merged or closed ones are put in.
   */
  private merge(e: Entry, fetched: Issue[], pulls?: Pull[]) {
    const now = this.now();
    const windowStart = now - CLOSED_DAYS * DAY - DAY;
    const byNumber = new Map(e.snap.issues.map((i) => [i.number, i]));
    for (const i of fetched) byNumber.set(i.number, i);
    for (const [n, o] of e.overrides) {
      if (o.until < now) e.overrides.delete(n);
      else if ((byNumber.get(n)?.updatedAt ?? "") < o.issue.updatedAt) byNumber.set(n, o.issue);
    }
    // closed issues leave with the window (a full fetch recounts closedOlder)
    for (const [n, i] of byNumber)
      if (i.state === "closed" && i.closedAt && Date.parse(i.closedAt) < windowStart && !e.overrides.has(n))
        byNumber.delete(n);
    const prs = new Map(e.snap.pulls.map((p) => [p.n, p]));
    if (pulls) {
      // an open PR missing from the fresh open ones was merged or closed meanwhile: it is among `pulls` too
      for (const p of e.snap.pulls) if (p.state === "open" || p.state === "draft") prs.delete(p.n);
      for (const p of pulls) prs.set(p.n, p);
    }
    // merged and closed PRs leave with their window too
    const pullStart = new Date(now - PULL_DAYS * DAY - DAY).toISOString();
    for (const [n, p] of prs) if (p.closedAt && (p.mergedAt ?? p.closedAt) < pullStart) prs.delete(n);
    e.snap = { ...e.snap, issues: [...byNumber.values()], pulls: [...prs.values()] };
  }

  private changed(slug: string, e: Entry) {
    e.body = undefined;
    this.persist(slug, e);
  }

  private body(e: Entry, project: Project): NonNullable<Entry["body"]> {
    const labelsKey = JSON.stringify(project.labels);
    if (e.body?.labelsKey === labelsKey) return e.body;
    const issues: Issue[] = [];
    const stories: { number: number; title: string }[] = [];
    for (const i of e.snap.issues) {
      if (classify(i, project.labels) === "story") stories.push({ number: i.number, title: i.title });
      else issues.push(i);
    }
    issues.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    stories.sort((a, b) => b.number - a.number);
    const json = JSON.stringify({
      issues,
      labels: e.snap.labels.map(({ name, color }) => ({ name, color })),
      assignees: e.snap.assignees,
      stories,
      hasGrill: !!project.labels.grill,
      closedOlder: e.snap.closedOlder,
      viewer: e.snap.viewer,
      pulls: closingPulls(e.snap.pulls, new Set(issues.map((i) => i.number))),
    });
    e.body = { labelsKey, json, etag: Bun.hash(json).toString(36) };
    return e.body;
  }

  /** Writes the copy for the next process; tmp + rename, not awaited by anyone. */
  private persist(slug: string, e: Entry) {
    const file = this.file(slug);
    const data: Stored = { snap: e.snap, fetchedAt: e.fetchedAt, fullAt: e.fullAt };
    const tmp = `${file}.${process.pid}.${++this.writes}.tmp`;
    mkdirSync(join(this.dir, "boards"), { recursive: true });
    // one after another, so an older copy never renames over a newer one
    this.saving = this.saving
      .then(() => writeFile(tmp, JSON.stringify(data)))
      .then(() => rename(tmp, file))
      .catch((err) => console.error(`Board-Cache ${slug} nicht gespeichert:`, err));
  }
}
