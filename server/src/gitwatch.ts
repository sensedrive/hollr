/**
 * Watches the git state of the space folders – HEAD, index, ORIG_HEAD, FETCH_HEAD, packed-refs and the refs
 * folders – so a pull, fetch, commit, checkout, reset or rebase reaches the apps within a second, whoever ran
 * it: an agent, a plain shell tab, the IDE or a cron job (herdr reports none of these). Worktree-aware: a linked
 * worktree's `.git` file points at its own git dir (HEAD, index) and, through `commondir`, at the shared refs.
 * A burst of file events re-reads the summary of the repo's spaces and reports only when one of them changed –
 * an index refresh or a ref rewritten to the same commit stays quiet. No fetch: what the repo knows is what's shown.
 */
import { type Dirent, type FSWatcher, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitSummaryAsync } from "./spaces";

export interface GitDirs {
  /** HEAD, index, ORIG_HEAD, FETCH_HEAD (a linked worktree's own folder under `<common>/worktrees/`) */
  gitDir: string;
  /** refs and packed-refs (the main repo's `.git` for a worktree) */
  commonDir: string;
}

/** The git dir and common dir of the repo `dir` is in (walking up like git), without spawning git. */
export function gitDirs(dir: string): GitDirs | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const dot = join(d, ".git");
    let gitDir: string | undefined;
    try {
      if (statSync(dot).isDirectory()) gitDir = dot;
      else {
        const m = readFileSync(dot, "utf8").match(/^gitdir:\s*(.+)$/m);
        if (m?.[1]) gitDir = resolve(d, m[1].trim());
      }
    } catch {}
    if (gitDir) {
      let commonDir = gitDir;
      try {
        commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
      } catch {}
      return { gitDir, commonDir };
    }
    if (dirname(d) === d) return undefined;
  }
}

/** the files in a git dir whose change can move branch, ahead/behind or the dirty count */
const STATE_FILES = new Set(["HEAD", "index", "ORIG_HEAD", "FETCH_HEAD", "packed-refs"]);
/** per repo: refs folders beyond this are not watched (inotify watches are a per-user budget) */
const MAX_REF_DIRS = 256;

/**
 * The folders to watch for one repo and the names that count in each (undefined: any name). Folders, not files:
 * git replaces a ref or the index by renaming `<name>.lock` over it, which a watch on the old file misses.
 */
export function watchTargets(d: GitDirs): Map<string, Set<string> | undefined> {
  const out = new Map<string, Set<string> | undefined>([
    [d.gitDir, STATE_FILES],
    [d.commonDir, STATE_FILES],
  ]);
  let budget = MAX_REF_DIRS;
  const walk = (dir: string) => {
    if (budget-- <= 0) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    out.set(dir, undefined);
    for (const e of entries) if (e.isDirectory()) walk(join(dir, e.name));
  };
  walk(join(d.commonDir, "refs"));
  walk(join(d.commonDir, "reftable"));
  return out;
}

export class GitWatch {
  /** space folder → its repo */
  private roots = new Map<string, GitDirs>();
  /** watched folder → watcher, the names that count there, the common dirs (repos) it belongs to */
  private watched = new Map<string, { w: FSWatcher; names?: Set<string>; repos: Set<string> }>();
  /** space folder → its last summary (none yet: the first touch counts as a change) */
  private last = new Map<string, string>();
  /** space folder → its check: waiting for the burst to settle (`timer`), running, wanted again after that.
   *  Per space, so a big worktree's slow `git status` holds up no other space. */
  private due = new Map<
    string,
    { timer?: ReturnType<typeof setTimeout>; running?: boolean; again?: boolean }
  >();

  /** `onChange`: a space's branch, ahead/behind, dirty count or last commit changed; `delayMs` lets a burst
   *  (a pull writes refs, FETCH_HEAD, ORIG_HEAD, index …) settle into one check. */
  constructor(
    private readonly onChange: () => void,
    private readonly delayMs = 300,
  ) {}

  /** Watches exactly these space folders – call again whenever the spaces may have changed. */
  setRoots(roots: Iterable<string>): void {
    const next = new Map<string, GitDirs>();
    for (const root of roots) {
      if (!root || next.has(root)) continue;
      const d = gitDirs(root);
      if (d) next.set(root, d);
    }
    this.roots = next;
    for (const root of this.last.keys()) if (!next.has(root)) this.last.delete(root);
    for (const [root, st] of this.due)
      if (!next.has(root)) {
        clearTimeout(st.timer);
        this.due.delete(root);
      }
    this.sync();
  }

  /** the folders being watched (tests) */
  get folders(): string[] {
    return [...this.watched.keys()];
  }

  close(): void {
    for (const st of this.due.values()) clearTimeout(st.timer);
    this.due.clear();
    for (const { w } of this.watched.values()) w.close();
    this.watched.clear();
    this.roots.clear();
  }

  /** opens/closes watches to match the roots' repos – also picks up refs folders a fetch just created */
  private sync(): void {
    const want = new Map<string, { names?: Set<string>; repos: Set<string> }>();
    for (const d of this.roots.values())
      for (const [dir, names] of watchTargets(d)) {
        const cur = want.get(dir) ?? { names, repos: new Set<string>() };
        cur.repos.add(d.commonDir);
        want.set(dir, cur);
      }
    for (const [dir, entry] of this.watched)
      if (!want.has(dir)) {
        entry.w.close();
        this.watched.delete(dir);
      }
    for (const [dir, { names, repos: of }] of want) {
      const have = this.watched.get(dir);
      if (have) {
        have.repos = of;
        continue;
      }
      try {
        const w = watch(dir, (_event, name) => this.hit(dir, name ? String(name) : undefined));
        // the folder went away (worktree removed, ref folder pruned): forget it, the next sync decides
        w.on("error", () => {
          w.close();
          if (this.watched.get(dir)?.w === w) this.watched.delete(dir);
        });
        this.watched.set(dir, { w, names, repos: of });
      } catch {
        // gone in the meantime
      }
    }
  }

  private hit(dir: string, name: string | undefined): void {
    const entry = this.watched.get(dir);
    if (!entry) return;
    // lock files come and go around every write; the rename onto the real name is what counts
    if (name?.endsWith(".lock")) return;
    if (name && entry.names && !entry.names.has(name)) return;
    // a repo's refs are shared by all its worktrees: each of their spaces may have moved
    for (const [root, d] of this.roots) if (entry.repos.has(d.commonDir)) this.touch(root);
  }

  private touch(root: string): void {
    let st = this.due.get(root);
    if (!st) {
      st = {};
      this.due.set(root, st);
    }
    if (st.running) st.again = true;
    else st.timer ??= setTimeout(() => void this.check(root), this.delayMs);
  }

  /** re-reads one space's summary and reports it when it differs from the last one */
  private async check(root: string): Promise<void> {
    const st = this.due.get(root);
    if (!st) return;
    st.timer = undefined;
    st.running = true;
    const s = await gitSummaryAsync(root);
    st.running = false;
    if (!this.roots.has(root)) return;
    // what the apps show of a space's git state
    const key = JSON.stringify(
      s ? [s.branch, s.ahead, s.behind, s.dirty, s.lastCommit?.hash] : null,
    );
    if (this.last.get(root) !== key) {
      this.last.set(root, key);
      this.onChange();
    }
    this.sync();
    if (st.again) {
      st.again = false;
      this.touch(root);
    }
  }
}
