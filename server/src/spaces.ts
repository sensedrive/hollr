/**
 * Spaces (herdr workspaces grouped by repo / worktree), git info, a read-only file browser,
 * the agent status line (model · folder · branch · context) and provider usage limits.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { branches, changes, commitDetails, commitDiff, fileDiff, graph, stage } from "./git";
import { type Exec, execHerdr } from "./herdr";
import { dedupeLimits } from "./usagehistory";

export interface Space {
  id: string;
  label: string;
  number: number;
  focused: boolean;
  status: string;
  root: string;
  repo?: string;
  isWorktree: boolean;
  git?: GitSummary;
  paneCount: number;
}

export interface GitSummary {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
  lastCommit?: { hash: string; subject: string; at: number };
}

const run = (args: string[], cwd?: string) => {
  const res = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return { ok: res.exitCode === 0, out: res.stdout.toString() };
};

export function gitSummary(dir: string): GitSummary | undefined {
  if (!existsSync(dir)) return undefined;
  const st = run(["git", "status", "--porcelain=v2", "--branch"], dir);
  if (!st.ok) return undefined;
  let branch = "?";
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  for (const line of st.out.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14);
    else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      ahead = Number(m?.[1] ?? 0);
      behind = Number(m?.[2] ?? 0);
    } else if (line && !line.startsWith("#")) dirty++;
  }
  const log = run(["git", "log", "-1", "--format=%h%x1f%s%x1f%ct"], dir);
  const [hash, subject, ct] = log.out.trim().split("\x1f");
  return {
    branch,
    ahead,
    behind,
    dirty,
    lastCommit: hash ? { hash, subject: subject ?? "", at: Number(ct) * 1000 } : undefined,
  };
}

export async function listSpaces(exec: Exec = execHerdr): Promise<Space[]> {
  const [ws, panes] = (await Promise.all([
    exec(["workspace", "list"]),
    exec(["pane", "list"]),
  ])) as [
    { workspaces?: Array<Record<string, unknown>> },
    { panes?: Array<Record<string, unknown>> },
  ];
  const allPanes = panes.panes ?? [];
  return (ws.workspaces ?? [])
    .map((w) => {
      const wt = (w.worktree ?? {}) as {
        checkout_path?: string;
        repo_name?: string;
        is_linked_worktree?: boolean;
      };
      const own = allPanes.filter((p) => p.workspace_id === w.workspace_id);
      const root = wt.checkout_path ?? (own[0]?.cwd as string | undefined) ?? "";
      return {
        id: String(w.workspace_id),
        label: String(w.label ?? `Workspace ${w.number}`),
        number: Number(w.number ?? 0),
        focused: w.focused === true,
        status: String(w.agent_status ?? "unknown"),
        root,
        repo: wt.repo_name,
        isWorktree: wt.is_linked_worktree === true,
        git: root ? gitSummary(root) : undefined,
        paneCount: own.length,
      } satisfies Space;
    })
    .sort((a, b) => a.number - b.number);
}

async function spaceRoot(wsId: string, exec: Exec): Promise<string> {
  const spaces = await listSpaces(exec);
  const space = spaces.find((s) => s.id === wsId);
  if (!space?.root) throw new Error("Space nicht gefunden");
  return realpathSync(space.root);
}

/** Resolves a path inside the space root; refuses anything outside (../, symlinks out). */
function inside(root: string, rel = ""): string {
  const target = resolve(root, rel.replace(/^\/+/, ""));
  const real = existsSync(target) ? realpathSync(target) : target;
  const r = relative(root, real);
  if (r.startsWith("..") || resolve(root, r) !== real) throw new Error("Pfad außerhalb des Space");
  return real;
}

export interface FsRequest {
  op:
    | "log"
    | "status"
    | "ls"
    | "read"
    | "diff"
    | "show"
    | "graph"
    | "commit"
    | "commitdiff"
    | "changes"
    | "branches"
    | "stage"
    | "unstage";
  ws: string;
  path?: string;
  limit?: number;
  hash?: string;
  /** diff: the staged version instead of the working tree */
  staged?: boolean;
}

const HASH_RE = /^[0-9a-f]{4,40}$/;

export async function spaceFs(req: FsRequest, exec: Exec = execHerdr): Promise<unknown> {
  const root = await spaceRoot(req.ws, exec);
  switch (req.op) {
    case "log": {
      const n = Math.min(req.limit ?? 40, 200);
      const out = run(
        ["git", "log", `-${n}`, "--date=unix", "--format=%h%x1f%s%x1f%an%x1f%ct%x1f%D"],
        root,
      ).out;
      return {
        commits: out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [hash, subject, author, ct, refs] = l.split("\x1f");
            return { hash, subject, author, at: Number(ct) * 1000, refs: refs || undefined };
          }),
        git: gitSummary(root),
      };
    }
    case "show": {
      if (!/^[0-9a-f]{4,40}$/.test(req.hash ?? "")) throw new Error("ungültiger Commit");
      const stat = run(
        ["git", "show", "--stat", "--format=%H%n%an%n%ct%n%s%n%n%b", req.hash ?? ""],
        root,
      ).out;
      return { text: stat.slice(0, 60_000) };
    }
    case "status": {
      const out = run(["git", "status", "--porcelain=v1", "-uall"], root).out;
      return {
        files: out
          .split("\n")
          .filter(Boolean)
          .slice(0, 500)
          .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
        git: gitSummary(root),
      };
    }
    case "diff": {
      const file = inside(root, req.path);
      return fileDiff(root, relative(root, file), req.staged === true);
    }
    case "graph":
      return graph(root, req.limit ?? 150);
    case "commit":
      if (!HASH_RE.test(req.hash ?? "")) throw new Error("ungültiger Commit");
      return commitDetails(root, req.hash ?? "");
    case "commitdiff": {
      if (!HASH_RE.test(req.hash ?? "")) throw new Error("ungültiger Commit");
      const rel = req.path
        ? relative(root, resolve(root, req.path.replace(/^\/+/, "")))
        : undefined;
      if (rel?.startsWith("..")) throw new Error("Pfad außerhalb des Space");
      return commitDiff(root, req.hash ?? "", rel);
    }
    case "changes":
      return changes(root);
    case "branches":
      return branches(root);
    case "stage":
    case "unstage": {
      // the file may be deleted in the working tree: check the path lexically
      const rel = relative(root, resolve(root, (req.path ?? "").replace(/^\/+/, "")));
      if (!rel || rel.startsWith("..")) throw new Error("Pfad außerhalb des Space");
      return stage(root, rel, req.op === "stage");
    }
    case "ls": {
      const dir = inside(root, req.path);
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.name !== ".git")
        .map((e) => {
          const full = join(dir, e.name);
          let size = 0;
          let mtime = 0;
          try {
            const st = statSync(full);
            size = e.isFile() ? st.size : 0;
            mtime = st.mtimeMs;
          } catch {}
          return { name: e.name, dir: e.isDirectory(), size, mtime };
        })
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
        .slice(0, 1000);
      return { root, path: relative(root, dir), entries };
    }
    case "read": {
      const file = inside(root, req.path);
      const size = statSync(file).size;
      const buf = readFileSync(file).subarray(0, 300_000);
      const binary = buf.subarray(0, 8000).includes(0);
      return {
        path: relative(root, file),
        size,
        binary,
        truncated: size > buf.length,
        text: binary ? "" : buf.toString("utf8"),
      };
    }
  }
}

// ---------------------------------------------------------------- status line

export interface StatusLine {
  model?: string;
  folder?: string;
  branch?: string;
  dirty?: number;
  context?: string;
  cost?: string;
}

/** Parses omp's footer, e.g. "󰵗 · 󰪣 Opus 5.5 ·  my-app ·  main *1 · 1.6%/1M 󰁨 · 󰙺 0.10". */
export function parseFooter(screen: string): StatusLine {
  const lines = screen.split("\n").filter((l) => l.includes("·"));
  const line = lines.at(-1) ?? "";
  const out: StatusLine = {};
  const ctx = line.match(/(\d+(?:\.\d+)?%\/\d+(?:\.\d+)?[KM])/);
  if (ctx) out.context = ctx[1];
  const cost = line.match(/\u{F067A}\s*([\d.,]+)/u) ?? line.match(/\$\s?([\d.,]+)/);
  if (cost) out.cost = cost[1];
  const model = line.match(
    /(Opus|Sonnet|Haiku|Fable|GPT[-\s][\w.]+|o\d[\w-]*|Gemini[\w .-]*|Grok[\w .-]*|Kimi[\w .-]*|Qwen[\w .-]*)\s*[\d.]*/i,
  );
  if (model) out.model = model[0].trim();
  return out;
}

export function statusLine(cwd: string, footer: StatusLine, modelId?: string): StatusLine {
  const git = cwd ? gitSummary(cwd) : undefined;
  return {
    model: footer.model ?? prettyModel(modelId),
    folder: cwd.split("/").filter(Boolean).pop(),
    branch: git?.branch,
    dirty: git?.dirty,
    context: footer.context,
    cost: footer.cost,
  };
}

function prettyModel(id?: string): string | undefined {
  if (!id) return undefined;
  const name = id.split("/").pop() ?? id;
  return name
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/^(\w)/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------- usage limits

export interface UsageLimit {
  provider: string;
  /** which account (redacted org/email), several accounts per provider are common */
  account: string;
  label: string;
  window: string;
  used: number; // 0..1
  resetsAt?: number;
  status?: string;
}

export interface Capacity {
  provider: string;
  window: string;
  meter?: string;
  accounts: number;
  /** pooled across accounts, 0..1 */
  used: number;
}

const USAGE_CACHE = join(Bun.env.XDG_RUNTIME_DIR || tmpdir(), "hollr", "usage2.json");

/** Provider limits via `omp usage --json` (cached 2 minutes – the call hits provider APIs). */
export async function usageLimits(
  force = false,
): Promise<{ limits: UsageLimit[]; fetchedAt: number }> {
  try {
    if (!force && existsSync(USAGE_CACHE)) {
      const cached = JSON.parse(readFileSync(USAGE_CACHE, "utf8"));
      if (Date.now() - cached.fetchedAt < 120_000) return cached;
    }
  } catch {}
  const omp =
    [join(Bun.env.HOME ?? "", ".local/bin/omp"), "omp"].find((p) => p === "omp" || existsSync(p)) ??
    "omp";
  const proc = Bun.spawn([omp, "usage", "--json", "--redact"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), 25_000);
  const text = await new Response(proc.stdout).text();
  clearTimeout(timer);
  const limits: UsageLimit[] = [];
  const capacity: Capacity[] = [];
  try {
    const data = JSON.parse(text) as {
      reports?: Array<{
        provider: string;
        metadata?: { orgName?: string; email?: string; accountId?: string };
        limits?: Array<{
          label?: string;
          window?: { label?: string; resetsAt?: number };
          amount?: { usedFraction?: number };
          status?: string;
        }>;
      }>;
      capacity?: Record<
        string,
        Array<{ window: string; meter?: string; accounts: number; usedAccounts: number }>
      >;
    };
    for (const [provider, rows] of Object.entries(data.capacity ?? {})) {
      for (const c of rows) {
        if (!c.accounts) continue;
        const used = Math.max(0, Math.min(1, c.usedAccounts / c.accounts));
        capacity.push({ provider, window: c.window, meter: c.meter, accounts: c.accounts, used });
      }
    }
    for (const report of data.reports ?? []) {
      const m = report.metadata ?? {};
      const account = m.orgName ?? m.email ?? m.accountId ?? "";
      for (const l of report.limits ?? []) {
        if (typeof l.amount?.usedFraction !== "number") continue;
        limits.push({
          provider: report.provider,
          account,
          label: l.label ?? report.provider,
          window: l.window?.label ?? "",
          used: Math.max(0, Math.min(1, l.amount.usedFraction)),
          resetsAt: l.window?.resetsAt,
          status: l.status,
        });
      }
    }
  } catch {}
  const result = { limits: dedupeLimits(limits), capacity, fetchedAt: Date.now() };
  try {
    mkdirSync(join(USAGE_CACHE, ".."), { recursive: true });
    writeFileSync(USAGE_CACHE, JSON.stringify(result));
  } catch {}
  return result;
}

// ---------------------------------------------------------------- create / close spaces

export interface SpaceRequest {
  op: "create" | "worktree" | "close" | "info";
  /** create: folder on the server (absolute or ~/…) */
  cwd?: string;
  label?: string;
  /** worktree: repo workspace to branch from; close: workspace to close */
  ws?: string;
  branch?: string;
  base?: string;
  /** start an agent in the new space (omp / claude / codex) */
  agent?: string;
  /** close: also delete the git worktree checkout (only for worktree spaces) */
  removeWorktree?: boolean;
  force?: boolean;
  /** close a worktree: also delete its branch locally … */
  deleteBranch?: boolean;
  /** … and on origin */
  deleteRemote?: boolean;
  /** close a normal space: delete its folder completely */
  deleteFolder?: boolean;
}

/** What closing would throw away: changes, unpushed commits, branch, running agents. */
export async function closeInfo(ws: string, exec: Exec = execHerdr) {
  const spaces = await listSpaces(exec);
  const space = spaces.find((s) => s.id === ws);
  if (!space) throw new Error("Space nicht gefunden");
  const root = space.root;
  const git = root ? run(["git", "rev-parse", "--is-inside-work-tree"], root).ok : false;
  let branch: string | undefined;
  let changed = 0;
  let add = 0;
  let del = 0;
  let unpushed = 0;
  let remoteBranch = false;
  let defaultBranch = false;
  let linkedWorktrees = 0;
  if (git) {
    linkedWorktrees = Math.max(
      0,
      run(["git", "worktree", "list", "--porcelain"], root)
        .out.split("\n")
        .filter((l) => l.startsWith("worktree ")).length - 1,
    );
    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], root).out.trim() || undefined;
    changed = run(["git", "status", "--porcelain"], root).out.split("\n").filter(Boolean).length;
    for (const line of run(["git", "diff", "HEAD", "--numstat"], root).out.split("\n")) {
      const [a, d] = line.split("\t");
      add += Number(a) || 0;
      del += Number(d) || 0;
    }
    unpushed =
      Number(run(["git", "rev-list", "--count", "HEAD", "--not", "--remotes"], root).out.trim()) ||
      0;
    if (branch) {
      remoteBranch = run(
        ["git", "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
        root,
      ).ok;
      const head = run(
        ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        root,
      ).out.trim();
      defaultBranch = ["main", "master", "develop"].includes(branch) || head === `origin/${branch}`;
    }
  }
  return {
    ws,
    label: space.label,
    root,
    isWorktree: space.isWorktree,
    git,
    branch,
    changed,
    add,
    del,
    unpushed,
    remoteBranch,
    defaultBranch,
    agents: space.paneCount,
    linkedWorktrees,
    // deleting the folder is only offered for plain folders inside home or /tmp,
    // never for a repo other worktrees still depend on
    canDeleteFolder: !space.isWorktree && linkedWorktrees === 0 && safeToDelete(root),
  };
}

/** Never delete /, the home directory itself, system folders or anything outside home and /tmp. */
export function safeToDelete(dir: string): boolean {
  if (!dir) return false;
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  const home = realpathSync(Bun.env.HOME ?? "/nonexistent");
  const inHome = real.startsWith(`${home}/`) && real.split("/").length > home.split("/").length;
  const inTmp = /^\/(private\/)?(tmp|var\/tmp)\/[^/]+/.test(real);
  return (inHome || inTmp) && real !== home;
}

const BRANCH_RE = /^[\w][\w./-]{0,120}$/;

function rootPaneOf(created: unknown): string | undefined {
  const c = created as Record<string, { pane_id?: string } | undefined> & {
    workspace?: { workspace_id?: string };
  };
  return c.root_pane?.pane_id ?? c.pane?.pane_id;
}

export async function manageSpace(
  req: SpaceRequest,
  exec: Exec = execHerdr,
): Promise<{ ws?: string; pane?: string }> {
  const label = (req.label ?? "")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .trim()
    .slice(0, 40);
  let created: unknown;
  switch (req.op) {
    case "create": {
      const home = Bun.env.HOME ?? "";
      const cwd = (req.cwd ?? "").trim().replace(/^~(?=\/|$)/, home) || home;
      if (!cwd.startsWith("/")) throw new Error("Ordner muss absolut sein (/… oder ~/…)");
      mkdirSync(cwd, { recursive: true });
      const args = ["workspace", "create", "--cwd", cwd, "--no-focus"];
      if (label) args.push("--label", label);
      created = await exec(args);
      break;
    }
    case "worktree": {
      if (!req.ws) throw new Error("Repo-Space fehlt");
      if (!req.branch || !BRANCH_RE.test(req.branch)) throw new Error("Ungültiger Branch-Name");
      const args = [
        "worktree",
        "create",
        "--workspace",
        req.ws,
        "--branch",
        req.branch,
        "--no-focus",
      ];
      if (req.base && BRANCH_RE.test(req.base)) args.push("--base", req.base);
      if (label) args.push("--label", label);
      created = await exec(args);
      break;
    }
    case "info":
      if (!req.ws) throw new Error("Space fehlt");
      return (await closeInfo(req.ws, exec)) as never;
    case "close": {
      if (!req.ws) throw new Error("Space fehlt");
      const info = await closeInfo(req.ws, exec);
      if (req.removeWorktree) {
        if (!info.isWorktree) throw new Error("Das ist kein Worktree");
        // main repo, to delete the branch after the worktree is gone
        const common = run(
          ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
          info.root,
        ).out.trim();
        const mainRepo = common.replace(/\/\.git\/?$/, "");
        const args = ["worktree", "remove", "--workspace", req.ws];
        if (req.force) args.push("--force");
        await exec(args);
        if (req.deleteBranch && info.branch && !info.defaultBranch && info.branch !== "HEAD") {
          const res = run(["git", "branch", "-D", info.branch], mainRepo);
          if (!res.ok)
            throw new Error(`Worktree entfernt, Branch ${info.branch} ließ sich nicht löschen`);
          if (req.deleteRemote && info.remoteBranch) {
            const push = run(["git", "push", "origin", "--delete", info.branch], mainRepo);
            if (!push.ok) throw new Error(`Branch lokal gelöscht, auf origin nicht (Rechte?)`);
          }
        }
      } else {
        await exec(["workspace", "close", req.ws]);
        if (req.deleteFolder) {
          if (!info.canDeleteFolder)
            throw new Error("Dieser Ordner wird aus Sicherheitsgründen nicht gelöscht");
          // other open spaces inside this folder?
          const others = (await listSpaces(exec)).filter(
            (s) => s.root && (s.root === info.root || s.root.startsWith(`${info.root}/`)),
          );
          if (others.length) throw new Error("Ein anderer Space nutzt diesen Ordner noch");
          const res = Bun.spawnSync(["rm", "-rf", "--", realpathSync(info.root)]);
          if (res.exitCode !== 0) throw new Error("Ordner ließ sich nicht löschen");
        }
      }
      return { ws: req.ws };
    }
  }
  const pane = rootPaneOf(created);
  const ws =
    (created as { workspace?: { workspace_id?: string } }).workspace?.workspace_id ??
    pane?.split(":")[0];
  if (pane && req.agent && ["omp", "claude", "codex"].includes(req.agent)) {
    await Bun.sleep(400);
    await exec([
      "agent",
      "start",
      `${req.agent}-${Date.now().toString(36)}`,
      "--kind",
      req.agent,
      "--pane",
      pane,
    ]).catch(() => {});
  }
  return { ws, pane };
}
