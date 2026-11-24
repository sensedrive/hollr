import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubSlug, linksForCwd, paneCwd, readLinks } from "../src/links";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hollr-links-")));
const saved = Bun.env.HOLLR_STATE_DIR;
const main = join(root, "shop");
const wt = join(root, "wt", "shop-run1");
const JIRA = { baseUrl: "https://acme.atlassian.net/", projectKey: "SHOP" };

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

beforeAll(() => {
  Bun.env.HOLLR_STATE_DIR = join(root, "state");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "remote", "add", "origin", "git@github.com:acme/shop.git");
  // untracked, like in lul-workr projects: a worktree does not get a copy
  writeFileSync(join(main, ".lul-workr.json"), JSON.stringify({ jira: JIRA }));
  git(main, "worktree", "add", "-q", "-b", "feature/x", wt);
});

afterAll(() => {
  if (saved === undefined) delete Bun.env.HOLLR_STATE_DIR;
  else Bun.env.HOLLR_STATE_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("githubSlug", () => {
  test("https, ssh and scp-style remotes", () => {
    expect(githubSlug("https://github.com/leicht-luftig/tendr.git")).toBe("leicht-luftig/tendr");
    expect(githubSlug("https://github.com/leicht-luftig/tendr")).toBe("leicht-luftig/tendr");
    expect(githubSlug("https://x-access-token:abc@github.com/o/r.js.git")).toBe("o/r.js");
    expect(githubSlug("git@github.com:o/r.git")).toBe("o/r");
    expect(githubSlug("ssh://git@github.com/o/r.git")).toBe("o/r");
    expect(githubSlug("ssh://git@github.com:22/o/r")).toBe("o/r");
  });

  test("anything not on github.com is null", () => {
    for (const url of [
      "https://gitlab.com/o/r.git",
      "git@gitlab.com:o/r.git",
      "https://github.com.evil.io/o/r",
      "https://github.com/o",
      "/srv/git/r.git",
      "",
    ])
      expect(githubSlug(url)).toBeNull();
  });
});

describe("readLinks", () => {
  test("main checkout: origin slug and its .lul-workr.json", () => {
    expect(readLinks(main)).toEqual({
      repo: "acme/shop",
      jira: { baseUrl: "https://acme.atlassian.net", keys: ["SHOP"] },
    });
  });

  test("a subfolder reads the toplevel's config", () => {
    const sub = join(main, "src");
    mkdirSync(sub, { recursive: true });
    expect(readLinks(sub).jira?.keys).toEqual(["SHOP"]);
  });

  test("worktree without its own config falls back to the main checkout", () => {
    expect(readLinks(wt)).toEqual({
      repo: "acme/shop",
      jira: { baseUrl: "https://acme.atlassian.net", keys: ["SHOP"] },
    });
  });

  test("a worktree's own config wins", () => {
    writeFileSync(
      join(wt, ".lul-workr.json"),
      JSON.stringify({ jira: { baseUrl: "https://other.atlassian.net", projectKey: "OTH" } }),
    );
    try {
      expect(readLinks(wt).jira).toEqual({ baseUrl: "https://other.atlassian.net", keys: ["OTH"] });
    } finally {
      rmSync(join(wt, ".lul-workr.json"));
    }
  });

  test("https and non-GitHub origins", () => {
    const dir = join(root, "plain");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    expect(readLinks(dir)).toEqual({ repo: null, jira: null });
    git(dir, "remote", "add", "origin", "https://github.com/acme/plain.git");
    expect(readLinks(dir).repo).toBe("acme/plain");
    git(dir, "remote", "set-url", "origin", "https://gitlab.com/acme/plain.git");
    expect(readLinks(dir).repo).toBeNull();
  });

  test("config without project key or base URL gives no jira", () => {
    const dir = join(root, "nokey");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    writeFileSync(
      join(dir, ".lul-workr.json"),
      JSON.stringify({ jira: { baseUrl: "https://a.b" } }),
    );
    expect(readLinks(dir).jira).toBeNull();
    writeFileSync(join(dir, ".lul-workr.json"), JSON.stringify({ jira: { projectKey: "AB" } }));
    expect(readLinks(dir).jira).toBeNull();
    writeFileSync(join(dir, ".lul-workr.json"), "{ kaputt");
    expect(readLinks(dir).jira).toBeNull();
  });

  test("no folder or no git", () => {
    expect(readLinks("")).toEqual({ repo: null, jira: null });
    const dir = join(root, "nogit");
    mkdirSync(dir, { recursive: true });
    expect(readLinks(dir)).toEqual({ repo: null, jira: null });
  });
});

describe("linksForCwd", () => {
  test("cached for 10 minutes per folder", () => {
    const dir = join(root, "cached");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "git@github.com:acme/one.git");
    const t = 1_000_000;
    expect(linksForCwd(dir, t).repo).toBe("acme/one");
    git(dir, "remote", "set-url", "origin", "git@github.com:acme/two.git");
    expect(linksForCwd(dir, t + 9 * 60_000).repo).toBe("acme/one");
    expect(linksForCwd(dir, t + 11 * 60_000).repo).toBe("acme/two");
  });
});

describe("paneCwd", () => {
  test("foreground folder first, then where the pane started", async () => {
    const exec = async () => ({
      panes: [
        { pane_id: "w1:p1", cwd: "/a", foreground_cwd: "/a/sub" },
        { pane_id: "w1:p2", cwd: "/b" },
      ],
    });
    expect(await paneCwd(exec, "w1:p1")).toBe("/a/sub");
    expect(await paneCwd(exec, "w1:p2")).toBe("/b");
    expect(await paneCwd(exec, "w9:p9")).toBe("");
  });
});
