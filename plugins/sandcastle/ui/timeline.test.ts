import { describe, expect, test } from "bun:test";
import { clearText, loopPosition, stepText, timeline } from "./timeline";
import type { Flow, Phase, Run } from "./types";

const issue = (n: number, phase: Phase) => ({ n, title: null, phase, reason: null, logs: [], flags: null });
const run = (status: Run["status"], phases: Phase[], more: Partial<Run> = {}): Run => ({
  id: "r",
  slug: "a/b",
  project: "shop",
  cwd: "/w",
  branch: "feature/x",
  alive: true,
  pid: 1,
  startedAt: null,
  endedAt: null,
  source: "hollr",
  pane: null,
  status,
  config: { agent: null, agentLabel: null, model: null, parallel: 1, scope: null, test: null },
  issues: phases.map((p, i) => issue(i + 1, p)),
  progress: { total: 0, merged: 0, failed: 0, active: 0, queued: 0, percent: 0 },
  pr: null,
  logs: [],
  flow: null,
  ...more,
});
const flow = (states: Record<string, string>): Flow => ({
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
  stages: ["worktree", "sandcastle", "checks", "pr", "deploy", "testplan"].map((stage) => ({
    stage,
    state: (states[stage] ?? "pending") as Flow["stages"][number]["state"],
    startedAt: null,
    endedAt: null,
    reason: null,
    data: {},
  })),
  current: null,
  pass: null,
  iteration: null,
  active: [],
  assignments: [],
  paused: null,
});
const states = (r: Run) => timeline(r).map((s) => s.state);

describe("timeline", () => {
  test("from a flow: the loop runs, stations before it are done", () => {
    const r = run("running", ["merged", "failed", "reviewing", "building", "queued", "queued"], { flow: flow({ worktree: "ok", sandcastle: "running" }) });
    expect(states(r)).toEqual(["done", "done", "current", "todo", "todo", "todo", "todo"]);
    expect(loopPosition(r)).toBe("Ticket 3 von 6");
    expect(stepText(r)).toBe("Implementer an #4");
    expect(clearText(r, timeline(r), (n) => (n === 6 ? [99] : []))).toBe(
      "Der Agent baut Ticket für Ticket: #4 wird gerade gebaut, #3 ist im Code-Review. Danach folgt #5; #6 wartet auf #99.",
    );
  });

  test("waiting at the test server", () => {
    const r = run("waiting", ["merged", "failed"], { flow: flow({ worktree: "ok", sandcastle: "ok", checks: "ok", pr: "ok", deploy: "running" }) });
    expect(states(r)).toEqual(["done", "done", "done", "done", "done", "waiting", "todo"]);
    expect(stepText(r)).toBe("Testserver");
    expect(clearText(r, timeline(r), () => [])).toContain("Alle 2 Tickets sind durch: 1 gemergt, 1 fehlgeschlagen (#2).");
  });

  test("without a flow only what the status knows", () => {
    // no event yet: the board knows nothing past the start – no guessed step
    const quiet = run("running", ["queued"], { agent: { say: null, doing: "Running unit tests", at: null } });
    expect(states(quiet)).toEqual(["done", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
    expect(stepText(quiet)).toBe("Running unit tests");
    expect(clearText(quiet, timeline(quiet), () => [])).toContain("noch kein Ablauf-Log");
    expect(states(run("waiting", ["queued"]))).not.toContain("waiting");
    expect(states(run("running", ["building"]))).toEqual(["done", "done", "current", "todo", "todo", "todo", "todo"]);
    expect(states(run("loop-ended", ["merged"]))).toEqual(["done", "done", "done", "unknown", "unknown", "unknown", "unknown"]);
    expect(states(run("loop-ended", ["merged"], { pr: 7 }))).toEqual(["done", "done", "done", "done", "done", "unknown", "unknown"]);
  });
});
