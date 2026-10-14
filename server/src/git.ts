/**
 * Git views for the app (Moshi-style): history graph, commit details, uncommitted
 * changes with full-context diffs, branches with ahead/PR state, stage/unstage.
 * Every path is resolved inside the space root by the caller.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Run = (cmd: string[], cwd: string) => { ok: boolean; out: string };

export const gitRun: Run = (cmd, cwd) => {
  const res = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return { ok: res.exitCode === 0, out: res.stdout.toString() };
};

const SEP = "\x1f";

export interface GraphCommit {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  at: number;
  refs?: string;
}

/** HEAD history in topological order (the client lays out the lanes). */
export function graph(root: string, limit = 150, run: Run = gitRun) {
  const out = run(
    [
      "git",
      "log",
      "--topo-order",
      `-${Math.min(limit, 400)}`,
      `--format=%H${SEP}%P${SEP}%s${SEP}%an${SEP}%ct${SEP}%D`,
    ],
    root,
  ).out;
  const commits: GraphCommit[] = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash = "", parents = "", subject = "", author = "", ct = "0", refs = ""] =
        l.split(SEP);
      return {
        hash,
        parents: parents.split(" ").filter(Boolean),
        subject,
        author,
        at: Number(ct) * 1000,
        refs: refs || undefined,
      };
    });
  return { commits, changes: changesSummary(root, run) };
}

interface NumstatFile {
  path: string;
  status: string;
  add: number;
  del: number;
}

function numstat(text: string): Map<string, { add: number; del: number }> {
  const map = new Map<string, { add: number; del: number }>();
  for (const line of text.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    if (!rest.length) continue;
    let path = rest.join("\t");
    // renames: "old => new" or "dir/{old => new}"
    path = path.replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "");
    map.set(path, { add: Number(a) || 0, del: Number(d) || 0 });
  }
  return map;
}

/** Commit details: full message, author, files with +/- (for the commit sheet). */
export function commitDetails(root: string, hash: string, run: Run = gitRun) {
  const meta = run(
    ["git", "show", "-s", `--format=%H${SEP}%an${SEP}%ae${SEP}%ct${SEP}%P${SEP}%s${SEP}%b`, hash],
    root,
  ).out;
  const [full = "", author = "", email = "", ct = "0", parents = "", subject = "", body = ""] =
    meta.split(SEP);
  const merge = parents.trim().split(" ").filter(Boolean).length > 1;
  // merges: show what the merge brought in (first-parent diff)
  const range = merge ? [`${hash}^1`, hash] : [`${hash}^!`];
  const stats = numstat(run(["git", "diff", "--numstat", "-M", ...range], root).out);
  const names = run(["git", "diff", "--name-status", "-M", ...range], root).out;
  const files: NumstatFile[] = names
    .split("\n")
    .filter(Boolean)
    .slice(0, 500)
    .map((l) => {
      const parts = l.split("\t");
      const status = (parts[0] ?? "M").slice(0, 1);
      const path = parts[parts.length - 1] ?? "";
      const s = stats.get(path) ?? { add: 0, del: 0 };
      return { path, status, ...s };
    });
  return {
    hash: full,
    author,
    email,
    at: Number(ct) * 1000,
    subject,
    body: body.trim().slice(0, 4000),
    merge,
    files,
  };
}

/** Patch of one commit (optionally one file), first-parent for merges. */
export function commitDiff(
  root: string,
  hash: string,
  path: string | undefined,
  run: Run = gitRun,
) {
  const meta = run(["git", "show", "-s", "--format=%P", hash], root)
    .out.trim()
    .split(" ")
    .filter(Boolean);
  const range =
    meta.length > 1 ? [`${hash}^1`, hash] : meta.length ? [`${hash}^`, hash] : ["--root", hash];
  const args = meta.length
    ? ["git", "diff", "-M", "-U12", ...range]
    : ["git", "show", "--format=", "-M", "-U12", hash];
  if (path) args.push("--", path);
  return { text: run(args, root).out.slice(0, 400_000) };
}

function changesSummary(root: string, run: Run) {
  const staged = numstat(run(["git", "diff", "--cached", "--numstat"], root).out);
  const unstaged = numstat(run(["git", "diff", "--numstat"], root).out);
  const untracked = run(["git", "ls-files", "--others", "--exclude-standard"], root)
    .out.split("\n")
    .filter(Boolean);
  let add = 0;
  let del = 0;
  for (const m of [staged, unstaged])
    for (const v of m.values()) {
      add += v.add;
      del += v.del;
    }
  return { files: new Set([...staged.keys(), ...unstaged.keys(), ...untracked]).size, add, del };
}

/** Uncommitted changes split into staged / unstaged (untracked count as unstaged "A"). */
export function changes(root: string, run: Run = gitRun) {
  const branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], root).out.trim();
  const status = run(["git", "status", "--porcelain=v1", "-uall"], root).out;
  const stagedStats = numstat(run(["git", "diff", "--cached", "--numstat", "-M"], root).out);
  const unstagedStats = numstat(run(["git", "diff", "--numstat"], root).out);
  const staged: NumstatFile[] = [];
  const unstaged: NumstatFile[] = [];
  for (const line of status.split("\n").filter(Boolean).slice(0, 800)) {
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    let path = line.slice(3);
    if (path.includes(" -> ")) path = path.split(" -> ").pop() ?? path;
    path = path.replace(/^"|"$/g, "");
    if (x === "?" && y === "?") {
      let add = 0;
      try {
        const text = readFileSync(join(root, path));
        if (!text.subarray(0, 8000).includes(0)) add = text.toString("utf8").split("\n").length;
      } catch {}
      unstaged.push({ path, status: "A", add, del: 0 });
      continue;
    }
    if (x !== " ")
      staged.push({
        path,
        status: x === "R" ? "R" : x,
        ...(stagedStats.get(path) ?? { add: 0, del: 0 }),
      });
    if (y !== " ")
      unstaged.push({ path, status: y, ...(unstagedStats.get(path) ?? { add: 0, del: 0 }) });
  }
  return { branch, staged, unstaged };
}

/** Full-context diff of one file (the app folds unchanged runs). */
export function fileDiff(root: string, rel: string, staged: boolean, run: Run = gitRun) {
  const args = staged
    ? ["git", "diff", "--cached", "-U99999", "--", rel]
    : ["git", "diff", "-U99999", "--", rel];
  let text = run(args, root).out;
  if (!text && !staged)
    text = run(["git", "diff", "--no-index", "-U99999", "/dev/null", rel], root).out; // untracked
  return { text: text.slice(0, 400_000) };
}

export function stage(root: string, rel: string, on: boolean, run: Run = gitRun) {
  const res = on
    ? run(["git", "add", "--", rel], root)
    : run(["git", "restore", "--staged", "--", rel], root);
  if (!res.ok) throw new Error(on ? "Stagen fehlgeschlagen" : "Unstagen fehlgeschlagen");
  return { ok: true };
}

// ---------------------------------------------------------------- branches

interface PrInfo {
  number: number;
  state: string;
  draft: boolean;
  checks?: "ok" | "fail" | "pending";
}

/** Open/merged PRs by head branch via `gh` (cached 2 min; no gh = no PR chips). */
function pullRequests(root: string): Record<string, PrInfo> {
  const key = Buffer.from(root).toString("base64url").slice(-40);
  const dir = join(tmpdir(), "hollr-pr");
  const file = join(dir, `${key}.json`);
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as {
      at: number;
      prs: Record<string, PrInfo>;
    };
    if (Date.now() - cached.at < 120_000) return cached.prs;
  } catch {}
  // PR badges are optional: without the GitHub CLI there are just none
  let res: { exitCode: number | null; stdout: Buffer } = { exitCode: 1, stdout: Buffer.from("") };
  try {
    res = Bun.spawnSync(
      [
        "gh",
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "60",
        "--json",
        "number,headRefName,state,isDraft,statusCheckRollup",
      ],
      { cwd: root, stdout: "pipe", stderr: "ignore", timeout: 8000 },
    );
  } catch {}
  const prs: Record<string, PrInfo> = {};
  if (res.exitCode === 0) {
    try {
      const list = JSON.parse(res.stdout.toString()) as Array<{
        number: number;
        headRefName: string;
        state: string;
        isDraft: boolean;
        statusCheckRollup?: Array<{ conclusion?: string; state?: string; status?: string }>;
      }>;
      for (const pr of list) {
        const checks = pr.statusCheckRollup ?? [];
        const states = checks.map((c) => (c.conclusion || c.state || c.status || "").toUpperCase());
        const result: PrInfo["checks"] = !states.length
          ? undefined
          : states.some((s) =>
                ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s),
              )
            ? "fail"
            : states.every((s) => ["SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"].includes(s))
              ? "ok"
              : "pending";
        prs[pr.headRefName] = {
          number: pr.number,
          state: pr.state,
          draft: pr.isDraft,
          checks: result,
        };
      }
    } catch {}
  }
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ at: Date.now(), prs }));
  } catch {}
  return prs;
}

export function branches(root: string, run: Run = gitRun) {
  const out = run(
    [
      "git",
      "for-each-ref",
      "--sort=-committerdate",
      `--format=%(refname)${SEP}%(refname:short)${SEP}%(subject)${SEP}%(committerdate:unix)${SEP}%(upstream:track)${SEP}%(HEAD)`,
      "refs/heads",
      "refs/remotes",
    ],
    root,
  ).out;
  const prs = pullRequests(root);
  const local: unknown[] = [];
  const remote: unknown[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [ref = "", name = "", subject = "", ct = "0", track = "", head = ""] = line.split(SEP);
    if (ref.endsWith("/HEAD")) continue;
    const ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
    const behind = Number(track.match(/behind (\d+)/)?.[1] ?? 0);
    const isRemote = ref.startsWith("refs/remotes/");
    const short = isRemote ? name.replace(/^[^/]+\//, "") : name;
    const entry = {
      name,
      subject,
      at: Number(ct) * 1000,
      current: head === "*",
      ahead,
      behind,
      pr: prs[short],
    };
    (isRemote ? remote : local).push(entry);
  }
  return { local: local.slice(0, 200), remote: remote.slice(0, 300) };
}
