import { describe, expect, test } from "bun:test";
import { focusCreated } from "../src/herdr";

describe("focusCreated", () => {
  test("focuses workspace and tab after create", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "list") {
        return { result: { panes: [{ pane_id: "w9:p3", tab_id: "w9:t2" }] } };
      }
      return {};
    };
    await focusCreated(exec, "w9:p3", { workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t2" } });
    expect(calls).toEqual([
      ["workspace", "focus", "w9"],
      ["tab", "focus", "w9:t2"],
    ]);
  });

  test("looks up tab from pane list when omitted", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "list") {
        return { result: { panes: [{ pane_id: "w1:p1", tab_id: "w1:t1" }] } };
      }
      return {};
    };
    await focusCreated(exec, "w1:p1");
    expect(calls).toEqual([
      ["workspace", "focus", "w1"],
      ["pane", "list"],
      ["tab", "focus", "w1:t1"],
    ]);
  });
});
