import { describe, expect, test } from "bun:test";
import { dependsOn, laneChips, moveChip, runProgress, stageOf, ticketPhase } from "./dock";
import type { Phase } from "./types";

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

  test("dependencies inside the lane", () => {
    const chip = chips[2];
    if (!chip) throw new Error("missing");
    expect(dependsOn(chips, chip, (n) => (n === 14 ? [13, 500] : []))).toEqual(["T-2"]);
  });
});
