import { describe, expect, test } from "bun:test";
import {
  adoption,
  assignLanes,
  branchColour,
  classify,
  doubles,
  effectiveOrder,
  laneSummary,
  normaliseFlags,
  placeBefore,
  segments,
  shortBranch,
  ticketRuns,
  unionOrder,
} from "./model";
import type { Phase, Run, RunIssue, Status } from "./types";

const labels = { queue: "Sandcastle", story: "story", grill: "grillen", ready: null, ciFailed: null, nogo: null, workflow: [] };

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
  test("a ticket a live run works on stays in that machine's lane, first, even if another queue file names it", () => {
    const lanes = assignLanes(
      [1, 2, 3, 9],
      [
        { server: "mbp", order: [9, 3] },
        { server: "workr", order: [2] },
      ],
      new Map([
        [9, "workr"],
        [1, "workr"],
      ]),
    );
    expect(lanes.get("workr")).toEqual([9, 1, 2]);
    expect(lanes.get("mbp")).toEqual([3]);
  });
  test("lane summary: queued (incl. blocked) vs. phases of picked tickets", () => {
    const phase: Record<number, Phase> = { 1: "building", 2: "reviewing", 3: "building", 4: "queued", 7: "failed" };
    const s = laneSummary([1, 2, 3, 4, 5, 6, 7], (n) => phase[n], (n) => n === 5);
    expect(s).toEqual({ total: 7, queued: 3, blocked: 1, phases: { building: 2, reviewing: 1, failed: 1 } });
  });
  test("no lanes → empty", () => expect(assignLanes([1], []).size).toBe(0));
  test("placeBefore: start, middle, end, self, new", () => {
    expect(placeBefore([1, 2, 3], 3, 1)).toEqual([3, 1, 2]);
    expect(placeBefore([1, 2, 3], 1, 3)).toEqual([2, 1, 3]);
    expect(placeBefore([1, 2, 3], 1, null)).toEqual([2, 3, 1]);
    expect(placeBefore([1, 2, 3], 2, 2)).toEqual([1, 3, 2]);
    expect(placeBefore([1, 2], 9, 2)).toEqual([1, 9, 2]);
  });
  test("an unnamed ticket shows in the first online lane", () => {
    const lanes = assignLanes([4], [
      { server: "mbp", order: [], online: false },
      { server: "workr", order: [] },
    ]);
    expect(lanes.get("workr")).toEqual([4]);
    expect(lanes.get("mbp")).toEqual([]);
  });
});

describe("lane membership", () => {
  const lane = (server: string, order: number[] | null, over: { online?: boolean; fresh?: boolean } = {}) => ({
    server,
    order,
    online: over.online ?? true,
    fresh: over.fresh ?? true,
  });
  test("queued tickets in no file go to the first online lane, ascending, where the board shows them", () => {
    const lanes = [lane("mbp", [3], { online: false }), lane("workr", [2]), lane("buzz", [])];
    expect(adoption([9, 2, 3, 4], lanes, new Map())).toEqual({ server: "workr", add: [4, 9] });
    const shown = assignLanes([9, 2, 3, 4], lanes.map((l) => ({ server: l.server, order: l.order ?? [], online: l.online })));
    expect(shown.get("workr")).toEqual([2, 4, 9]);
  });
  test("never into a second lane: a ticket any file names (an offline machine's cached one too) stays where it is", () => {
    const lanes = [lane("mbp", []), lane("workr", [5], { online: false, fresh: false })];
    expect(adoption([5], lanes, new Map())).toBeNull();
    expect(adoption([5, 6], lanes, new Map())).toEqual({ server: "mbp", add: [6] });
  });
  test("pinned (a live run has it) and nothing missing → nothing to write", () => {
    expect(adoption([7], [lane("mbp", [])], new Map([[7, "workr"]]))).toBeNull();
    expect(adoption([1], [lane("mbp", [1])], new Map())).toBeNull();
  });
  test("not while a file could still name it: never read, or an online machine not asked in this page", () => {
    expect(adoption([8], [lane("mbp", []), lane("workr", null, { online: false, fresh: false })], new Map())).toBeNull();
    expect(adoption([8], [lane("mbp", []), lane("workr", [], { fresh: false })], new Map())).toBeNull();
    expect(adoption([8], [lane("mbp", [], { online: false })], new Map())).toBeNull();
    expect(adoption([8], [], new Map())).toBeNull();
  });
  test("union merge: what the file has stays in its order, added numbers it lacks go to the end", () => {
    expect(unionOrder([5, 3], [3, 9, 7, 9])).toEqual([5, 3, 9, 7]);
    expect(unionOrder([], [4])).toEqual([4]);
  });
  test("adopted twice at once: the lane whose host sorts first keeps it, whichever board decides", () => {
    const files = [
      { server: "a", host: "martins-mbp", order: [1, 4] },
      { server: "b", host: "buzz", order: [4, 2] },
      { server: "c", host: "zeta", order: [4] },
    ];
    const drop = doubles([4, 2], files);
    expect(drop).toEqual(new Map([["a", [4]], ["c", [4]]]));
    expect(doubles([4], [...files].reverse())).toEqual(drop);
    expect(doubles([1], files).size).toBe(0);
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
  config: { agent: null, agentLabel: null, model: null, parallel: 1, scope: null, test: null },
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
