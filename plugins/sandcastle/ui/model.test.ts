import { describe, expect, test } from "bun:test";
import {
  assignLanes,
  branchColour,
  classify,
  effectiveOrder,
  normaliseFlags,
  placeBefore,
  segments,
  shortBranch,
  ticketRuns,
} from "./model";
import type { Run, RunIssue, Status } from "./types";

const labels = { queue: "Sandcastle", story: "story", grill: "grillen" };

test("classify precedence", () => {
  expect(classify({ state: "open", labels: ["story", "Sandcastle"] }, labels, true)).toBe("story");
  expect(classify({ state: "closed", labels: ["Sandcastle"] }, labels, true)).toBe("done");
  expect(classify({ state: "open", labels: ["grillen", "Sandcastle"] }, labels, true)).toBe("queue");
  expect(classify({ state: "open", labels: ["grillen"] }, labels, true)).toBe("grill");
  expect(classify({ state: "open", labels: ["grillen"] }, labels, false)).toBe("backlog");
});

test("effectiveOrder: unknown and closed dropped, new ones ascending at the end", () => {
  expect(effectiveOrder([5, 3, 99, 5], [7, 3, 5, 4])).toEqual([5, 3, 4, 7]);
});

describe("lanes", () => {
  test("each ticket in the first lane naming it; unnamed ones go to the first lane", () => {
    const lanes = assignLanes([1, 2, 3, 4], [
      { server: "mbp", order: [3] },
      { server: "workr", order: [2, 1] },
    ]);
    expect(lanes.get("mbp")).toEqual([3, 4]);
    expect(lanes.get("workr")).toEqual([2, 1]);
  });
  test("no lanes → empty", () => expect(assignLanes([1], []).size).toBe(0));
  test("placeBefore: start, middle, end, self, new", () => {
    expect(placeBefore([1, 2, 3], 3, 1)).toEqual([3, 1, 2]);
    expect(placeBefore([1, 2, 3], 1, 3)).toEqual([2, 1, 3]);
    expect(placeBefore([1, 2, 3], 1, null)).toEqual([2, 3, 1]);
    expect(placeBefore([1, 2, 3], 2, 2)).toEqual([1, 3, 2]);
    expect(placeBefore([1, 2], 9, 2)).toEqual([1, 9, 2]);
  });
});

const ri = (n: number, phase: RunIssue["phase"]): RunIssue => ({ n, title: null, phase, reason: null, logs: [], flags: null });
const mkRun = (over: Partial<Run>): Run => ({
  id: "r",
  slug: "o/r",
  project: "p",
  cwd: "/x",
  branch: "feature/queue-2026-11-23-1402",
  alive: true,
  pid: 1,
  startedAt: "2026-11-23T10:00:00Z",
  endedAt: null,
  source: "hollr",
  pane: null,
  status: "running",
  config: { agent: null, agentLabel: null, model: null, parallel: 1, scope: null, screencast: null },
  issues: [],
  progress: { total: 0, merged: 0, failed: 0, active: 0, queued: 0, percent: 0 },
  pr: null,
  logs: [],
  ...over,
});

test("ticketRuns: live run beats a newer ended one; other repos ignored", () => {
  const st = (runs: Run[]): Status => ({ machine: { host: "h" }, runs, lock: null });
  const map = ticketRuns(
    new Map([
      ["a", st([mkRun({ id: "old", status: "ended", startedAt: "2026-11-23T12:00:00Z", issues: [ri(5, "failed")] })])],
      ["b", st([mkRun({ id: "live", issues: [ri(5, "building")] }), mkRun({ slug: "x/y", issues: [ri(6, "merged")] })])],
    ]),
    "o/r",
  );
  expect(map.get(5)?.run.id).toBe("live");
  expect(map.get(5)?.server).toBe("b");
  expect(map.has(6)).toBe(false);
});

test("segments finished first", () => {
  expect(segments([ri(1, "queued"), ri(2, "building"), ri(3, "merged"), ri(4, "failed")])).toEqual([
    "merged",
    "failed",
    "building",
    "queued",
  ]);
});

test("short branch names", () => {
  expect(shortBranch("feature/queue-2026-11-23-1402")).toBe("queue-11-23-1402");
  expect(shortBranch("feature/batch-2026-11-23")).toBe("batch-11-23");
  expect(shortBranch("feature/TENDR-1069-export-als-pdf")).toBe("TENDR-1069-…");
  expect(shortBranch("main")).toBe("main");
  expect(branchColour("a")).toBe(branchColour("a"));
});

test("flags imply each other", () => {
  const none = { deploy: false, testnote: false, video: false };
  expect(normaliseFlags({ ...none, video: true }, "video")).toEqual({ deploy: true, testnote: true, video: true });
  expect(normaliseFlags({ deploy: false, testnote: true, video: true }, "deploy")).toEqual(none);
  expect(normaliseFlags({ deploy: true, testnote: false, video: true }, "testnote")).toEqual({ deploy: true, testnote: false, video: false });
});
