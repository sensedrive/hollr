import { describe, expect, test } from "bun:test";
import { serverTarget } from "./serverTabs";

describe("serverTarget", () => {
  const panes = [
    { pane: "w1:p1", status: "idle" },
    { pane: "w1:p2", status: "working" },
    { pane: "w2:p1", status: "done" },
    { pane: "w2:p2", status: "blocked" },
  ];

  test("the last session opened there wins while it exists", () => {
    expect(serverTarget("w1:p1", panes, true)).toBe("w1:p1");
  });
  test("keeps the last session while the tree is still loading", () => {
    expect(serverTarget("w9:p9", [], false)).toBe("w9:p9");
  });
  test("a closed last session falls back to the most urgent: blocked > done > working", () => {
    expect(serverTarget("w9:p9", panes, true)).toBe("w2:p2");
    expect(serverTarget(undefined, panes.slice(0, 3), true)).toBe("w2:p1");
    expect(serverTarget(undefined, panes.slice(0, 2), true)).toBe("w1:p2");
  });
  test("nothing urgent: none (Server-Info)", () => {
    expect(serverTarget(undefined, panes.slice(0, 1), true)).toBeUndefined();
    expect(serverTarget(undefined, [], true)).toBeUndefined();
    expect(serverTarget(undefined, [], false)).toBeUndefined();
  });
});
