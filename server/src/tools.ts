/**
 * Install / update the tools Hollr builds on (herdr, omp, Claude Code, Codex, hollr itself)
 * from the app. Fixed commands only; each runs detached with a log the app polls.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Lang, tr } from "./i18n";

export const TOOL_NAMES = ["herdr", "omp", "claude", "codex", "hollr"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const STATE = () => join(Bun.env.HOME ?? homedir(), ".local", "state", "hollr", "tools");
const BIN = () => join(Bun.env.HOME ?? homedir(), ".local", "bin");
const PATH_PREFIX = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.claude/local:$PATH";';

const TITLES: Record<ToolName, string> = {
  herdr: "herdr",
  omp: "omp (Oh My Pi)",
  claude: "Claude Code",
  codex: "Codex (ChatGPT)",
  hollr: "Hollr-Server",
};

function which(name: string): string | undefined {
  for (const dir of [
    BIN(),
    join(Bun.env.HOME ?? "", ".bun", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    ...(Bun.env.PATH ?? "").split(":"),
  ]) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

function version(name: ToolName, current: string): string | undefined {
  if (name === "hollr") return current;
  const bin = which(name);
  if (!bin) return undefined;
  const res = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const text = (res.stdout.toString() || res.stderr.toString()).split("\n")[0]?.trim() ?? "";
  return text.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? (text || "installiert");
}

/** The shell command for install (missing) or update (present). */
export function toolCommand(name: ToolName, installed: boolean, repo = "sensedrive/hollr"): string {
  switch (name) {
    case "herdr":
      // --handoff keeps running sessions alive across the update
      return installed ? "herdr update --handoff" : "curl -fsSL https://herdr.dev/install.sh | sh";
    case "omp":
      return installed ? "omp update" : "curl -fsSL https://omp.sh/install | sh -s -- --binary";
    case "claude":
      return installed ? "claude update" : "curl -fsSL https://claude.ai/install.sh | bash";
    case "codex":
      return [
        "set -e",
        'case "$(uname -m)" in x86_64|amd64) T=x86_64-unknown-linux-musl;; aarch64|arm64) T=aarch64-unknown-linux-musl;; *) echo "Architektur nicht unterstützt"; exit 1;; esac',
        'TMP="$(mktemp -d)"',
        'curl -fsSL "https://github.com/openai/codex/releases/latest/download/codex-$T.tar.gz" -o "$TMP/codex.tgz"',
        'tar -xzf "$TMP/codex.tgz" -C "$TMP"',
        'mkdir -p "$HOME/.local/bin"',
        'install -m 755 "$TMP/codex-$T" "$HOME/.local/bin/.codex.new"',
        'mv -f "$HOME/.local/bin/.codex.new" "$HOME/.local/bin/codex"',
        'rm -rf "$TMP"',
        "codex --version",
      ].join("\n");
    case "hollr":
      return [
        "set -e",
        `curl -fsSL https://raw.githubusercontent.com/${repo}/main/install.sh -o /tmp/hollr-install.sh \\`,
        `  || gh api repos/${repo}/contents/install.sh -H "Accept: application/vnd.github.raw" > /tmp/hollr-install.sh`,
        "HOLLR_SKIP_DEPS=1 bash /tmp/hollr-install.sh",
        "rm -f /tmp/hollr-install.sh",
      ].join("\n");
  }
}

export interface ToolState {
  name: ToolName;
  title: string;
  version?: string;
  /** newest available version (cached 1 h; undefined = unknown) */
  latest?: string;
  /** latest is newer than the installed version */
  updateAvailable?: boolean;
  installed: boolean;
  running: boolean;
  exit?: number;
  log?: string;
}

function files(name: ToolName) {
  const dir = STATE();
  return {
    log: join(dir, `${name}.log`),
    exit: join(dir, `${name}.exit`),
    pid: join(dir, `${name}.pid`),
  };
}

function alive(pidFile: string): boolean {
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tail(file: string, lines = 30): string | undefined {
  try {
    const text = readFileSync(file, "utf8")
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "")
      .replace(/\r(?!\n)/g, "\n");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .slice(-lines)
      .join("\n");
  } catch {
    return undefined;
  }
}

/** "1.10.2" > "1.9.9"; ignores prefixes like "v" / "rust-v". */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => (v.match(/\d+(\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { "user-agent": "hollr" },
    });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

const clean = (v?: string) => v?.match(/\d+(\.\d+)+/)?.[0];

async function lookupLatest(name: ToolName, repo: string): Promise<string | undefined> {
  switch (name) {
    case "herdr":
      return clean(
        (await fetchText("https://herdr.dev/latest.json"))?.match(/"version"\s*:\s*"([^"]+)"/)?.[1],
      );
    case "omp": {
      const bin = which("omp");
      if (!bin) return undefined;
      const res = Bun.spawnSync([bin, "update", "--check"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20000,
      });
      const out = res.stdout.toString() + res.stderr.toString();
      return clean(
        out.match(/New version available:\s*(\S+)/)?.[1] ??
          out.match(/Current version:\s*(\S+)/)?.[1],
      );
    }
    case "claude":
      return clean(
        (await fetchText("https://registry.npmjs.org/@anthropic-ai/claude-code/latest"))?.match(
          /"version"\s*:\s*"([^"]+)"/,
        )?.[1],
      );
    case "codex":
      return clean(
        (await fetchText("https://api.github.com/repos/openai/codex/releases/latest"))?.match(
          /"tag_name"\s*:\s*"([^"]+)"/,
        )?.[1],
      );
    case "hollr": {
      const gh = Bun.spawnSync(
        ["gh", "api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"],
        { stdout: "pipe", stderr: "ignore", timeout: 8000 },
      );
      const tag =
        gh.exitCode === 0
          ? gh.stdout.toString().trim()
          : (await fetchText(`https://api.github.com/repos/${repo}/releases/latest`))?.match(
              /"tag_name"\s*:\s*"([^"]+)"/,
            )?.[1];
      return clean(tag);
    }
  }
}

/** Latest versions of all tools, cached for an hour (refresh = ignore cache). */
export async function latestVersions(
  refresh = false,
  repo = "sensedrive/hollr",
): Promise<Partial<Record<ToolName, string>>> {
  const file = join(STATE(), "latest.json");
  if (!refresh) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as {
        at: number;
        v: Partial<Record<ToolName, string>>;
      };
      if (Date.now() - cached.at < 3_600_000) return cached.v;
    } catch {}
  }
  const entries = await Promise.all(
    TOOL_NAMES.map(async (n) => [n, await lookupLatest(n, repo)] as const),
  );
  const v = Object.fromEntries(entries.filter(([, x]) => x)) as Partial<Record<ToolName, string>>;
  mkdirSync(STATE(), { recursive: true });
  writeFileSync(file, JSON.stringify({ at: Date.now(), v }));
  return v;
}

export function toolStates(
  currentHollr: string,
  latest: Partial<Record<ToolName, string>> = {},
  lang: Lang = "de",
): ToolState[] {
  return TOOL_NAMES.map((name) => {
    const f = files(name);
    const v = version(name, currentHollr);
    const running = alive(f.pid) && !existsSync(f.exit);
    let exit: number | undefined;
    try {
      exit = Number(readFileSync(f.exit, "utf8").trim());
    } catch {}
    const target = latest[name];
    return {
      name,
      title: tr(lang, TITLES[name]),
      version: v,
      latest: target,
      updateAvailable: Boolean(v && target && newer(target, v)),
      installed: v !== undefined,
      running,
      exit: running ? undefined : exit,
      log: running || exit !== undefined ? tail(f.log) : undefined,
    };
  });
}

/** Starts install/update in the background (survives the SSH channel closing). */
export function startTool(name: ToolName, currentHollr: string): ToolState {
  if (!TOOL_NAMES.includes(name)) throw new Error("unbekanntes Werkzeug");
  const f = files(name);
  if (alive(f.pid) && !existsSync(f.exit)) throw new Error("läuft bereits");
  mkdirSync(STATE(), { recursive: true });
  const installed = version(name, currentHollr) !== undefined;
  const script = `${PATH_PREFIX}\n( ${toolCommand(name, installed)}\n) > '${f.log}' 2>&1 < /dev/null\necho $? > '${f.exit}'\n`;
  writeFileSync(f.log, "");
  try {
    Bun.spawnSync(["rm", "-f", f.exit]);
  } catch {}
  const proc = Bun.spawn(["setsid", "sh", "-c", script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  writeFileSync(f.pid, String(proc.pid));
  proc.unref();
  return toolStates(currentHollr).find((t) => t.name === name) as ToolState;
}
