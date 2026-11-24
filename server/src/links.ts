/**
 * Gate `links`: what ticket keys and issue numbers in a pane's terminal and chat point at. The clients turn
 * `TENDR-1037` (keys of `jira.projectKey`) and `#3575` (issues of the GitHub repo) into links; this answers
 * which repo and which JIRA site that pane's folder belongs to. Read-only; cached per folder for 10 min in
 * the state dir (every gate call is a fresh process).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Exec } from "./herdr";
import { stateDir } from "./hiddenspaces";

export interface Links {
  /** GitHub `owner/name` of `origin`; null: no git folder or not on github.com */
  repo: string | null;
  /** JIRA site and project key(s) from `.lul-workr.json`; null: no config or no key */
  jira: { baseUrl: string; keys: string[] } | null;
}

const TTL_MS = 10 * 60_000;
const NONE: Links = { repo: null, jira: null };
const cacheFile = () => join(stateDir(), "links.json");

type Cache = Record<string, { at: number; links: Links }>;

/** `owner/name` of a github.com remote (https, with or without credentials, scp-style or ssh:// URL). */
export function githubSlug(url: string): string | null {
  const m = url
    .trim()
    .match(
      /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com(?::\d+)?[:/])([A-Za-z0-9][A-Za-z0-9-]*)\/([\w.-]+?)(?:\.git)?\/?$/i,
    );
  if (!m?.[1] || !m[2] || m[2].startsWith(".")) return null;
  return `${m[1]}/${m[2]}`;
}

function git(cwd: string, ...args: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

/** `jira` of a `.lul-workr.json` in `dir`; null if missing, unreadable, or without baseUrl or project key. */
function jiraIn(dir: string): Links["jira"] | undefined {
  let cfg: { jira?: { baseUrl?: unknown; projectKey?: unknown } };
  try {
    cfg = JSON.parse(readFileSync(join(dir, ".lul-workr.json"), "utf8"));
  } catch {
    return undefined;
  }
  const base = cfg.jira?.baseUrl;
  const key = cfg.jira?.projectKey;
  if (typeof base !== "string" || !/^https?:\/\//.test(base.trim())) return null;
  if (typeof key !== "string" || !/^[A-Z][A-Z0-9]+$/.test(key.trim())) return null;
  return { baseUrl: base.trim().replace(/\/+$/, ""), keys: [key.trim()] };
}

/** Links of a folder, uncached: origin's GitHub slug, and the JIRA config of the checkout or its main checkout. */
export function readLinks(cwd: string): Links {
  if (!cwd) return NONE;
  const lines = git(
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  );
  if (!lines) return NONE;
  const [top = "", common = ""] = lines.split("\n");
  const url = git(cwd, "remote", "get-url", "origin");
  const repo = url ? githubSlug(url) : null;
  // a worktree has no config of its own (it's untracked): the main checkout holds it
  let jira = top ? jiraIn(top) : undefined;
  if (jira === undefined && basename(common) === ".git") {
    const main = dirname(common);
    if (main !== top) jira = jiraIn(main);
  }
  return { repo, jira: jira ?? null };
}

function loadCache(): Cache {
  try {
    const c = JSON.parse(readFileSync(cacheFile(), "utf8"));
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}

/** Links of a folder, from the cache when younger than 10 min. */
export function linksForCwd(cwd: string, now = Date.now()): Links {
  const cache = loadCache();
  const hit = cache[cwd];
  if (hit && now - hit.at < TTL_MS && now >= hit.at) return hit.links;
  const links = readLinks(cwd);
  const next: Cache = { [cwd]: { at: now, links } };
  for (const [k, v] of Object.entries(cache)) if (k !== cwd && now - v.at < TTL_MS) next[k] = v;
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${cacheFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, cacheFile());
  } catch {}
  return links;
}

/** The pane's folder: where its shell or agent currently is (`foreground_cwd`), else where it started. */
export async function paneCwd(exec: Exec, pane: string): Promise<string> {
  const res = (await exec(["pane", "list"])) as { panes?: Array<Record<string, unknown>> };
  const p = (res.panes ?? []).find((x) => x.pane_id === pane);
  for (const v of [p?.foreground_cwd, p?.cwd]) if (typeof v === "string" && v) return v;
  return "";
}
