/** What Hollr hands the plugin, child processes, and the error type the HTTP layer turns into a status. */

export interface PluginEnv {
  id: string;
  dir: string;
  stateDir: string;
  token: string;
  readyFile: string;
}

/** HOLLR_PLUGIN_* from the host (server/src/plugins.ts); throws naming what is missing. */
export function pluginEnv(): PluginEnv {
  const get = (k: string) => process.env[k] ?? "";
  const env = {
    id: get("HOLLR_PLUGIN_ID"),
    dir: get("HOLLR_PLUGIN_DIR"),
    stateDir: get("HOLLR_PLUGIN_STATE_DIR"),
    token: get("HOLLR_PLUGIN_TOKEN"),
    readyFile: get("HOLLR_PLUGIN_READY_FILE"),
  };
  const missing = Object.entries({
    HOLLR_PLUGIN_ID: env.id,
    HOLLR_PLUGIN_DIR: env.dir,
    HOLLR_PLUGIN_STATE_DIR: env.stateDir,
    HOLLR_PLUGIN_TOKEN: env.token,
    HOLLR_PLUGIN_READY_FILE: env.readyFile,
    HOLLR_CLI: get("HOLLR_CLI"),
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`Fehlende Umgebungsvariablen: ${missing.join(", ")} – das Plugin startet nur über Hollr.`);
  return env;
}

/** An error with the HTTP status it answers with (400, 404, 409, 502). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The environment for children: without BUN_BE_BUN, else a `hollr` child would act as bun again. */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "BUN_BE_BUN") env[k] = v;
  return env;
}

export interface RunResult {
  ok: boolean;
  out: string;
  err: string;
}

export async function run(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number; stdin?: string } = {},
): Promise<RunResult> {
  let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: cleanEnv(),
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    }) as Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  } catch (err) {
    return { ok: false, out: "", err: err instanceof Error ? err.message : String(err) };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? 30_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0 && !timedOut, out, err: timedOut ? `${err}\nZeitüberschreitung`.trim() : err };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs this computer's hollr (HOLLR_CLI: the compiled binary, or bun + cli.ts in development). */
export function hollr(args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  const cli = JSON.parse(process.env.HOLLR_CLI ?? "[]") as string[];
  return run([...cli, ...args], opts);
}

/** First non-empty line of a tool's error output. */
export const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.trim() ?? "unbekannter Fehler";
