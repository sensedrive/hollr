/**
 * This machine's lul-workr projects, from `hollr gate sandcastle {"op":"projects"}` (the gate scans and caches
 * for 6 h). The gate is a process start: the answer is kept in memory and in the state dir, so a board request
 * of a fresh plugin process never waits for it; older than 10 min it is asked again in the background.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./env";
import type { Project } from "./types";

const REFRESH_MS = 10 * 60_000;

export type Gate = (command: string, stdin: unknown) => Promise<unknown>;

export class Projects {
  private memo: { at: number; projects: Project[] } | undefined;
  private pending: Promise<Project[]> | undefined;

  constructor(
    private stateDir: string,
    private gate: Gate,
    private now: () => number = Date.now,
  ) {}

  /** `refresh`: the gate re-scans the computer and the answer is awaited. */
  async list(refresh = false): Promise<Project[]> {
    if (!this.memo && !refresh) {
      try {
        this.memo = JSON.parse(readFileSync(this.file(), "utf8"));
      } catch {}
    }
    if (refresh || !this.memo) return this.ask(refresh);
    if (this.now() - this.memo.at > REFRESH_MS) void this.ask(false).catch(() => {});
    return this.memo.projects;
  }

  async get(slug: string): Promise<Project> {
    const find = (list: Project[]) => list.find((p) => p.slug === slug);
    // a project checked out since the last answer: ask once more before saying no
    const p = find(await this.list()) ?? find(await this.ask(false));
    if (!p) throw new HttpError(404, `Projekt ${slug} gibt es auf diesem Rechner nicht.`);
    if (p.error) throw new HttpError(400, p.error);
    return p;
  }

  private file() {
    return join(this.stateDir, "projects.json");
  }

  private ask(refresh: boolean): Promise<Project[]> {
    if (this.pending && !refresh) return this.pending;
    const p = (async () => {
      const data = (await this.gate("sandcastle", refresh ? { op: "projects", refresh: true } : { op: "projects" })) as {
        projects?: Project[];
      };
      if (!Array.isArray(data?.projects)) throw new HttpError(502, "hollr gate sandcastle: keine Projektliste.");
      this.memo = { at: this.now(), projects: data.projects };
      mkdirSync(this.stateDir, { recursive: true });
      const tmp = `${this.file()}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.memo));
      renameSync(tmp, this.file());
      return data.projects;
    })().finally(() => {
      if (this.pending === p) this.pending = undefined;
    });
    this.pending = p;
    return p;
  }
}
