/**
 * `hollr gate sandcastle` setup ops (board „Maschine wechseln“): bring a lul-workr project onto this machine so
 * its Sandcastle queue can move here – clone it, take the untracked local files the source machine sends
 * (`.lul-workr.json`, `.env`, `.sandcastle/.env`, nothing else), install its dependencies, and say in a checklist
 * what a run here still lacks. The central `~/.config/sandcastle.env` is only reported, never read or written.
 *
 * File contents travel source gate (stdout) → board → target gate (stdin) only: the gate logs op and slug, never
 * a request body, and no error message here quotes a file's content.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  type Deps,
  measureQueueSupport,
  type ProjectCache,
  projectCache,
  run,
  type SandcastleRequest,
  stateDir,
} from "./sandcastle";
import { tail, toolPathDirs, which } from "./tools";

/** The only files setup copies: untracked, per checkout, needed by a run. */
export const SETUP_FILES = [".lul-workr.json", ".env", ".sandcastle/.env"] as const;
export type SetupFile = (typeof SETUP_FILES)[number];
/** Env files: secrets by nature – written with mode 600. */
const ENV_FILES: Record<string, true> = { ".env": true, ".sandcastle/.env": true };
const MAX_FILE = 64 * 1024;
const CENTRAL_ENV = [".config", "sandcastle.env"];

export interface SetupDeps extends Deps {
  /** absolute path of a command on this machine (default: the login-shell dirs, Docker's, nvm's); tests fake it */
  bin?: (name: string) => string | undefined;
}

export interface SetupJob {
  kind: "clone" | "install";
  running: boolean;
  /** exit code once finished */
  exit: number | null;
  /** last lines of its log (ANSI stripped) */
  log: string | null;
  startedAt: string | null;
}

export interface CheckItem {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /** the board's action that fixes it, null = none (fixed on the machine itself) */
  fix: "clone" | "files" | "install" | null;
  /** only a hint: missing it never stops the move (the central sandcastle.env) */
  hint: boolean;
}

export interface SetupFileInfo {
  path: SetupFile;
  exists: boolean;
  size: number;
  /** an env file with values, or a JSON with secret-looking keys */
  secret: boolean;
  /** names of secret-looking keys (never their values) */
  keys: string[];
}

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────

const home = () => Bun.env.HOME ?? "";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const machine = () => hostname().replace(/\.local$/, "");
const tilde = (p: string) => (home() && p.startsWith(`${home()}/`) ? `~${p.slice(home().length)}` : p);
const first = (s: string) => s.trim().split("\n")[0]?.trim() ?? "";

/** Dirs beyond the login shell's where Docker Desktop, OrbStack and node managers put their binaries. */
function extraDirs(): string[] {
  const h = home();
  const nvm = join(h, ".nvm", "versions", "node");
  let nvmBin: string[] = [];
  try {
    const versions = readdirSync(nvm).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    const newest = versions.at(-1);
    nvmBin = newest ? [join(nvm, newest, "bin")] : [];
  } catch {}
  return [
    join(h, ".docker", "bin"),
    "/Applications/Docker.app/Contents/Resources/bin",
    join(h, ".orbstack", "bin"),
    join(h, ".volta", "bin"),
    ...nvmBin,
  ];
}

function defaultBin(name: string): string | undefined {
  return which(name) ?? extraDirs().find((d) => existsSync(join(d, name)))?.concat(`/${name}`);
}

const binOf = (deps: SetupDeps) => deps.bin ?? defaultBin;

function jobEnv(): Record<string, string | undefined> {
  // what installers use, then the extra dirs, then the gate's own PATH
  const path = [...toolPathDirs(), ...extraDirs(), Bun.env.PATH ?? ""].join(":");
  const env: Record<string, string | undefined> = { ...Bun.env, PATH: path };
  delete env.BUN_BE_BUN;
  delete env.SSH_ORIGINAL_COMMAND;
  // a clone or install never waits for a password prompt nobody sees
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  return env;
}

// ── validation ─────────────────────────────────────────────────────────────────────────────────────

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** owner/repo as GitHub allows it; never `.`/`..` or a `.git` suffix (it becomes a folder name). */
export function validSlug(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  const repo = s.split("/")[1] ?? "";
  if (!SLUG_RE.test(s) || repo === "." || repo === ".." || repo.toLowerCase().endsWith(".git"))
    throw new Error(`Ungültiger Repo-Name „${s.slice(0, 80)}“ (erwartet owner/repo).`);
  return s;
}

function setupFile(v: unknown): SetupFile {
  if (typeof v === "string" && (SETUP_FILES as readonly string[]).includes(v)) return v as SetupFile;
  throw new Error(
    `Datei „${String(v).slice(0, 80)}“ wird nicht kopiert (nur ${SETUP_FILES.join(", ")}).`,
  );
}

/** `<root>/<file>`, refusing a symlink anywhere below the root (it could point outside the checkout). */
function insideRoot(root: string, file: SetupFile): string {
  const abs = join(root, file);
  if (relative(root, abs).startsWith("..")) throw new Error(`${file} liegt außerhalb des Projekts.`);
  let cur = root;
  for (const part of file.split("/")) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink())
        throw new Error(`${tilde(cur)} ist ein symbolischer Link – nicht angefasst.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
  }
  return abs;
}

// ── where the project lives ────────────────────────────────────────────────────────────────────────

/** The folder this machine keeps its projects in: the most common parent of its checkouts, else ~/projects. */
export function projectsParent(roots: string[], homeDir: string): string {
  const count = new Map<string, number>();
  for (const r of roots) count.set(dirname(r), (count.get(dirname(r)) ?? 0) + 1);
  const best = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best?.[0] ?? join(homeDir, "projects");
}

/** owner/repo of a GitHub remote URL (https, ssh or scp form), lower-cased; null for other hosts. */
export function slugOfRemote(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return m?.[1]?.toLowerCase() ?? null;
}

async function isCheckoutOf(dir: string, slug: string): Promise<boolean> {
  if (!existsSync(join(dir, ".git"))) return false;
  const git = await run([
    "git",
    "-C",
    dir,
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  const [gitDir, common] = git.out.trim().split("\n");
  if (!git.ok || !gitDir || gitDir !== common) return false;
  const origin = await run(["git", "-C", dir, "remote", "get-url", "origin"]);
  return origin.ok && slugOfRemote(origin.out) === slug.toLowerCase();
}

interface Place {
  /** the checkout, null while there is none */
  root: string | null;
  /** where a clone goes (= root once cloned there) */
  path: string;
  /** the project scan knows it (it has its `.lul-workr.json`) */
  known: boolean;
}

async function placeOf(cache: ProjectCache, slug: string): Promise<Place> {
  const lower = slug.toLowerCase();
  const known =
    cache.projects.find((p) => p.slug.toLowerCase() === lower && !p.error)?.root ??
    cache.checkouts.find((c) => c.slug.toLowerCase() === lower)?.root;
  if (known) return { root: known, path: known, known: true };
  const roots = cache.checkouts.length
    ? cache.checkouts.map((c) => c.root)
    : cache.projects.map((p) => p.root);
  const path = join(projectsParent(roots, home()), slug.split("/")[1] ?? "");
  return { root: (await isCheckoutOf(path, slug)) ? path : null, path, known: false };
}

async function rootOf(cache: ProjectCache, slug: string): Promise<string> {
  const { root } = await placeOf(cache, slug);
  if (!root) throw new Error(`${slug} ist auf ${machine()} nicht geklont.`);
  return root;
}

// ── secrets (names only) ───────────────────────────────────────────────────────────────────────────

const SECRET_KEY = /token|secret|passw|pwd|api[_-]?key|private|credential|auth|cookie|session/i;

/**
 * Whether a file carries secrets and the names of its secret-looking keys (pure). An env file with any value
 * counts as secret; a URL with user:password@ names its key too.
 */
export function secretsOf(file: SetupFile, content: string): { secret: boolean; keys: string[] } {
  const keys: string[] = [];
  if (ENV_FILES[file]) {
    let values = false;
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m?.[1]) continue;
      const value = (m[2] ?? "").replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2").trim();
      if (!value) continue;
      values = true;
      if (SECRET_KEY.test(m[1]) || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value)) keys.push(m[1]);
    }
    return { secret: values, keys };
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { secret: false, keys };
  }
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v))
      for (const [i, x] of v.entries()) walk(x, `${path}[${i}]`);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        if (typeof x === "string" && x.trim() && SECRET_KEY.test(k)) keys.push(p);
        else walk(x, p);
      }
  };
  walk(data, "");
  return { secret: keys.length > 0, keys };
}

function fileInfo(root: string | null, file: SetupFile): SetupFileInfo {
  const none: SetupFileInfo = { path: file, exists: false, size: 0, secret: false, keys: [] };
  if (!root) return none;
  const abs = insideRoot(root, file);
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return none;
    size = st.size;
  } catch {
    return none;
  }
  const content = size <= MAX_FILE ? readFileSync(abs, "utf8") : "";
  return { path: file, exists: true, size, ...secretsOf(file, content) };
}

// ── jobs (clone, install): detached with a log, like the tools ─────────────────────────────────────

const jobBase = (slug: string, kind: SetupJob["kind"]) =>
  join(stateDir(), "setup", `${sha1(slug.toLowerCase()).slice(0, 12)}-${kind}`);

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function jobState(slug: string, kind: SetupJob["kind"]): SetupJob | null {
  const base = jobBase(slug, kind);
  let meta: { pid?: number; startedAt?: string };
  try {
    meta = JSON.parse(readFileSync(`${base}.json`, "utf8"));
  } catch {
    return null;
  }
  let exit: number | null = null;
  try {
    exit = Number(readFileSync(`${base}.exit`, "utf8").trim());
  } catch {}
  const running = exit === null && !!meta.pid && alive(meta.pid);
  return {
    kind,
    running,
    // gone without an exit code: killed (reboot, OOM)
    exit: exit ?? (running ? null : -1),
    log: tail(`${base}.log`, 20) ?? null,
    startedAt: meta.startedAt ?? null,
  };
}

function startJob(slug: string, kind: SetupJob["kind"], argv: string[], cwd: string): SetupJob {
  if (jobState(slug, kind)?.running)
    throw new Error(kind === "clone" ? "Wird schon geklont." : "Die Installation läuft schon.");
  const base = jobBase(slug, kind);
  mkdirSync(dirname(base), { recursive: true });
  rmSync(`${base}.exit`, { force: true });
  writeFileSync(`${base}.log`, "");
  const script = `cd ${quote(cwd)} && ( ${argv.map(quote).join(" ")} ) > ${quote(`${base}.log`)} 2>&1 < /dev/null\necho $? > ${quote(`${base}.exit`)}\n`;
  // own session so it survives the SSH channel closing (macOS has no setsid binary: perl's POSIX::setsid)
  const detach = which("setsid")
    ? ["setsid"]
    : ["perl", "-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV"];
  const proc = Bun.spawn([...detach, "sh", "-c", script], {
    env: jobEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  writeFileSync(
    `${base}.json`,
    JSON.stringify({ pid: proc.pid, startedAt: new Date().toISOString() }),
  );
  proc.unref();
  return jobState(slug, kind) as SetupJob;
}

// ── package manager ────────────────────────────────────────────────────────────────────────────────

export interface PackageManager {
  name: "yarn" | "pnpm" | "npm" | "bun";
  lockfile: string | null;
  /** from package.json `packageManager` (yarn@4.12.0) */
  version: string | null;
  /** yarn ≥ 2 (berry): `--immutable` instead of `--frozen-lockfile` */
  berry: boolean;
}

const LOCKFILES: [string, PackageManager["name"]][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** What the lockfile implies (pure but for reading root); null without a package.json. */
export function packageManagerOf(root: string): PackageManager | null {
  let pkg: { packageManager?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const declared =
    typeof pkg.packageManager === "string"
      ? pkg.packageManager.match(/^(yarn|pnpm|npm|bun)@(\d[\w.+-]*)/)
      : null;
  const lock = LOCKFILES.find(([f]) => existsSync(join(root, f)));
  const name = lock?.[1] ?? (declared?.[1] as PackageManager["name"] | undefined) ?? "npm";
  const version = declared?.[1] === name ? (declared[2] ?? null) : null;
  const berry =
    name === "yarn" &&
    (Number(version?.split(".")[0] ?? 1) >= 2 || existsSync(join(root, ".yarnrc.yml")));
  return { name, lockfile: lock?.[0] ?? null, version, berry };
}

function installArgv(pm: PackageManager, bin: (n: string) => string | undefined): string[] {
  const args =
    pm.name === "yarn"
      ? ["install", pm.berry ? "--immutable" : "--frozen-lockfile"]
      : pm.name === "pnpm"
        ? ["install", "--frozen-lockfile"]
        : pm.name === "bun"
          ? ["install", "--frozen-lockfile"]
          : [pm.lockfile ? "ci" : "install"];
  const direct = bin(pm.name);
  if (direct) return [direct, ...args];
  const corepack = (pm.name === "yarn" || pm.name === "pnpm") && bin("corepack");
  if (corepack) return [corepack, pm.name, ...args];
  throw new Error(`${pm.name} ist auf ${machine()} nicht installiert.`);
}

// ── checks ─────────────────────────────────────────────────────────────────────────────────────────

async function version(
  bin: string | undefined,
  args: string[],
  cwd?: string,
): Promise<string | null> {
  if (!bin) return null;
  const r = await run([bin, ...args], { cwd, timeoutMs: 15_000, env: jobEnv() });
  // the version number alone (`omp/19.1.1`, `v22.17.1`, `Docker version 27…` → 19.1.1, 22.17.1, 27…)
  const text = first(r.out || r.err);
  return r.ok ? (text.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? (text || "installiert")) : null;
}

const item = (
  id: string,
  label: string,
  ok: boolean,
  detail: string,
  fix: CheckItem["fix"] = null,
): CheckItem => ({ id, label, ok, detail, fix, hint: false });

interface Cfg {
  repo?: { slug?: unknown; defaultBranch?: unknown };
  engine?: { sandcastle?: { defaults?: { agent?: unknown }; agents?: unknown } };
}

function readCfg(root: string | null): { cfg: Cfg | null; error: string | null } {
  if (!root) return { cfg: null, error: "fehlt" };
  let text: string;
  try {
    text = readFileSync(insideRoot(root, ".lul-workr.json"), "utf8");
  } catch {
    return { cfg: null, error: "fehlt" };
  }
  try {
    return { cfg: JSON.parse(text) as Cfg, error: null };
  } catch {
    return { cfg: null, error: "kein gültiges JSON" };
  }
}

/** The default agent and what runs it: presets run Claude Code or Cursor inside the Sandcastle container. */
function agentNote(cfg: Cfg | null): { agent: string; harness: string } {
  const sc = cfg?.engine?.sandcastle;
  const agent = typeof sc?.defaults?.agent === "string" ? sc.defaults.agent : "opus-5.5";
  const listed = Array.isArray(sc?.agents)
    ? (sc.agents as { key?: unknown; harness?: unknown }[]).find((a) => a?.key === agent)
    : undefined;
  const harness =
    typeof listed?.harness === "string"
      ? listed.harness
      : agent.startsWith("cursor-")
        ? "cursor"
        : "claudeCode";
  return { agent, harness };
}

async function checklist(
  slug: string,
  place: Place,
  expect: SetupFile[],
  deps: SetupDeps,
): Promise<CheckItem[]> {
  const bin = binOf(deps);
  const root = place.root;
  const { cfg, error: cfgError } = readCfg(root);
  const pm = root ? packageManagerOf(root) : null;
  const install = jobState(slug, "install");
  const clone = jobState(slug, "clone");
  const defaultBranch =
    typeof cfg?.repo?.defaultBranch === "string" ? cfg.repo.defaultBranch : "main";
  const ghBin = bin("gh");
  const pmDirect = pm ? bin(pm.name) : undefined;
  const pmCorepack = pm?.name === "yarn" || pm?.name === "pnpm" ? bin("corepack") : undefined;
  const [docker, gh, node, pmVersion, omp, queue] = await Promise.all([
    version(bin("docker"), ["info", "--format", "{{.ServerVersion}}"]),
    ghBin
      ? run([ghBin, "auth", "status", "--hostname", "github.com"], {
          timeoutMs: 15_000,
          env: jobEnv(),
        })
      : null,
    version(bin("node"), ["--version"]),
    pm && root
      ? version(pmDirect ?? pmCorepack, pmDirect ? ["--version"] : [pm.name, "--version"], root)
      : null,
    version(bin("omp"), ["--version"]),
    root ? measureQueueSupport(root, defaultBranch) : false,
  ]);
  const items: CheckItem[] = [];
  items.push(
    root
      ? item("checkout", "Projekt geklont", true, tilde(root))
      : item(
          "checkout",
          "Projekt geklont",
          false,
          clone?.running
            ? `wird nach ${tilde(place.path)} geklont …`
            : `fehlt – Ziel ${tilde(place.path)}`,
          clone?.running ? null : "clone",
        ),
  );
  items.push(
    item(
      "docker",
      "Docker läuft",
      !!docker,
      docker
        ? `Server ${docker}`
        : bin("docker")
          ? "Docker ist installiert, läuft aber nicht"
          : "Docker ist nicht installiert",
    ),
  );
  const account = gh ? `${gh.out}\n${gh.err}`.match(/account (\S+)|as (\S+)/) : null;
  items.push(
    item(
      "gh",
      "GitHub CLI angemeldet",
      !!gh?.ok,
      !ghBin
        ? "gh ist nicht installiert"
        : gh?.ok
          ? `angemeldet${account ? ` als ${account[1] ?? account[2]}` : ""}`
          : "nicht angemeldet – auf dem Rechner `gh auth login`",
    ),
  );
  let nvmrc: string | null = null;
  try {
    nvmrc = root ? readFileSync(join(root, ".nvmrc"), "utf8").trim() || null : null;
  } catch {}
  items.push(
    item(
      "node",
      "Node",
      !!node,
      node ? `${node}${nvmrc ? ` (.nvmrc: ${nvmrc})` : ""}` : "Node ist nicht installiert",
    ),
  );
  if (!root) items.push(item("pm", "Paketmanager", false, "nach dem Klonen"));
  else if (!pm) items.push(item("pm", "Paketmanager", true, "kein package.json – nicht nötig"));
  else
    items.push(
      item(
        "pm",
        "Paketmanager",
        !!pmVersion,
        `${pm.name}${pmVersion ? ` ${pmVersion}` : pm.version ? ` ${pm.version}` : ""} (${pm.lockfile ?? "package.json"})${pmVersion ? "" : " – nicht installiert"}`,
      ),
    );
  const { agent, harness } = agentNote(cfg);
  items.push(
    item(
      "agent",
      "Agent-CLI",
      !!omp,
      `${omp ? `omp ${omp}` : "omp fehlt"} (Lauf-Sitzung)${harness === "omp" ? "" : ` · ${agent} läuft im Sandcastle-Container (${harness})`}`,
    ),
  );
  if (!root) items.push(item("deps", "Abhängigkeiten installiert", false, "nach dem Klonen"));
  else if (!pm) items.push(item("deps", "Abhängigkeiten installiert", true, "nicht nötig"));
  else if (install?.running)
    items.push(item("deps", "Abhängigkeiten installiert", false, "wird installiert …"));
  else {
    const installed = existsSync(join(root, "node_modules"));
    const failed = install && install.exit !== 0 && install.exit !== null;
    items.push(
      item(
        "deps",
        "Abhängigkeiten installiert",
        installed && !failed,
        failed
          ? `Installation fehlgeschlagen (Exit ${install.exit})`
          : installed
            ? "node_modules vorhanden"
            : "node_modules fehlt",
        "install",
      ),
    );
  }
  for (const f of expect) {
    const info = fileInfo(root, f);
    const bad = f === ".lul-workr.json" && info.exists && cfgError;
    const wrong =
      f === ".lul-workr.json" &&
      cfg &&
      typeof cfg.repo?.slug === "string" &&
      cfg.repo.slug.toLowerCase() !== slug.toLowerCase();
    items.push(
      item(
        `file:${f}`,
        f,
        info.exists && !bad && !wrong,
        bad
          ? cfgError
          : wrong
            ? `gehört zu ${String(cfg?.repo?.slug)}`
            : info.exists
              ? `vorhanden (${info.size} B)`
              : "fehlt",
        "files",
      ),
    );
  }
  const central = existsSync(join(home(), ...CENTRAL_ENV));
  // report only: each machine keeps its own, setup never reads or writes it
  items.push({
    ...item(
      "central",
      "~/.config/sandcastle.env",
      central,
      central ? "vorhanden (wird nie kopiert)" : "fehlt – auf dem Rechner anlegen, wird nie kopiert",
    ),
    hint: true,
  });
  items.push(
    item(
      "queue",
      "Schleife kennt die Warteschlange",
      queue,
      !root
        ? "nach dem Klonen"
        : queue
          ? `origin/${defaultBranch}: .sandcastle/queue.mts`
          : `nicht auf origin/${defaultBranch} – lul-workr-setup → Sandcastle nachziehen`,
    ),
  );
  return items;
}

// ── ops ────────────────────────────────────────────────────────────────────────────────────────────

function expectedFiles(v: unknown): SetupFile[] {
  if (v === undefined) return [...SETUP_FILES];
  if (!Array.isArray(v)) throw new Error("expect muss eine Liste von Dateien sein.");
  return [...new Set(v.map(setupFile))];
}

/** `setup-check`: where the project is (or goes) on this machine, the checklist and the clone/install jobs. */
async function setupCheck(req: SandcastleRequest, deps: SetupDeps) {
  const slug = validSlug(req.slug);
  // jobs first: a job reported finished has its result (the clone, node_modules) in what is read after it
  const jobs = { clone: jobState(slug, "clone"), install: jobState(slug, "install") };
  const place = await placeOf(await projectCache(deps), slug);
  const items = await checklist(slug, place, expectedFiles(req.expect), deps);
  return {
    host: machine(),
    slug,
    path: place.root ?? place.path,
    cloned: !!place.root,
    known: place.known,
    pm: place.root ? packageManagerOf(place.root) : null,
    items,
    jobs,
  };
}

/**
 * How this machine reaches GitHub: the protocol most of its checkouts' `origin` use. A clone must fetch and push
 * later without a prompt – an https clone on a machine that only has an SSH key fails at its first fetch.
 */
async function usesSsh(cache: ProjectCache): Promise<boolean> {
  const roots = cache.checkouts.length ? cache.checkouts.map((c) => c.root) : cache.projects.map((p) => p.root);
  const urls = await Promise.all(roots.map((r) => run(["git", "-C", r, "remote", "get-url", "origin"])));
  const ssh = urls.filter((u) => u.ok && /^(git@|ssh:\/\/)/.test(u.out.trim())).length;
  return ssh > urls.filter((u) => u.ok).length / 2;
}

/**
 * `setup-clone`: clone into the projects folder (default branch); never over an existing path. Over SSH when the
 * machine's checkouts use SSH, else `gh repo clone` with gh as the checkout's credential helper.
 */
async function setupClone(req: SandcastleRequest, deps: SetupDeps) {
  const slug = validSlug(req.slug);
  const cache = await projectCache(deps);
  const place = await placeOf(cache, slug);
  if (place.known) throw new Error(`${slug} ist auf ${machine()} schon ausgecheckt: ${tilde(place.path)}`);
  if (jobState(slug, "clone")?.running) throw new Error("Wird schon geklont.");
  if (existsSync(place.path))
    throw new Error(`Ordner ${tilde(place.path)} gibt es schon – nicht überschrieben.`);
  mkdirSync(dirname(place.path), { recursive: true });
  if (await usesSsh(cache)) {
    const git = binOf(deps)("git") ?? "git";
    const job = startJob(slug, "clone", [git, "clone", `git@github.com:${slug}.git`, place.path], dirname(place.path));
    return { path: place.path, job };
  }
  const gh = binOf(deps)("gh");
  if (!gh) throw new Error(`gh ist auf ${machine()} nicht installiert.`);
  const script = '"$1" repo clone "$2" "$3" && git -C "$3" config --local credential.https://github.com.helper "!$1 auth git-credential"';
  const job = startJob(slug, "clone", ["sh", "-c", script, "sh", gh, slug, place.path], dirname(place.path));
  return { path: place.path, job };
}

/** `setup-files`: which of the whitelisted files this checkout has – size and secret key names, no content. */
async function setupFiles(req: SandcastleRequest, deps: SetupDeps) {
  const slug = validSlug(req.slug);
  const { root } = await placeOf(await projectCache(deps), slug);
  return { host: machine(), root, files: SETUP_FILES.map((f) => fileInfo(root, f)) };
}

/** `setup-files-read` (source machine): the contents of the asked whitelisted files. */
async function setupFilesRead(req: SandcastleRequest, deps: SetupDeps) {
  const slug = validSlug(req.slug);
  if (!Array.isArray(req.paths) || !req.paths.length)
    throw new Error("paths muss eine nicht leere Liste sein.");
  const files = [...new Set(req.paths.map(setupFile))];
  const root = await rootOf(await projectCache(deps), slug);
  return {
    files: files.map((f) => {
      const abs = insideRoot(root, f);
      let st: Stats;
      try {
        st = statSync(abs);
      } catch {
        throw new Error(`${f} gibt es auf ${machine()} nicht.`);
      }
      if (!st.isFile()) throw new Error(`${f} ist keine Datei.`);
      if (st.size > MAX_FILE) throw new Error(`${f} ist größer als 64 KiB – nicht kopiert.`);
      return { path: f, content: readFileSync(abs, "utf8") };
    }),
  };
}

/**
 * `setup-files-write` (target machine): writes the files into the checkout – env files with mode 600, the
 * config 644; an existing file only with `overwrite`. Everything is checked before the first write.
 */
async function setupFilesWrite(req: SandcastleRequest, deps: SetupDeps) {
  const slug = validSlug(req.slug);
  if (!Array.isArray(req.files) || !req.files.length)
    throw new Error("files muss eine nicht leere Liste sein.");
  const root = await rootOf(await projectCache(deps), slug);
  const seen = new Set<SetupFile>();
  const planned = req.files.map((raw: unknown) => {
    const f = raw as { path?: unknown; content?: unknown };
    const path = setupFile(f?.path);
    if (seen.has(path)) throw new Error(`${path} steht doppelt in der Liste.`);
    seen.add(path);
    if (typeof f.content !== "string") throw new Error(`${path}: Inhalt fehlt.`);
    if (Buffer.byteLength(f.content) > MAX_FILE)
      throw new Error(`${path} ist größer als 64 KiB – nicht geschrieben.`);
    if (path === ".lul-workr.json") {
      let cfg: Cfg;
      try {
        cfg = JSON.parse(f.content) as Cfg;
      } catch {
        throw new Error(".lul-workr.json ist kein gültiges JSON – nicht geschrieben.");
      }
      const own = typeof cfg?.repo?.slug === "string" ? cfg.repo.slug : "";
      if (own.toLowerCase() !== slug.toLowerCase())
        throw new Error(`.lul-workr.json gehört zu ${own || "keinem Repo"}, nicht zu ${slug}.`);
    }
    const abs = insideRoot(root, path);
    if (existsSync(abs) && req.overwrite !== true)
      throw new Error(`${path} gibt es auf ${machine()} schon – nicht überschrieben.`);
    return { path, abs, content: f.content, mode: ENV_FILES[path] ? 0o600 : 0o644 };
  });
  for (const p of planned) {
    mkdirSync(dirname(p.abs), { recursive: true });
    const tmp = `${p.abs}.${process.pid}.tmp`;
    writeFileSync(tmp, p.content, { mode: p.mode });
    // the umask may have taken bits away – and an older tmp may have had other ones
    chmodSync(tmp, p.mode);
    renameSync(tmp, p.abs);
  }
  return {
    written: planned.map((p) => ({ path: p.path, size: Buffer.byteLength(p.content), mode: p.mode.toString(8) })),
  };
}

/** `setup-install`: the lockfile's package manager installs, detached with a log (`setup-check` reports it). */
async function setupInstall(req: SandcastleRequest, deps: SetupDeps) {
  const slug = validSlug(req.slug);
  const root = await rootOf(await projectCache(deps), slug);
  const pm = packageManagerOf(root);
  if (!pm) throw new Error("Kein package.json – nichts zu installieren.");
  if (jobState(slug, "install")?.running) throw new Error("Die Installation läuft schon.");
  return { pm, job: startJob(slug, "install", installArgv(pm, binOf(deps)), root) };
}

export const SETUP_OPS = [
  "setup-check",
  "setup-clone",
  "setup-files",
  "setup-files-read",
  "setup-files-write",
  "setup-install",
] as const;

export async function sandcastleSetup(req: SandcastleRequest, deps: SetupDeps = {}): Promise<unknown> {
  switch (req.op) {
    case "setup-check":
      return setupCheck(req, deps);
    case "setup-clone":
      return setupClone(req, deps);
    case "setup-files":
      return setupFiles(req, deps);
    case "setup-files-read":
      return setupFilesRead(req, deps);
    case "setup-files-write":
      return setupFilesWrite(req, deps);
    case "setup-install":
      return setupInstall(req, deps);
    default:
      throw new Error(`Unbekannte Operation „${String(req.op ?? "")}“.`);
  }
}
