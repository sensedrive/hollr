import { describe, expect, test } from "bun:test";
import { chipText, dependsOn, flowStage, laneChips, moveChip, runProgress, stageLine, stageOf, ticketPhase, toFront } from "./dock";
import type { Flow, Phase } from "./types";

const tickets: Record<number, string> = { 11: "T-1", 12: "T-2", 13: "T-2", 14: "T-3", 15: "T-4" };
const phases: Record<number, Phase> = { 11: "merged", 12: "merged", 13: "reviewing" };
const chips = laneChips([11, 12, 14, 13, 15, 99], (n) => tickets[n], (n) => phases[n]);

describe("dock", () => {
  test("one chip per ticket at its first issue; issues without ticket stand alone", () => {
    expect(chips.map((c) => [c.key, c.children, c.phase])).toEqual([
      ["T-1", [11], "merged"],
      ["T-2", [12, 13], "reviewing"],
      ["T-3", [14], "queued"],
      ["T-4", [15], "queued"],
      ["#99", [99], "queued"],
    ]);
  });

  test("ticket phase: busiest child, merged only when all are; stages", () => {
    expect(ticketPhase(["merged", "queued"])).toBe("queued");
    expect(ticketPhase(["queued", "building", "failed"])).toBe("building");
    expect(ticketPhase(["merged", "merged"])).toBe("merged");
    expect([stageOf("queued"), stageOf("planned"), stageOf("reviewing"), stageOf("merged")]).toEqual([-1, 0, 2, 4]);
  });

  test("progress: place of the furthest ticket the run reached", () => {
    expect(runProgress(chips)).toEqual({ at: 2, total: 5 });
    expect(runProgress(laneChips([14, 15], (n) => tickets[n], (n) => phases[n]))).toEqual({ at: 1, total: 2 });
    expect(runProgress([])).toEqual({ at: 0, total: 0 });
  });

  test("moving: only among waiting tickets, whole tickets", () => {
    expect(moveChip(chips, "T-4", -1)).toEqual([11, 12, 13, 15, 14, 99]);
    expect(moveChip(chips, "T-3", -1)).toBeNull();
    expect(moveChip(chips, "#99", 1)).toBeNull();
    expect(moveChip(chips, "T-2", 1)).toBeNull();
  });

  test("to the front: before the first waiting ticket, behind what the run works on", () => {
    expect(toFront(chips, "#99")).toEqual([11, 12, 13, 99, 14, 15]);
    expect(toFront(chips, "T-3")).toBeNull();
    expect(toFront(chips, "T-2")).toBeNull();
    expect(toFront(chips, "T-9")).toBeNull();
  });

  test("dependencies inside the lane", () => {
    const chip = chips[2];
    if (!chip) throw new Error("missing");
    expect(dependsOn(chips, chip, (n) => (n === 14 ? [13, 500] : []))).toEqual(["T-2"]);
  });
});

describe("dock with a batch flow", () => {
  const stage = (s: string, state: Flow["stages"][number]["state"]) => ({ stage: s, state, startedAt: null, endedAt: null, reason: null, data: {} });
  const assignment = (id: number, more: Partial<Flow["assignments"][number]> = {}): Flow["assignments"][number] => ({
    id,
    title: null,
    branch: null,
    role: null,
    result: "running",
    by: null,
    reason: null,
    reviewed: false,
    commits: 0,
    ...more,
  });
  const flow = (more: Partial<Flow>): Flow => ({
    kind: "batch",
    id: "f",
    project: null,
    ticket: null,
    branch: null,
    worktree: null,
    startedAt: "",
    updatedAt: "",
    endedAt: null,
    outcome: null,
    stages: [stage("worktree", "ok"), stage("sandcastle", "running"), stage("checks", "pending"), stage("pr", "pending"), stage("deploy", "pending"), stage("testplan", "pending")],
    current: "sandcastle",
    pass: null,
    iteration: null,
    active: [],
    assignments: [],
    paused: null,
    ...more,
  });

  test("steps from roles and results: planner, implementer, reviewer, merger, merged", () => {
    const f = flow({
      active: [{ role: "merger", assignment: null }],
      assignments: [
        assignment(1, { role: "implementer" }),
        assignment(2, { role: "reviewer" }),
        assignment(3, { role: "merger", reviewed: true }),
        assignment(4, { result: "merged" }),
        assignment(5, { result: "rejected", by: "reviewer" }),
        assignment(6, { commits: 2 }),
        assignment(7),
      ],
    });
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => flowStage(f, n))).toEqual([1, 2, 3, 4, undefined, 2, 1, undefined]);
    // a queued issue sits at the planner while it plans
    expect(flowStage(flow({ active: [{ role: "planner", assignment: null }] }), 8)).toBe(0);
  });

  test("chips take the busiest unfinished step of their issues; the planner and the merger say so", () => {
    const f = flow({ assignments: [assignment(11, { result: "merged" }), assignment(13, { role: "merger", reviewed: true })] });
    const ph: Record<number, Phase> = { 11: "merged", 13: "reviewing" };
    const c = laneChips([11, 12, 13, 14], (n) => tickets[n], (n) => ph[n], (n) => flowStage(f, n));
    expect(c.map((x) => [x.key, x.stage, chipText(x)])).toEqual([
      ["T-1", 4, "✓ gemergt"],
      ["T-2", 3, "🔒 Merge läuft"],
      ["T-3", -1, "⏱ wartet"],
    ]);
    const planning = flow({ active: [{ role: "planner", assignment: null }] });
    const p = laneChips([14], (n) => tickets[n], () => undefined, (n) => flowStage(planning, n));
    expect(p.map((x) => [x.stage, chipText(x)])).toEqual([[0, "🔒 Planer läuft"]]);
  });

  test("stage line: marks per state, the current one highlighted", () => {
    expect(stageLine(flow({})).map((s) => [s.text, s.current])).toEqual([
      ["Worktree ✓", false],
      ["Sandcastle ●", true],
      ["Prüfungen", false],
      ["PR", false],
      ["Testserver", false],
      ["Testanweisung", false],
    ]);
  });
});
