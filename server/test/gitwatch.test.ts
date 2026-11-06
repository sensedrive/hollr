import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWatch, gitDirs, watchTargets } from "../src/gitwatch";
import { gitSummary } from "../src/spaces";

// a bare remote, the watched clone ("work", with a linked worktree "wt") and a second clone that pushes
let tmp: string;
let remote: string;
let work: string;
let wt: string;
let other: string;

const env = {
  ...Bun.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function commit(cwd: string, name: string) {
  writeFileSync(join(cwd, name), name);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", name);
}
/** pushes n commits to main from the other clone */
function pushRemote(n: number) {
  git(other, "pull", "-q", "--ff-only");
  for (let i = 0; i < n; i++) commit(other, `r${Date.now()}-${i}`);
  git(other, "push", "-q", "origin", "main");
}

// Real file-system events (inotify / FSEvents) from real git runs: no fake clock can stand in for them, so these
// tests wait for the watcher's callback (polling a counter) and give the platform's event stream a moment.
/** FSEvents (macOS) starts delivering a little after the watch is set up */
const STREAM_START_MS = 250;

async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "hollr-gitwatch-")));
  remote = join(tmp, "remote.git");
  work = join(tmp, "work");
  wt = join(tmp, "wt");
  other = join(tmp, "other");
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(tmp, "clone", "-q", remote, other);
  git(other, "checkout", "-q", "-b", "main");
  commit(other, "a");
  git(other, "push", "-q", "-u", "origin", "main");
  git(tmp, "clone", "-q", remote, work);
  git(work, "worktree", "add", "-q", "--track", "-b", "feature", wt, "origin/main");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("gitDirs", () => {
  test("a repo, a folder inside it, a linked worktree, no repo", () => {
    expect(gitDirs(work)).toEqual({ gitDir: join(work, ".git"), commonDir: join(work, ".git") });
    expect(gitDirs(join(work, "sub", "deeper"))?.gitDir).toBe(join(work, ".git"));
    expect(gitDirs(wt)).toEqual({
      gitDir: join(work, ".git", "worktrees", "wt"),
      commonDir: join(work, ".git"),
    });
    expect(gitDirs(tmp)).toBeUndefined();
  });

  test("watch targets: both git dirs and every refs folder", () => {
    const targets = watchTargets({
      gitDir: join(work, ".git", "worktrees", "wt"),
      commonDir: join(work, ".git"),
    });
    expect(targets.get(join(work, ".git", "worktrees", "wt"))?.has("HEAD")).toBe(true);
    expect(targets.get(join(work, ".git"))?.has("packed-refs")).toBe(true);
    expect(targets.has(join(work, ".git", "refs", "remotes", "origin"))).toBe(true);
    expect(targets.get(join(work, ".git", "refs", "heads"))).toBeUndefined();
  });
});

describe("GitWatch", () => {
  test("fetch, pull, commit, checkout and reset in a clone and its worktree each report a change", async () => {
    let changes = 0;
    const w = new GitWatch(() => changes++, 100);
    w.setRoots([work, wt, tmp]);
    await Bun.sleep(STREAM_START_MS);
    try {
      const fired = async (what: string) => {
        const before = changes;
        const ok = await until(() => changes > before);
        if (!ok) throw new Error(`no change after ${what}`);
        await Bun.sleep(300); // let the burst settle
      };

      pushRemote(3);
      git(work, "fetch", "-q");
      await fired("fetch");
      expect(gitSummary(work)?.behind).toBe(3);
      expect(gitSummary(wt)?.behind).toBe(3);

      git(work, "pull", "-q", "--ff-only");
      await fired("pull");
      expect(gitSummary(work)?.behind).toBe(0);

      commit(work, "local");
      await fired("commit");
      expect(gitSummary(work)?.ahead).toBe(1);

      git(work, "reset", "-q", "--hard", "origin/main");
      await fired("reset");
      expect(gitSummary(work)?.ahead).toBe(0);

      // the worktree: its own HEAD/index under .git/worktrees/wt
      git(wt, "pull", "-q", "--ff-only");
      await fired("worktree pull");
      expect(gitSummary(wt)?.behind).toBe(0);

      git(work, "checkout", "-q", "-b", "other-branch");
      await fired("checkout");
      git(work, "checkout", "-q", "main");
      await fired("checkout back");

      // a branch under a new refs folder: watched after the next check, so a fetch into it is seen
      git(other, "checkout", "-q", "-b", "team/x");
      commit(other, "x");
      git(other, "push", "-q", "origin", "team/x");
      git(other, "checkout", "-q", "main");
      git(work, "fetch", "-q");
      await until(() =>
        w.folders.includes(join(work, ".git", "refs", "remotes", "origin", "team")),
      );
      expect(w.folders).toContain(join(work, ".git", "refs", "remotes", "origin", "team"));
    } finally {
      w.close();
    }
  }, 30_000);

  test("an index refresh or a no-op fetch stays quiet; closing stops the watch", async () => {
    let changes = 0;
    const w = new GitWatch(() => changes++, 100);
    w.setRoots([work]);
    await Bun.sleep(STREAM_START_MS);
    // the first touch of a space always counts (nothing to compare with yet)
    const origHead = join(work, ".git", "ORIG_HEAD");
    writeFileSync(origHead, `${git(work, "rev-parse", "HEAD")}\n`);
    expect(await until(() => changes > 0)).toBe(true);
    await Bun.sleep(300);
    const settled = changes;
    writeFileSync(origHead, `${git(work, "rev-parse", "HEAD")}\n`);
    git(work, "update-index", "--really-refresh");
    git(work, "status");
    git(work, "fetch", "-q");
    await Bun.sleep(600);
    expect(changes).toBe(settled);
    w.close();
    expect(w.folders).toEqual([]);
    pushRemote(1);
    git(work, "fetch", "-q");
    await Bun.sleep(400);
    expect(changes).toBe(settled);
  }, 30_000);
});
