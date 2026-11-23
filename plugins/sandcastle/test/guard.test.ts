import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriftItem } from "../src/drift";
import { HttpError } from "../src/env";
import {
  Guard,
  type GuardDeps,
  guardConfig,
  IDLE_MS,
  idleExpired,
  isBlocking,
  MAX_APPLIES,
  parseInterval,
  type Timers,
} from "../src/guard";
import { Prefs } from "../src/prefs";
import type { Project } from "../src/types";
import { NOW, project } from "./fixtures";

const label = (issue: number, l = "backend"): DriftItem => ({ kind: "label-on-gh", issue, label: l, inJira: false });
const behind: DriftItem = { kind: "state-behind", expected: "In Progress", actual: "Selected" };
const done: DriftItem = { kind: "done-candidate", expected: "Done", actual: "Testing" };

/** A world of projects whose tickets carry drift; apply() clears a ticket's drift and records the call. */
class World implements GuardDeps {
  drift = new Map<string, Map<string, DriftItem[]>>();
  applied: string[] = [];
  synced: string[] = [];
  noAccess = new Set<string>();
  failApply = new Map<string, Error>();
  failSync = new Map<string, Error>();
  list: Project[] = [];

  add(p: Project, tickets: Record<string, DriftItem[]>) {
    this.list.push(p);
    this.drift.set(p.slug, new Map(Object.entries(tickets)));
  }
  async projects() {
    return this.list;
  }
  access(p: Project) {
    if (this.noAccess.has(p.slug)) throw new HttpError(409, "jira-missing");
  }
  async sync(p: Project) {
    this.synced.push(p.slug);
    const err = this.failSync.get(p.slug);
    if (err) throw err;
  }
  async tickets(p: Project) {
    return [...(this.drift.get(p.slug) ?? new Map<string, DriftItem[]>())].map(([key, drift]) => ({ key, drift }));
  }
  async apply(p: Project, key: string) {
    this.applied.push(`${p.slug} ${key}`);
    const err = this.failApply.get(key);
    if (err) throw err;
    this.drift.get(p.slug)?.set(key, (this.drift.get(p.slug)?.get(key) ?? []).filter((d) => d.kind === "done-candidate"));
  }
}

let dir: string;
let world: World;
let timers: { fn: () => void; ms: number; cleared: boolean }[];
let now: number;

const fakeTimers: Timers = {
  set(fn, ms) {
    const t = { fn, ms, cleared: false };
    timers.push(t);
    return t;
  },
  clear(h) {
    for (const t of timers) if (t === h) t.cleared = true;
  },
};
const guard = () => new Guard(dir, new Prefs(dir), world, () => now, fakeTimers);
const pending = () => timers.filter((t) => !t.cleared);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-guard-"));
  world = new World();
  timers = [];
  now = NOW;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("guard run", () => {
  test("applies only tickets with actionable drift and logs only actionable kinds", async () => {
    world.add(project(), { "R-1": [label(10), behind, done], "R-2": [done], "R-3": [{ kind: "no-key", issue: 4 }], "R-4": [] });
    const r = await guard().run(true);
    expect(world.applied).toEqual(["o/r R-1"]);
    expect(r).toMatchObject({ projects: 1, tickets: 1, applied: 2, errors: 0, deferred: 0 });
    expect(guard().status().recent).toEqual([
      {
        at: new Date(NOW).toISOString(),
        project: "o/r",
        applied: [
          { key: "R-1", kind: "label-on-gh", issue: 10, label: "backend" },
          { key: "R-1", kind: "state-behind", to: "In Progress" },
        ],
        errors: [],
      },
    ]);
  });

  test("projects without JIRA key, with an error or without access are skipped; quiet runs log nothing", async () => {
    world.add(project({ slug: "o/a", jira: { ...project().jira, projectKey: null } }), { "A-1": [label(1)] });
    world.add(project({ slug: "o/b", error: "repo.slug fehlt" }), { "B-1": [label(1)] });
    world.add(project({ slug: "o/c" }), { "C-1": [label(1)] });
    world.add(project({ slug: "o/d" }), { "D-1": [done] });
    world.noAccess.add("o/c");
    const g = guard();
    const r = await g.run(true);
    expect(world.synced).toEqual(["o/d"]);
    expect(world.applied).toEqual([]);
    expect(r).toMatchObject({ projects: 1, tickets: 0, applied: 0 });
    expect(g.status().recent).toEqual([]);
    expect(g.status().lastRun).toBe(new Date(NOW).toISOString());
  });

  test("at most 50 applies per run, across projects; the rest goes next run", async () => {
    const many = (prefix: string, n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}-${i + 1}`, [label(i + 1)]]));
    world.add(project({ slug: "o/a" }), many("A", 40));
    world.add(project({ slug: "o/b" }), many("B", 20));
    const g = guard();
    const first = await g.run(true);
    expect(world.applied.length).toBe(MAX_APPLIES);
    expect(world.applied.at(-1)).toBe("o/b B-10");
    expect(first).toMatchObject({ tickets: 50, applied: 50, deferred: 10 });
    world.applied = [];
    const second = await g.run(true);
    expect(world.applied).toEqual(Array.from({ length: 10 }, (_, i) => `o/b B-${i + 11}`));
    expect(second).toMatchObject({ tickets: 10, deferred: 0 });
  });

  test("a project stops at its first auth or rate-limit error; other errors and projects go on", async () => {
    world.add(project({ slug: "o/a" }), { "A-1": [label(1)], "A-2": [label(2)], "A-3": [label(3)], "A-4": [label(4)] });
    world.add(project({ slug: "o/b" }), { "B-1": [behind] });
    world.add(project({ slug: "o/c" }), { "C-1": [behind] });
    world.failApply.set("A-1", new HttpError(409, "R-1 kann von hier nicht nach „Testing“ wechseln."));
    world.failApply.set("A-3", new HttpError(502, "JIRA lehnt den Zugang ab (401) – Token in Hollr prüfen."));
    world.failSync.set("o/b", new HttpError(502, "gh: HTTP 403: API rate limit exceeded for user"));
    const g = guard();
    const r = await g.run(true);
    expect(world.applied).toEqual(["o/a A-1", "o/a A-2", "o/a A-3", "o/c C-1"]);
    expect(r).toMatchObject({ projects: 3, tickets: 4, applied: 2, errors: 3 });
    const recent = g.status().recent;
    expect(recent.map((e) => [e.project, e.stopped ?? false, e.errors.length, e.applied.length])).toEqual([
      ["o/c", false, 0, 1],
      ["o/b", true, 1, 0],
      ["o/a", true, 2, 1],
    ]);
  });

  test("blocking errors: auth and rate limits, not a status code that is only an issue number", () => {
    for (const m of [
      "jira-missing",
      "JIRA lehnt den Zugang ab (403) – Token in Hollr prüfen.",
      "JIRA 429: Rate limit exceeded",
      "gh: HTTP 401: Bad credentials",
      "GitHub: You have exceeded a secondary rate limit",
      "gh: To get started with GitHub CLI, please run:  gh auth login",
    ])
      expect(isBlocking(m)).toBe(true);
    for (const m of ["Issue #401 nicht gefunden.", "JIRA 400: Feld fehlt", "R-1 kann von hier nicht nach „Done“ wechseln."])
      expect(isBlocking(m)).toBe(false);
  });

  test("the log keeps the last 50 project runs in guard.json across processes", async () => {
    world.add(project(), { "R-1": [label(1)] });
    const g = guard();
    for (let i = 0; i < 55; i++) {
      world.drift.get("o/r")?.set("R-1", [label(1)]);
      now = NOW + i * 60_000;
      await g.run(true);
    }
    const stored = JSON.parse(readFileSync(join(dir, "guard.json"), "utf8"));
    expect(stored.runs.length).toBe(50);
    expect(stored.lastRun).toBe(new Date(NOW + 54 * 60_000).toISOString());
    expect(guard().status().recent[0]?.at).toBe(stored.lastRun);
  });
});

describe("guard schedule", () => {
  test("enabling schedules a run every interval; a timer run reschedules itself; disabling clears it", async () => {
    world.add(project(), { "R-1": [label(1)] });
    const g = guard();
    g.start();
    expect(timers).toEqual([]);
    g.update({ enabled: true });
    expect(pending().map((t) => t.ms)).toEqual([5 * 60_000]);
    g.update({ intervalMin: 3 });
    expect(pending().map((t) => t.ms)).toEqual([3 * 60_000]);
    now += 3 * 60_000;
    const due = pending()[0];
    if (due) {
      due.cleared = true; // fired: gone, like a real timeout
      due.fn();
    }
    expect(g.status().running).toBe(true);
    await g.run();
    expect(world.applied).toEqual(["o/r R-1"]);
    expect(g.status()).toMatchObject({ running: false, nextRun: new Date(now + 3 * 60_000).toISOString() });
    expect(pending().length).toBe(1);
    g.update({ enabled: false });
    expect(pending()).toEqual([]);
    expect(g.status().nextRun).toBeNull();
  });

  test("a new process picks the schedule up from prefs and guard.json", () => {
    guard().update({ enabled: true, intervalMin: 10 });
    timers = [];
    now += 4 * 60_000;
    const g = guard();
    expect(g.enabled).toBe(true);
    g.start();
    expect(pending().map((t) => t.ms)).toEqual([6 * 60_000]);
  });

  test("switched off during a timer run: the remaining tickets wait", async () => {
    world.add(project(), { "R-1": [label(1)], "R-2": [label(2)] });
    const g = guard();
    g.update({ enabled: true });
    const apply = world.apply.bind(world);
    world.apply = async (p, key) => {
      await apply(p, key);
      g.update({ enabled: false });
    };
    await g.run(false);
    expect(world.applied).toEqual(["o/r R-1"]);
    expect(g.status().nextRun).toBeNull();
  });
});

describe("guard settings", () => {
  test("interval bounds", () => {
    expect(parseInterval(2)).toBe(2);
    expect(parseInterval(60)).toBe(60);
    for (const v of [1, 61, 2.5, "5", null]) expect(() => parseInterval(v)).toThrow("zwischen 2 und 60");
    expect(guardConfig(undefined)).toEqual({ enabled: false, intervalMin: 5 });
    expect(guardConfig({ enabled: true, intervalMin: 90 })).toEqual({ enabled: true, intervalMin: 5 });
    expect(guardConfig({ enabled: "ja", intervalMin: 2 })).toEqual({ enabled: false, intervalMin: 2 });
  });

  test("idle exit: off while the guard is enabled, back when it is disabled", () => {
    const last = NOW - IDLE_MS - 1;
    expect(idleExpired(NOW - IDLE_MS + 1000, NOW, false)).toBe(false);
    expect(idleExpired(last, NOW, false)).toBe(true);
    const g = guard();
    g.update({ enabled: true });
    expect(idleExpired(last, NOW, g.enabled)).toBe(false);
    g.update({ enabled: false });
    expect(idleExpired(last, NOW, g.enabled)).toBe(true);
  });
});
