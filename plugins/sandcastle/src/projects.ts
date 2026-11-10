/**
 * lul-workr projects on this computer: main checkouts with a `.lul-workr.json` under $HOME (worktrees and
 * sandbox copies left out). Cached for 6 h – the search walks the home folder.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Labels } from "./board";
import { HttpError, run } from "./env";

export interface Project {
  id: string;
  name: string;
  root: string;
  gitCommonDir: string;
  slug: string;
  defaultBranch: string;
  engine: string;
  labels: Labels;
  defaults: { agent: string; parallel: number };
  /** the loop on the default branch knows the queue (lul-workr-setup → Sandcastle nachziehen) */
  queueSupported: boolean;
  jiraBaseUrl: string | null;
  error?: string;
}

const TTL = 6 * 3600_000;

/** `.lul-workr.json` as far as the board reads it. */
interface Config {
  project?: string;
  repo?: { slug?: string; defaultBranch?: string };
  jira?: { baseUrl?: string };
  github?: { labels?: { queue?: string; story?: string; grillTicket?: string } };
  engine?: { kind?: string; sandcastle?: { defaults?: { agent?: string; parallel?: number } } };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export async function measureQueueSupport(root: string, defaultBranch: string): Promise<boolean> {
  const r = await run(["git", "-C", root, "show", `origin/${defaultBranch}:.sandcastle/queue.mts`]);
  return r.ok && r.out.includes("hollr-sandcastle");
}

async function projectAt(dir: string): Promise<Project | undefined> {
  const git = await run(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  const [gitDir, gitCommonDir] = git.out.trim().split("\n");
  // worktrees have their own git dir next to the shared one: only main checkouts count
  if (!git.ok || !gitDir || gitDir !== gitCommonDir) return undefined;
  const id = createHash("sha1").update(gitCommonDir).digest("hex").slice(0, 12);
  let cfg: Config;
  try {
    cfg = JSON.parse(readFileSync(join(dir, ".lul-workr.json"), "utf8"));
  } catch {
    return broken(id, dir, gitCommonDir, ".lul-workr.json ist kein gültiges JSON");
  }
  const slug = str(cfg.repo?.slug);
  if (!slug) return broken(id, dir, gitCommonDir, ".lul-workr.json: repo.slug fehlt");
  const defaultBranch = str(cfg.repo?.defaultBranch) ?? "main";
  const parallel = cfg.engine?.sandcastle?.defaults?.parallel;
  return {
    id,
    name: str(cfg.project) ?? basename(dir),
    root: dir,
    gitCommonDir,
    slug,
    defaultBranch,
    engine: str(cfg.engine?.kind) ?? "implement",
    labels: {
      queue: str(cfg.github?.labels?.queue) ?? "Sandcastle",
      story: str(cfg.github?.labels?.story) ?? "story",
      grill: str(cfg.github?.labels?.grillTicket) ?? null,
    },
    defaults: {
      agent: str(cfg.engine?.sandcastle?.defaults?.agent) ?? "opus-5.5",
      parallel: typeof parallel === "number" && Number.isInteger(parallel) && parallel >= 1 ? parallel : 1,
    },
    queueSupported: await measureQueueSupport(dir, defaultBranch),
    jiraBaseUrl: str(cfg.jira?.baseUrl)?.replace(/\/+$/, "") ?? null,
  };
}

function broken(id: string, dir: string, gitCommonDir: string, error: string): Project {
  return {
    id,
    name: basename(dir),
    root: dir,
    gitCommonDir,
    slug: "",
    defaultBranch: "main",
    engine: "implement",
    labels: { queue: "Sandcastle", story: "story", grill: null },
    defaults: { agent: "opus-5.5", parallel: 1 },
    queueSupported: false,
    jiraBaseUrl: null,
    error,
  };
}

async function discover(): Promise<Project[]> {
  const home = process.env.HOME ?? homedir();
  // permission errors make find exit 1 – what it printed still counts
  const found = await run(
    [
      "find", home, "-maxdepth", "5", "-name", ".lul-workr.json",
      "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.herdr/*",
      "-not", "-path", "*/.sandcastle/*", "-not", "-path", "*/Library/*",
    ],
    { timeoutMs: 120_000 },
  );
  const dirs = found.out.split("\n").filter(Boolean).map((f) => dirname(f));
  const projects = (await Promise.all(dirs.map(projectAt))).filter((p): p is Project => !!p);
  return projects.sort((a, b) => a.name.localeCompare(b.name, "de"));
}

let memo: { at: number; projects: Project[] } | undefined;

export async function loadProjects(stateDir: string, refresh = false): Promise<Project[]> {
  const file = join(stateDir, "projects.json");
  if (!memo && !refresh) {
    try {
      memo = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }
  if (!refresh && memo && Date.now() - memo.at < TTL) return memo.projects;
  memo = { at: Date.now(), projects: await discover() };
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(memo));
  renameSync(tmp, file);
  return memo.projects;
}

export async function getProject(stateDir: string, id: string): Promise<Project> {
  const p = (await loadProjects(stateDir)).find((x) => x.id === id);
  if (!p) throw new HttpError(404, "Projekt nicht gefunden.");
  if (p.error) throw new HttpError(400, p.error);
  return p;
}
