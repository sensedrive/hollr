import { describe, expect, test } from "bun:test";
import { closePane } from "../src/close";
import { HerdrError } from "../src/herdr";

/** A fake herdr: answers `pane get` / `workspace get` / `tab create` from the given state, records every call. */
function herdr(opts: { paneCount: number; checkout?: string; closeFails?: string }) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    const [what, verb, id] = args;
    if (what === "pane" && verb === "get")
      return {
        pane: { pane_id: id, workspace_id: "w1", tab_id: "w1:t2", cwd: "/home/u/proj/sub" },
      };
    if (what === "workspace" && verb === "get")
      return {
        workspace: {
          workspace_id: id,
          pane_count: opts.paneCount,
          ...(opts.checkout ? { worktree: { checkout_path: opts.checkout } } : {}),
        },
      };
    if (what === "tab" && verb === "create")
      return { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } };
    if (what === "pane" && verb === "close" && id === "w1:p2" && opts.closeFails)
      throw new HerdrError("confirmation_required", opts.closeFails);
    return { type: "ok" };
  };
  return { exec, calls };
}

describe("closePane", () => {
  test("a pane among others just closes", async () => {
    const h = herdr({ paneCount: 2 });
    expect(await closePane(h.exec, "w1:p2")).toEqual({});
    expect(h.calls).toEqual([
      ["pane", "get", "w1:p2"],
      ["workspace", "get", "w1"],
      ["pane", "close", "w1:p2"],
    ]);
  });

  test("the last pane: a terminal in the space's folder takes over first, the space stays", async () => {
    const h = herdr({ paneCount: 1, checkout: "/home/u/proj" });
    expect(await closePane(h.exec, "w1:p2")).toEqual({ placeholder: "w1:p9" });
    expect(h.calls.slice(2)).toEqual([
      ["tab", "create", "--workspace", "w1", "--no-focus", "--cwd", "/home/u/proj"],
      ["pane", "close", "w1:p2"],
    ]);
  });

  test("no git checkout: the terminal opens in the pane's folder", async () => {
    const h = herdr({ paneCount: 1 });
    await closePane(h.exec, "w1:p2");
    expect(h.calls[2]).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--no-focus",
      "--cwd",
      "/home/u/proj/sub",
    ]);
  });

  test("a refused close takes the stand-in terminal back and reports herdr's error", async () => {
    const h = herdr({ paneCount: 1, closeFails: "closing this pane would close a worktree group" });
    await expect(closePane(h.exec, "w1:p2")).rejects.toThrow(
      "closing this pane would close a worktree group",
    );
    expect(h.calls.slice(-2)).toEqual([
      ["pane", "close", "w1:p2"],
      ["pane", "close", "w1:p9"],
    ]);
  });

  test("an unknown pane fails before anything is created", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      throw new HerdrError("pane_not_found", "pane w1:p7 not found");
    };
    await expect(closePane(exec, "w1:p7")).rejects.toThrow("pane w1:p7 not found");
    expect(calls).toEqual([["pane", "get", "w1:p7"]]);
  });
});
