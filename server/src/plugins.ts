/**
 * Plugins: a folder with `hollr-plugin.json` and a Bun script that serves its own web UI on 127.0.0.1.
 * Linked by hand (`hollr plugin link <dir>`), recorded in ~/.config/hollr/plugins.json, started on demand
 * by the gate (`plugins` open) as a detached process – the compiled hollr runs it like bun (BUN_BE_BUN=1),
 * so the server needs neither bun nor node. The apps reach it through their SSH tunnel; every /api call
 * needs the per-start token, which only travels in the URL fragment.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { toolPathDirs, which } from "./tools";

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  entry: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  error?: string;
}

interface RegistryEntry {
  id: string;
  dir: string;
}

interface ServerState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

const ID_RE = /^[a-z0-9-]{1,40}$/;
const MANIFEST = "hollr-plugin.json";

export const pluginsFile = () => Bun.env.HOLLR_PLUGINS_FILE ?? join(homedir(), ".config", "hollr", "plugins.json");
const stateDir = (id: string) =>
  join(Bun.env.HOLLR_STATE_DIR ?? join(homedir(), ".local", "state", "hollr"), "plugins", id);

export function loadRegistry(file = pluginsFile()): RegistryEntry[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { plugins?: unknown };
    return Array.isArray(data.plugins)
      ? data.plugins.filter(
          (e): e is RegistryEntry => typeof e?.id === "string" && ID_RE.test(e.id) && typeof e?.dir === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** Written whole and renamed into place: gate calls run in parallel and must never read half a file. */
function saveRegistry(list: RegistryEntry[], file = pluginsFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ plugins: list }, null, 1)}\n`);
  renameSync(tmp, file);
}

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function readManifest(dir: string): PluginManifest {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) throw new Error(`${MANIFEST} fehlt in ${dir}`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`${MANIFEST} ist kein gültiges JSON`);
  }
  if (typeof raw?.id !== "string" || !ID_RE.test(raw.id))
    throw new Error(`${MANIFEST}: id muss aus a-z, 0-9 und - bestehen (höchstens 40 Zeichen)`);
  if (!nonEmpty(raw.name)) throw new Error(`${MANIFEST}: name fehlt`);
  if (!nonEmpty(raw.version)) throw new Error(`${MANIFEST}: version fehlt`);
  const entry = raw.entry;
  if (
    !nonEmpty(entry) ||
    isAbsolute(entry) ||
    entry.split(/[\\/]/).includes("..") ||
    !entry.endsWith(".ts")
  )
    throw new Error(`${MANIFEST}: entry muss ein relativer Pfad zu einer .ts-Datei im Ordner sein`);
  const entryFile = join(dir, entry);
  if (!existsSync(entryFile) || !statSync(entryFile).isFile())
    throw new Error(`${MANIFEST}: entry ${entry} gibt es nicht`);
  return {
    id: raw.id,
    name: raw.name,
    description: nonEmpty(raw.description) ? raw.description : undefined,
    version: raw.version,
    entry,
  };
}

export function linkPlugin(dir: string): PluginManifest {
  const abs = resolve(dir);
  const manifest = readManifest(abs);
  const list = loadRegistry().filter((e) => e.id !== manifest.id);
  saveRegistry([...list, { id: manifest.id, dir: abs }]);
  return manifest;
}

export function unlinkPlugin(id: string): boolean {
  stopPlugin(id);
  const list = loadRegistry();
  const rest = list.filter((e) => e.id !== id);
  if (rest.length === list.length) return false;
  saveRegistry(rest);
  return true;
}

export function listPlugins(): PluginInfo[] {
  return loadRegistry().map(({ id, dir }) => {
    try {
      const m = readManifest(dir);
      return { id: m.id, name: m.name, description: m.description, version: m.version };
    } catch (err) {
      return { id, name: id, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function readState(id: string): ServerState | undefined {
  try {
    const s = JSON.parse(readFileSync(join(stateDir(id), "server.json"), "utf8")) as ServerState;
    return typeof s.pid === "number" && typeof s.port === "number" && typeof s.token === "string"
      ? s
      : undefined;
  } catch {
    return undefined;
  }
}

/** The pid is alive and still runs a file of this plugin (`marker`: its folder or entry; pids get reused). */
function ownsPid(pid: number, marker: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  return ps.stdout.toString().includes(marker);
}

function entryOf(id: string): { dir: string; manifest: PluginManifest } {
  const reg = loadRegistry().find((e) => e.id === id);
  if (!reg) throw new Error(`Plugin ${id} ist nicht verknüpft`);
  return { dir: reg.dir, manifest: readManifest(reg.dir) };
}

/**
 * The running plugin's pid from server.json – checked against the linked folder, not the manifest, so a
 * plugin whose manifest broke while it ran can still be stopped.
 */
export function runningPid(id: string): number | undefined {
  const reg = loadRegistry().find((e) => e.id === id);
  const s = reg && readState(id);
  return reg && s && ownsPid(s.pid, `${reg.dir}/`) ? s.pid : undefined;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__hollr/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

const urlFor = (s: { port: number; token: string }) => ({
  port: s.port,
  url: `http://localhost:${s.port}/#token=${s.token}`,
});

async function alreadyRunning(id: string, entryFile: string) {
  const s = readState(id);
  if (s && ownsPid(s.pid, entryFile) && (await healthy(s.port))) return urlFor(s);
  return undefined;
}

function tailLines(file: string, n: number): string {
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).slice(-n).join("\n");
  } catch {
    return "";
  }
}

function pluginEnv(id: string, dir: string, state: string, token: string, cli: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(Bun.env)) {
    if (v === undefined || k.startsWith("SSH_") || k === "HOLLR_GATE_PATH") continue;
    env[k] = v;
  }
  const path = (env.PATH ?? "/usr/bin:/bin").split(":");
  env.PATH = [...toolPathDirs().filter((d) => !path.includes(d)), ...path].join(":");
  return {
    ...env,
    BUN_BE_BUN: "1",
    HOLLR_PLUGIN_ID: id,
    HOLLR_PLUGIN_DIR: dir,
    HOLLR_PLUGIN_STATE_DIR: state,
    HOLLR_PLUGIN_TOKEN: token,
    HOLLR_PLUGIN_READY_FILE: join(state, "ready.json"),
    HOLLR_CLI: JSON.stringify(cli),
  };
}

/** Starts the plugin unless it already runs; at most one start at a time (a lock dir). */
export async function openPlugin(id: string, cli: string[]): Promise<{ port: number; url: string }> {
  const { dir, manifest } = entryOf(id);
  const entryFile = join(dir, manifest.entry);
  const running = await alreadyRunning(id, entryFile);
  if (running) return running;

  const state = stateDir(id);
  mkdirSync(state, { recursive: true });
  const lock = join(state, "start.lock");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // just removed – try again
      }
      if (age > 15_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      await Bun.sleep(200);
      const now = await alreadyRunning(id, entryFile);
      if (now) return now;
      if (Date.now() > deadline) throw new Error(`Plugin ${id} startet gerade – bitte erneut versuchen`);
    }
  }
  try {
    // started by someone else while we waited for the lock
    const now = await alreadyRunning(id, entryFile);
    if (now) return now;
    const old = readState(id);
    if (old && ownsPid(old.pid, entryFile)) {
      try {
        process.kill(old.pid, "SIGTERM");
      } catch {}
    }
    const ready = join(state, "ready.json");
    const log = join(state, "server.log");
    rmSync(ready, { force: true });
    writeFileSync(log, "");
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    // own session so it survives the SSH channel closing (macOS has no setsid binary: perl's POSIX::setsid)
    const detach = which("setsid")
      ? ["setsid"]
      : ["perl", "-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV"];
    const proc = Bun.spawn([...detach, process.execPath, entryFile], {
      cwd: dir,
      env: pluginEnv(id, dir, state, token, cli),
      stdin: "ignore",
      stdout: Bun.file(log),
      stderr: Bun.file(log),
    });
    proc.unref();

    const until = Date.now() + 8000;
    while (Date.now() < until) {
      await Bun.sleep(100);
      let got: { port?: unknown; pid?: unknown } | undefined;
      try {
        got = JSON.parse(readFileSync(ready, "utf8"));
      } catch {}
      if (typeof got?.port === "number" && typeof got.pid === "number") {
        const s: ServerState = { pid: got.pid, port: got.port, token, startedAt: new Date().toISOString() };
        writeJson(join(state, "server.json"), s);
        return urlFor(s);
      }
    }
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {}
    throw new Error(`Plugin ${id} startet nicht: ${tailLines(log, 20)}`);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function stopPlugin(id: string): boolean {
  if (!ID_RE.test(id)) return false;
  const pid = runningPid(id);
  rmSync(join(stateDir(id), "server.json"), { force: true });
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
