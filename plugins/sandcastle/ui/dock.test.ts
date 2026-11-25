import { describe, expect, test } from "bun:test";
import {
  type ChildInfo,
  childLabel,
  childProgress,
  childStatus,
  dependsOn,
  laneChips,
  moveChip,
  roundKidsText,
  roundLine,
  runStories,
  shortReason,
  storySummary,
  ticketPhase,
  toFront,
  withoutKey,
} from "./dock";
import type { Flow, Phase } from "./types";

const tickets: Record<number, string> = { 11: "T-1", 12: "T-2", 13: "T-2", 14: "T-3", 15: "T-4" };
const phases: Record<number, Phase> = { 11: "merged", 12: "merged", 13: "reviewing" };
const chips = laneChips([11, 12, 14, 13, 15, 99], (n) => tickets[n], (n) => phases[n]);

// the ilims run on workr (2026-11-25): 6 stories, 12 children; round 6 has #263 and #268 in review
describe("whole-run stories", () => {
  const family: Record<string, number[]> = {
    "ILIMS-351": [244, 248],
    "ILIMS-352": [245, 256],
    "ILIMS-353": [261, 262, 263],
    "ILIMS-354": [257, 258],
    "ILIMS-355": [259, 267],
    "ILIMS-356": [268, 269],
  };
  const ticketOf = (n: number) => Object.keys(family).find((k) => family[k]?.includes(n));
  const runOrder = [244, 245, 248, 256, 257, 258, 259, 261, 262, 263, 267, 268];
  const merged = new Set([244, 245, 248, 256, 257, 258, 259, 261, 262, 267]);
  // the lane only has what is still open: #263, #268 (the run's) and #269 (queued, not picked yet)
  const lane = laneChips([263, 268, 269], ticketOf, (n) => (n === 269 ? "queued" : "reviewing"));
  const stories = runStories({ runOrder, chips: lane, ticketOf, familyOf: (k) => family[k], merged: (n) => merged.has(n) });

  test("every story of the run in its order, the finished ones too, each with all its children", () => {
    expect(stories.map((s) => [s.key, s.children, s.done])).toEqual([
      ["ILIMS-351", [244, 248], true],
      ["ILIMS-352", [245, 256], true],
      ["ILIMS-354", [257, 258], true],
      ["ILIMS-355", [259, 267], true],
      ["ILIMS-353", [261, 262, 263], false],
      ["ILIMS-356", [268, 269], false],
    ]);
    // only what still waits in the lane keeps its chip (reordering, taking out)
    expect(stories.map((s) => s.chip?.children ?? null)).toEqual([null, null, null, null, [263], [268, 269]]);
  });

  test("counts span the whole story, like the board card: ILIMS-353 is 2/3, not 0/1", () => {
    const kids = (key: string) =>
      (stories.find((s) => s.key === key)?.children ?? []).map((n) =>
        childStatus(n, { phase: merged.has(n) ? "merged" : n === 263 || n === 268 ? "reviewing" : undefined, flow: null, blind: false }),
      );
    expect(storySummary(kids("ILIMS-353"), "building")).toMatchObject({ count: "2/3", activity: "working" });
    expect(storySummary(kids("ILIMS-351"), "building")).toMatchObject({ count: "2/2", activity: "done" });
    const all = stories.flatMap((s) => kids(s.key));
    expect(childProgress(all, false).short).toBe("10/13 gemergt");
    // the round counts apart from the stories: the children this round works on
    expect(roundKidsText(all)).toBe("Diese Runde: 0/2 Kindern gemergt · #263, #268");
    expect(roundKidsText(all.filter((k) => k.status === "merged"))).toBeNull();
  });

  test("without a family the story is what the run and the lane know; a waiting story is not done", () => {
    const s = runStories({ runOrder: [5], chips: laneChips([6], () => "X-1", () => "queued"), ticketOf: () => "X-1", familyOf: () => undefined, merged: (n) => n === 5 });
    expect(s).toEqual([{ key: "X-1", children: [5, 6], chip: { key: "X-1", children: [6], phase: "queued" }, done: false }]);
    // issues without ticket stand alone; nothing in the run: never „fertig in diesem Lauf“
    expect(runStories({ runOrder: [], chips: laneChips([7], () => undefined, () => "merged"), ticketOf: () => undefined, familyOf: () => [1], merged: () => true })).toEqual([
      { key: "#7", children: [7], chip: { key: "#7", children: [7], phase: "merged" }, done: false },
    ]);
  });
});

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
const kid = (n: number, status: ChildInfo["status"], more: Partial<ChildInfo> = {}): ChildInfo => ({ n, status, blockedBy: null, note: null, reason: null, since: null, ...more });

describe("title without key", () => {
  test("drops the key a chip or story already shows, keeps everything else", () => {
    expect(withoutKey("Tabelle invoice_sequences anlegen (TENDR-1091)", "TENDR-1091")).toBe("Tabelle invoice_sequences anlegen");
    expect(withoutKey("shop_id wird NOT NULL (Folgerelease) (TENDR-817)", "TENDR-817")).toBe("shop_id wird NOT NULL (Folgerelease)");
    expect(withoutKey("TENDR-1091: Nummernkreis je Mandant", "TENDR-1091")).toBe("Nummernkreis je Mandant");
    expect(withoutKey("Export [TENDR-1091] als CSV", "TENDR-1091")).toBe("Export als CSV");
    // another ticket's key, a longer key with the same prefix, issues without ticket and no key stay
    expect(withoutKey("Folgt auf (TENDR-1075)", "TENDR-1091")).toBe("Folgt auf (TENDR-1075)");
    expect(withoutKey("Rest (TENDR-10910)", "TENDR-1091")).toBe("Rest (TENDR-10910)");
    expect(withoutKey("Nur (#12)", "#12")).toBe("Nur (#12)");
    expect(withoutKey("Titel (TENDR-1)", null)).toBe("Titel (TENDR-1)");
    expect(withoutKey("(TENDR-1091)", "TENDR-1091")).toBe("(TENDR-1091)");
  });

  test("reasons are cut at a word boundary", () => {
    expect(shortReason("kurz")).toBe("kurz");
    const long = "Release v2.3.0 — erst danach löschen, wenn alle Mandanten auf v2.3.0 laufen";
    expect(shortReason(long)).toBe("Release v2.3.0 — erst danach löschen, wenn alle …");
    expect(shortReason(long, 20)).toBe("Release v2.3.0 …");
  });
});

describe("child pill", () => {
  const f = flow({
    active: [
      { role: "implementer", assignment: 1, since: "2026-11-24T20:00:00Z" },
      { role: "reviewer", assignment: 2, since: "2026-11-24T19:52:00Z" },
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
  const pill = (n: number, phase?: Phase, more: { blocker?: number; note?: string; blind?: boolean; reason?: string } = {}) =>
    childLabel(childStatus(n, { phase, flow: f, blind: more.blind ?? false, blocker: more.blocker ?? null, note: more.note ?? null, reason: more.reason ?? null }));

  test("from the flow: role at work, built and reviewed waits for the round's merge", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => pill(n, "building"))).toEqual(["Implementer", "Code-Review", "wartet auf Merge", "gemergt", "fehlgeschlagen", "Code-Review"]);
    expect(childStatus(5, { phase: "building", flow: f, blind: false }).reason).toBe("Tests fehlen");
    // a role at work says since when; nothing else does
    expect([1, 2, 3, 6].map((n) => childStatus(n, { phase: "building", flow: f, blind: false }).since)).toEqual(["2026-11-24T20:00:00Z", "2026-11-24T19:52:00Z", null, null]);
    // the merger at work: its children wait for (are in) the merge
    const merging = flow({ active: [{ role: "merger", assignment: null }], assignments: [assignment(7, { role: "merger", reviewed: true })] });
    expect(childLabel(childStatus(7, { phase: "reviewing", flow: merging, blind: false }))).toBe("wartet auf Merge");
  });

  test("without an assignment: the phase, a waiting child names its open blocker", () => {
    expect(pill(20, undefined)).toBe("wartet");
    expect(pill(20, "queued", { blocker: 3605 })).toBe("wartet auf #3605");
    // „Blockiert von“ text without #N blocks too; an open #N wins the pill
    expect(pill(20, "queued", { note: "Release v2.3.0" })).toBe("blockiert");
    expect(childStatus(20, { phase: "queued", flow: null, blind: false, note: "Release v2.3.0" })).toMatchObject({ status: "blocked", blockedBy: null, note: "Release v2.3.0" });
    expect(childStatus(20, { phase: "queued", flow: null, blind: false, blocker: 7, note: "Release v2.3.0" })).toMatchObject({ blockedBy: 7, note: null });
    // a child the loop works on anyway is shown as what it is
    expect(pill(1, "building", { note: "Release v2.3.0" })).toBe("Implementer");
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
    expect(storySummary(story, "building")).toEqual({
      merged: 3,
      total: 9,
      count: "3/9",
      activity: "working",
      label: "Implementer #5 · Code-Review #4",
      roles: [
        { role: "implementer", numbers: [5] },
        { role: "review", numbers: [4] },
      ],
    });
    expect(storySummary([kid(7, "implementer"), kid(3, "implementer")], "building")).toMatchObject({ label: "Implementer #3, #7", roles: [{ role: "implementer", numbers: [3, 7] }] });
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
  const at = (pairs: [number, ChildInfo["status"]][]) => pairs.map(([n, s]) => kid(n, s));
  test("planner, the roles at work, merge with its children – with the round and its maximum", () => {
    expect(roundLine(flow({ active: [{ role: "planner", assignment: null }] }), false, [])).toEqual({ text: "Runde 3 von max. 60 · jetzt: Planer wählt", step: "planner", steps: true });
    const working = at([
      [3605, "implementer"],
      [3604, "review"],
      [3601, "merged"],
    ]);
    expect(roundLine(flow({ active: [{ role: "implementer", assignment: 3605 }] }), false, working)).toEqual({
      text: "Runde 3 von max. 60 · jetzt: Implementer an #3605 · Code-Review an #3604",
      step: "building",
      steps: true,
    });
    const several = at([
      [3607, "implementer"],
      [3605, "implementer"],
      [3604, "review"],
    ]);
    expect(roundLine(flow({}), false, several).text).toBe("Runde 3 von max. 60 · jetzt: Implementer an #3605, #3607 · Code-Review an #3604");
    const merging = at([
      [3605, "ready"],
      [3603, "ready"],
      [3602, "waiting"],
    ]);
    expect(roundLine(flow({ active: [{ role: "merger", assignment: null }] }), false, merging)).toEqual({ text: "Runde 3 von max. 60 · jetzt: Merge (#3603, #3605)", step: "merge", steps: true });
    expect(roundLine(flow({ active: [{ role: "merger", assignment: null }] }), false, []).text).toBe("Runde 3 von max. 60 · jetzt: Merge");
    expect(roundLine(flow({ iteration: { n: 1, max: null } }), false, []).text).toBe("Runde 1");
  });

  test("after the loop: the stage the run is at, no round strip", () => {
    const done = flow({ stages: [stage("worktree", "ok"), stage("sandcastle", "ok"), stage("checks", "running")], current: "checks" });
    expect(roundLine(done, false, [])).toEqual({ text: "Schleife fertig · jetzt: Prüfungen", step: null, steps: false });
  });

  test("blind and without a flow", () => {
    expect(roundLine(null, true, [])).toEqual({ text: "Stand unbekannt – dieser Lauf schreibt kein Ablauf-Log", step: null, steps: false });
    expect(roundLine(null, false, at([[12, "implementer"]]))).toEqual({ text: "jetzt: Implementer an #12", step: "building", steps: false });
    expect(roundLine(null, false, []).text).toBe("Runde unbekannt");
  });
});
