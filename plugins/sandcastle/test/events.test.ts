import { describe, expect, test } from "bun:test";
import { inProgress, parseProgress } from "../src/events";

const line = (e: Record<string, unknown>) => JSON.stringify(e);

describe("parseProgress", () => {
  const text = [
    line({ t: "picked", at: "2026-01-01T09:00:00Z", iteration: 1, issues: [{ id: 1, title: "alt" }] }),
    line({ t: "loop-start", at: "2026-01-01T10:00:00Z", cwd: "/w", branch: "feature/queue", agent: "x", parallel: 2 }),
    line({ t: "picked", at: "2026-01-01T10:01:00Z", iteration: 1, issues: [{ id: "612", title: "A" }, { id: 615, title: "B" }] }),
    "{kaputt",
    line({ t: "failed", at: "2026-01-01T10:05:00Z", issue: 612, reason: "Tests rot" }),
    line({ t: "picked", at: "2026-01-01T10:06:00Z", iteration: 2, issues: [{ id: 601, title: "C" }] }),
    line({ t: "no-commits", at: "2026-01-01T10:07:00Z", issues: [601] }),
    line({ t: "merged", at: "2026-01-01T10:09:00Z", issues: [612, 615] }),
    line({ t: "loop-end", at: "2026-01-01T10:10:00Z", reason: "empty" }),
  ].join("\n");

  test("only events since the run started count", () => {
    const p = parseProgress(text, "2026-01-01T10:00:00Z");
    expect(p.picked.has(1)).toBe(false);
    expect(p.loop).toEqual({ cwd: "/w", branch: "feature/queue" });
    expect(p.titles.get(612)).toBe("A");
  });

  test("a later merge wins over an earlier failure; a broken line is skipped", () => {
    const p = parseProgress(text, "2026-01-01T10:00:00Z");
    expect([...p.merged].sort()).toEqual([612, 615]);
    expect(p.failed.size).toBe(0);
    expect([...p.noCommits]).toEqual([601]);
    expect(p.loopEnded).toBe("empty");
    expect(inProgress(p)).toEqual([]);
  });

  test("in progress = picked minus merged, failed and without commits", () => {
    const p = parseProgress(text, "2026-01-01T10:00:00Z");
    p.merged.delete(615);
    expect(inProgress(p)).toEqual([615]);
  });

  test("a later no-commits wins over an earlier merge: the issue is in one set only", () => {
    const later = `${text}\n${line({ t: "no-commits", at: "2026-01-01T10:20:00Z", issues: [615] })}`;
    const p = parseProgress(later, "2026-01-01T10:00:00Z");
    expect(p.merged.has(615)).toBe(false);
    expect(p.noCommits.has(615)).toBe(true);
  });

  test("run-end from the skill", () => {
    const p = parseProgress(`${text}\n${line({ t: "run-end", at: "2026-01-01T11:00:00Z", result: "ok", pr: 123 })}`, "2026-01-01T10:00:00Z");
    expect(p.runEnd).toEqual({ result: "ok", pr: 123 });
  });
});
