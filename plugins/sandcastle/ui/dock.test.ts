import { describe, expect, test } from "bun:test";
import { type ChildInfo, childLabel, childProgress, childStatus, dependsOn, laneChips, moveChip, roundLine, storySummary, ticketPhase, toFront } from "./dock";
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

  test("ticket phase: busiest child, merged only when all are", () => {
    expect(ticketPhase(["merged", "queued"])).toBe("queued");
    expect(ticketPhase(["queued", "building", "failed"])).toBe("building");
    expect(ticketPhase(["merged", "merged"])).toBe("merged");
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
  iteration: { n: 3, max: 60 },
  active: [],
  assignments: [],
  paused: null,
  ...more,
});
const kid = (n: number, status: ChildInfo["status"], more: Partial<ChildInfo> = {}): ChildInfo => ({ n, status, blockedBy: null, reason: null, ...more });

describe("child pill", () => {
  const f = flow({
    active: [
      { role: "implementer", assignment: 1 },
      { role: "reviewer", assignment: 2 },
    ],
    assignments: [
      assignment(1, { role: "implementer" }),
      assignment(2, { role: "reviewer", commits: 2 }),
      assignment(3, { reviewed: true, commits: 1 }),
      assignment(4, { result: "merged" }),
      assignment(5, { result: "rejected", by: "reviewer", reason: "Tests fehlen" }),
      assignment(6, { commits: 2 }),
    ],
  });
  const pill = (n: number, phase?: Phase, more: { blocker?: number; blind?: boolean; reason?: string } = {}) =>
    childLabel(childStatus(n, { phase, flow: f, blind: more.blind ?? false, blocker: more.blocker ?? null, reason: more.reason ?? null }));

  test("from the flow: role at work, built and reviewed waits for the round's merge", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => pill(n, "building"))).toEqual(["Implementer", "Code-Review", "wartet auf Merge", "gemergt", "fehlgeschlagen", "Code-Review"]);
    expect(childStatus(5, { phase: "building", flow: f, blind: false }).reason).toBe("Tests fehlen");
    // the merger at work: its children wait for (are in) the merge
    const merging = flow({ active: [{ role: "merger", assignment: null }], assignments: [assignment(7, { role: "merger", reviewed: true })] });
    expect(childLabel(childStatus(7, { phase: "reviewing", flow: merging, blind: false }))).toBe("wartet auf Merge");
  });

  test("without an assignment: the phase, a waiting child names its open blocker", () => {
    expect(pill(20, undefined)).toBe("wartet");
    expect(pill(20, "queued", { blocker: 3605 })).toBe("wartet auf #3605");
    expect(pill(21, "no-commits")).toBe("ohne Commits");
    expect(pill(22, "failed", { reason: "kaputt" })).toBe("fehlgeschlagen");
    expect(childStatus(22, { phase: "failed", flow: null, blind: false, reason: "kaputt" }).reason).toBe("kaputt");
    expect(pill(23, "merged")).toBe("gemergt");
    expect(childLabel(childStatus(24, { phase: "building", flow: null, blind: false }))).toBe("Implementer");
    expect(childLabel(childStatus(25, { phase: "reviewing", flow: null, blind: false }))).toBe("Code-Review");
  });

  test("blind run: every child is „ohne Angabe“, never a guess", () => {
    expect(pill(1, "building", { blind: true })).toBe("ohne Angabe");
    expect(pill(4, "merged", { blind: true })).toBe("ohne Angabe");
  });
});

describe("story summary", () => {
  test("x/y merged and the most active status: in work before merge before waiting before done", () => {
    const story = [kid(1, "merged"), kid(2, "merged"), kid(3, "merged"), kid(4, "review"), kid(5, "implementer"), kid(6, "failed"), kid(7, "blocked"), kid(8, "waiting"), kid(9, "waiting")];
    expect(storySummary(story, "building")).toEqual({ merged: 3, total: 9, count: "3/9", activity: "working", label: "2 in Arbeit" });
    const ready = story.map((k) => (k.status === "review" || k.status === "implementer" ? { ...k, status: "ready" as const } : k));
    expect(storySummary(ready, "merge")).toMatchObject({ activity: "merging", label: "im Merge" });
    expect(storySummary(ready, "building")).toMatchObject({ activity: "ready", label: "wartet auf Merge" });
    expect(storySummary([kid(1, "merged"), kid(2, "blocked"), kid(3, "waiting")], null)).toMatchObject({ count: "1/3", activity: "waiting", label: "wartet" });
    expect(storySummary([kid(1, "merged"), kid(2, "merged"), kid(3, "merged")], null)).toMatchObject({ count: "3/3", activity: "done", label: "fertig" });
    expect(storySummary([kid(1, "merged"), kid(2, "failed")], null)).toMatchObject({ activity: "failed", label: "fertig, 1 fehlgeschl." });
  });

  test("blind: „9 Kinder · ohne Angabe“", () => {
    const blind = Array.from({ length: 9 }, (_, i) => kid(i, "unknown"));
    expect(storySummary(blind, null)).toMatchObject({ count: "9 Kinder", activity: "unknown", label: "ohne Angabe" });
    expect(childProgress(blind, true)).toEqual({ text: "9 Kinder, Stand unbekannt", short: "9 Kinder · ?" });
  });

  test("run progress in children", () => {
    const all = [...Array.from({ length: 6 }, (_, i) => kid(i, "merged")), ...Array.from({ length: 12 }, (_, i) => kid(100 + i, "waiting"))];
    expect(childProgress(all, false)).toEqual({ text: "6 von 18 Kindern gemergt", short: "6/18 gemergt" });
    expect(childProgress([kid(1, "waiting")], false).text).toBe("0 von 1 Kind gemergt");
  });
});

describe("round line", () => {
  test("planner, children at work, merge – with the round and its maximum", () => {
    expect(roundLine(flow({ active: [{ role: "planner", assignment: null }] }), false, 0)).toEqual({ text: "Runde 3 von max. 60 · jetzt: Planer wählt", step: "planner", steps: true });
    expect(roundLine(flow({ active: [{ role: "implementer", assignment: 1 }] }), false, 2)).toEqual({ text: "Runde 3 von max. 60 · jetzt: 2 Kinder in Arbeit", step: "building", steps: true });
    expect(roundLine(flow({ active: [{ role: "reviewer", assignment: 1 }] }), false, 1).text).toBe("Runde 3 von max. 60 · jetzt: 1 Kind in Arbeit");
    expect(roundLine(flow({ active: [{ role: "merger", assignment: null }] }), false, 0)).toEqual({ text: "Runde 3 von max. 60 · jetzt: Merge", step: "merge", steps: true });
    expect(roundLine(flow({ iteration: { n: 1, max: null } }), false, 0).text).toBe("Runde 1");
  });

  test("after the loop: the stage the run is at, no round strip", () => {
    const done = flow({ stages: [stage("worktree", "ok"), stage("sandcastle", "ok"), stage("checks", "running")], current: "checks" });
    expect(roundLine(done, false, 0)).toEqual({ text: "Schleife fertig · jetzt: Prüfungen", step: null, steps: false });
  });

  test("blind and without a flow", () => {
    expect(roundLine(null, true, 0)).toEqual({ text: "Stand unbekannt – dieser Lauf schreibt kein Ablauf-Log", step: null, steps: false });
    expect(roundLine(null, false, 2)).toEqual({ text: "jetzt: 2 Kinder in Arbeit", step: "building", steps: false });
    expect(roundLine(null, false, 0).text).toBe("Runde unbekannt");
  });
});
