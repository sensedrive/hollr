import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TreeWorkspace } from "../src/herdr";
import { applyChanges, loadShared, patchShared, stampPanes } from "../src/shared";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hollr-shared-"));
  Bun.env.HOLLR_STATE_DIR = dir;
});
afterEach(() => {
  delete Bun.env.HOLLR_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const tree = (panes: [string, string][]): TreeWorkspace[] => [
  {
    id: "w1",
    label: "w",
    number: 1,
    focused: false,
    status: "idle",
    tabs: [
      {
        id: "t1",
        label: "t",
        number: 1,
        focused: false,
        panes: panes.map(([pane, status]) => ({
          pane,
          status,
          title: "",
          cwd: "",
          focused: false,
          live: false,
        })),
      },
    ],
  },
];
const sinceOf = (ws: TreeWorkspace[], pane: string) =>
  ws.flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((p) => p.pane === pane)?.since;

test("a pane keeps its `since` while its status stays, and gets a new one when it changes", () => {
  const a = tree([["w1:p1", "done"]]);
  stampPanes(a, 1000);
  const b = tree([["w1:p1", "done"]]);
  stampPanes(b, 5000);
  expect(sinceOf(b, "w1:p1")).toBe(1000);
  const c = tree([["w1:p1", "working"]]);
  stampPanes(c, 9000);
  expect(sinceOf(c, "w1:p1")).toBe(9000);
});

test("a seen result stays seen on every device; entries of closed panes are forgotten", () => {
  patchShared([
    { path: ["seen", "w1:p1"], value: 1000 },
    { path: ["unread", "w1:p2"], value: true },
    { path: ["mySessions"], value: ["w1:p2", "w1:p1"] },
  ]);
  expect(loadShared().seen).toEqual({ "w1:p1": 1000 });
  stampPanes(tree([["w1:p1", "done"]]), 1000);
  const after = loadShared();
  expect(after.unread).toEqual({});
  expect(after.mySessions).toEqual(["w1:p1"]);
  expect(after.seen).toEqual({ "w1:p1": 1000 });
});

test("bad changes are refused before anything is written", () => {
  const state = loadShared();
  expect(() => applyChanges(state, [{ path: ["seen", "w1:p1"], value: "x" }])).toThrow();
  expect(() => applyChanges(state, [{ path: ["nope"], value: [] }])).toThrow();
  expect(() => applyChanges(state, [{ path: ["mySessions", "x"], value: [] }])).toThrow();
  expect(
    applyChanges(state, [{ path: ["worktreeOrder", "w1"], value: ["w3", "w2", "w3"] }])
      .worktreeOrder,
  ).toEqual({
    w1: ["w3", "w2"],
  });
});
