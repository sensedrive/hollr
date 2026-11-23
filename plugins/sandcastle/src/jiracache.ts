/**
 * JIRA boards per project key, stale-while-revalidate like the GitHub BoardCache: answered from memory (or, in
 * a fresh process, from the copy in the state dir) at once; older than 15 s starts a background refresh of the
 * tickets updated since the last fetch, a full fetch every 10 min (statuses, tickets that left the project or
 * the done window). Writes put JIRA's answer in right away; for 2 min it beats older fetched copies.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FULL_MS, STALE_MS } from "./cache";
import { HttpError } from "./env";
import { DONE_DAYS, type JiraSnapshot, type JiraStates, type JiraTicket, PROJECT_KEY } from "./jira";

const OVERRIDE_MS = 2 * 60_000;
const DAY = 86_400_000;

export interface JiraFetchers {
  fetchBoard(projectKey: string, states: JiraStates): Promise<JiraSnapshot>;
  fetchChanged(projectKey: string, since: string): Promise<JiraTicket[]>;
}

interface Stored {
  snap: JiraSnapshot;
  /** last successful fetch (full or changes) */
  fetchedAt: number;
  fullAt: number;
}

interface Entry extends Stored {
  refreshing?: Promise<void>;
  error?: string;
  overrides: Map<string, { ticket: JiraTicket; until: number }>;
}

export interface JiraBoardState {
  snap: JiraSnapshot;
  fetchedAt: number;
  stale: boolean;
  /** the last background refresh failed (the data is the previous one) */
  error?: string;
}

export class JiraCache {
  private writes = 0;
  private saving: Promise<void> = Promise.resolve();
  private entries = new Map<string, Entry>();
  private loading = new Map<string, Promise<Entry>>();

  constructor(
    private dir: string,
    private jira: JiraFetchers,
    private now: () => number = Date.now,
  ) {}

  /** The board of `projectKey`. `refresh` (the reload button): a full fetch, awaited. */
  async board(projectKey: string, states: JiraStates, refresh = false): Promise<JiraBoardState> {
    const e = await this.entry(projectKey, states);
    if (refresh) await this.refresh(projectKey, states, e, true);
    else if (this.now() - e.fetchedAt > STALE_MS) void this.refresh(projectKey, states, e).catch(() => {});
    return { snap: e.snap, fetchedAt: e.fetchedAt, stale: this.now() - e.fetchedAt > STALE_MS, error: e.error };
  }

  /** Fetches what changed since the last fetch (a full fetch when one is due) and waits for it; throws its error. */
  async sync(projectKey: string, states: JiraStates): Promise<void> {
    await this.refresh(projectKey, states, await this.entry(projectKey, states));
  }

  /** Takes a written ticket as JIRA answered it. */
  async put(projectKey: string, states: JiraStates, ticket: JiraTicket): Promise<void> {
    const e = await this.entry(projectKey, states);
    e.overrides.set(ticket.key, { ticket, until: this.now() + OVERRIDE_MS });
    this.merge(e, [ticket]);
    this.persist(projectKey, e);
  }

  /** Resolves once the disk copies written so far are in place. */
  saved(): Promise<void> {
    return this.saving;
  }

  // ---------------------------------------------------------------- internals

  private file(projectKey: string) {
    return join(this.dir, "jira", `${projectKey}.json`);
  }

  private entry(projectKey: string, states: JiraStates): Promise<Entry> {
    if (!PROJECT_KEY.test(projectKey))
      return Promise.reject(new HttpError(400, `Ungültiger JIRA-Projektschlüssel „${projectKey}“.`));
    const hit = this.entries.get(projectKey);
    if (hit) return Promise.resolve(hit);
    let p = this.loading.get(projectKey);
    if (!p) {
      p = this.load(projectKey, states).finally(() => this.loading.delete(projectKey));
      this.loading.set(projectKey, p);
    }
    return p;
  }

  private async load(projectKey: string, states: JiraStates): Promise<Entry> {
    let stored: Stored | undefined;
    try {
      stored = JSON.parse(readFileSync(this.file(projectKey), "utf8"));
    } catch {}
    const fromDisk = !!stored?.snap?.tickets && !!stored.snap.statuses;
    if (!stored || !fromDisk) {
      const now = this.now();
      stored = { snap: await this.jira.fetchBoard(projectKey, states), fetchedAt: now, fullAt: now };
    }
    const e: Entry = { ...stored, overrides: new Map() };
    this.entries.set(projectKey, e);
    if (!fromDisk) this.persist(projectKey, e);
    return e;
  }

  private refresh(projectKey: string, states: JiraStates, e: Entry, full = false): Promise<void> {
    e.refreshing ??= (async () => {
      const now = this.now();
      try {
        if (full || now - e.fullAt > FULL_MS) {
          e.snap = await this.jira.fetchBoard(projectKey, states);
          e.fullAt = now;
          this.merge(e, []);
        } else {
          this.merge(e, await this.jira.fetchChanged(projectKey, new Date(e.fetchedAt).toISOString()));
        }
        e.fetchedAt = now;
        e.error = undefined;
        this.persist(projectKey, e);
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
   * Puts fetched tickets in (in place, new ones at the end – their rank is unknown until the next full fetch),
   * then the still valid overrides newer than what was fetched; done tickets leave with the window.
   */
  private merge(e: Entry, fetched: JiraTicket[]) {
    const now = this.now();
    const byKey = new Map(e.snap.tickets.map((t) => [t.key, t]));
    for (const t of fetched) byKey.set(t.key, t);
    for (const [key, o] of e.overrides) {
      if (o.until < now) e.overrides.delete(key);
      else if ((byKey.get(key)?.updated ?? "") <= o.ticket.updated) byKey.set(key, o.ticket);
    }
    const windowStart = now - DONE_DAYS * DAY - DAY;
    for (const [key, t] of byKey)
      if (t.category === "done" && Date.parse(t.updated) < windowStart && !e.overrides.has(key)) byKey.delete(key);
    e.snap = { ...e.snap, tickets: [...byKey.values()] };
  }

  /** Writes the copy for the next process; tmp + rename, one after another. */
  private persist(projectKey: string, e: Entry) {
    const file = this.file(projectKey);
    const data: Stored = { snap: e.snap, fetchedAt: e.fetchedAt, fullAt: e.fullAt };
    const tmp = `${file}.${process.pid}.${++this.writes}.tmp`;
    mkdirSync(join(this.dir, "jira"), { recursive: true });
    this.saving = this.saving
      .then(() => writeFile(tmp, JSON.stringify(data)))
      .then(() => rename(tmp, file))
      .catch((err) => console.error(`JIRA-Cache ${projectKey} nicht gespeichert:`, err));
  }
}
