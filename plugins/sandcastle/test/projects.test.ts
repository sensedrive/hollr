import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects } from "../src/projects";
import type { Project } from "../src/types";
import { NOW, project } from "./fixtures";

let dir: string;
let calls: unknown[];
let answer: Project[];
let now: number;
const gate = async (_command: string, stdin: unknown) => {
  calls.push(stdin);
  return { projects: answer };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-projects-"));
  calls = [];
  answer = [];
  now = NOW;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("projects cache", () => {
  test("an empty list stored by an earlier process is re-scanned instead of served for good", async () => {
    // a scan that found nothing, persisted an hour ago
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ at: NOW - 3600_000, projects: [] }));
    answer = [project()];
    const p = new Projects(dir, gate, () => now);
    expect((await p.list()).map((x) => x.slug)).toEqual(["o/r"]);
    expect(calls).toEqual([{ op: "projects", refresh: true }]);
    // the fresh list is kept: no further gate call
    expect((await p.list()).map((x) => x.slug)).toEqual(["o/r"]);
    expect(calls).toHaveLength(1);
  });

  test("still empty after a re-scan: asked again at most once a minute", async () => {
    const p = new Projects(dir, gate, () => now);
    expect(await p.list()).toEqual([]);
    expect(calls).toEqual([{ op: "projects" }]);
    now += 30_000;
    expect(await p.list()).toEqual([]);
    expect(calls).toHaveLength(1);
    now += 31_000;
    answer = [project()];
    expect((await p.list()).map((x) => x.slug)).toEqual(["o/r"]);
    expect(calls).toEqual([{ op: "projects" }, { op: "projects", refresh: true }]);
  });

  test("concurrent requests share one re-scan", async () => {
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ at: NOW - 3600_000, projects: [] }));
    answer = [project()];
    const p = new Projects(dir, gate, () => now);
    await Promise.all([p.list(), p.list(), p.list()]);
    expect(calls).toEqual([{ op: "projects", refresh: true }]);
  });
});
