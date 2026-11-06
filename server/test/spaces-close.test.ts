import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeInfo, groupOf, manageSpace, type Space } from "../src/spaces";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hollr-spaces-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** herdr with a repo's main space (w1), two linked worktree spaces (w2; w3 whose folder is gone) and a plain one (w4) */
function herdr() {
  const repo = join(dir, "repo");
  const wt1 = join(dir, "wt1");
  const wt2 = join(dir, "wt2-deleted");
  const plain = join(dir, "plain");
  for (const d of [repo, wt1, plain]) mkdirSync(d);
  const key = join(repo, ".git");
  const ws = (id: string, label: string, path: string, linked?: boolean) => ({
    workspace_id: id,
    label,
    number: Number(id.slice(1)),
    ...(linked === undefined
      ? {}
      : {
          worktree: {
            checkout_path: path,
            is_linked_worktree: linked,
            repo_key: key,
            repo_name: "repo",
          },
        }),
  });
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "workspace" && args[1] === "list")
      return {
        workspaces: [
          ws("w1", "repo", repo, false),
          ws("w2", "wt1", wt1, true),
          ws("w3", "wt2", wt2, true),
          ws("w4", "plain", plain),
        ],
      };
    if (args[0] === "pane" && args[1] === "list")
      return {
        panes: [
          { pane_id: "w1:p1", workspace_id: "w1", cwd: repo },
          { pane_id: "w2:p1", workspace_id: "w2", cwd: wt1 },
          { pane_id: "w3:p1", workspace_id: "w3", cwd: wt2 },
          { pane_id: "w4:p1", workspace_id: "w4", cwd: plain },
        ],
      };
    return { type: "ok" };
  };
  return { exec, calls, wt2 };
}

const space = (s: Partial<Space> & { id: string }): Space => ({
  label: s.id,
  number: 0,
  focused: false,
  status: "idle",
  root: `/x/${s.id}`,
  isWorktree: false,
  paneCount: 1,
  ...s,
});

describe("groupOf", () => {
  test("a main checkout groups its linked worktrees of the same repo", () => {
    const main = space({ id: "w1", repoKey: "/r/.git" });
    const all = [
      main,
      space({ id: "w2", repoKey: "/r/.git", isWorktree: true }),
      space({ id: "w3", repoKey: "/other/.git", isWorktree: true }),
      space({ id: "w4", repoKey: "/r/.git" }),
    ];
    expect(groupOf(main, all).map((s) => s.id)).toEqual(["w2"]);
  });

  test("a worktree or a plain folder closes alone", () => {
    const wt = space({ id: "w2", repoKey: "/r/.git", isWorktree: true });
    const all = [space({ id: "w1", repoKey: "/r/.git" }), wt];
    expect(groupOf(wt, all)).toEqual([]);
    expect(groupOf(space({ id: "w9" }), all)).toEqual([]);
  });
});

describe("closing spaces", () => {
  test("the main space lists the worktree spaces that close with it, a gone folder flagged", async () => {
    const h = herdr();
    const info = await closeInfo("w1", h.exec);
    expect(info.missing).toBe(false);
    expect(info.group.map((g) => [g.ws, g.label, g.missing])).toEqual([
      ["w2", "wt1", false],
      ["w3", "wt2", true],
    ]);
  });

  test("a space whose folder is gone still answers (no git), flagged missing", async () => {
    const h = herdr();
    const info = await closeInfo("w3", h.exec);
    expect(info).toMatchObject({
      ws: "w3",
      missing: true,
      git: false,
      group: [],
      canDeleteFolder: false,
    });
  });

  test("the main space closes only once the group is confirmed – then with --group", async () => {
    const h = herdr();
    await expect(manageSpace({ op: "close", ws: "w1" }, h.exec)).rejects.toThrow(
      "Mit „repo“ schließen auch „wt1“, „wt2“ – bitte erst bestätigen",
    );
    expect(h.calls.some((c) => c[1] === "close")).toBe(false);
    await manageSpace({ op: "close", ws: "w1", group: true }, h.exec);
    expect(h.calls.at(-1)).toEqual(["workspace", "close", "w1", "--group"]);
  });

  test("a stale worktree space (folder gone) closes on its own; removing its worktree is refused", async () => {
    const h = herdr();
    await manageSpace({ op: "close", ws: "w3" }, h.exec);
    expect(h.calls.at(-1)).toEqual(["workspace", "close", "w3"]);
    await expect(
      manageSpace({ op: "close", ws: "w3", removeWorktree: true }, h.exec),
    ).rejects.toThrow("Der Ordner fehlt schon");
  });

  test("a plain space closes without --group", async () => {
    const h = herdr();
    await manageSpace({ op: "close", ws: "w4" }, h.exec);
    expect(h.calls.at(-1)).toEqual(["workspace", "close", "w4"]);
  });
});
