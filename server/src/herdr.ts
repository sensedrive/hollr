import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startArgs } from "./models";

export interface Agent {
  pane: string;
  kind: string;
  status: string;
  title: string;
  cwd: string;
  workspace: string;
  sessionFile?: string;
}

export interface TreePane {
  pane: string;
  /** omp, claude, codex, … – undefined for a plain shell */
  agent?: string;
  status: string;
  title: string;
  cwd: string;
  focused: boolean;
  /** omp panes can do /live */
  live: boolean;
}

export interface TreeTab {
  id: string;
  label: string;
  number: number;
  focused: boolean;
  panes: TreePane[];
}

export interface TreeWorkspace {
  id: string;
  label: string;
  number: number;
  focused: boolean;
  status: string;
  tabs: TreeTab[];
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

export function herdrBin(): string {
  const fromEnv = Bun.env.HERDR_BIN_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = join(homedir(), ".local", "bin", "herdr");
  return existsSync(local) ? local : "herdr";
}

export type Exec = (args: string[]) => Promise<unknown>;

export const execHerdr: Exec = async (args) => {
  const proc = Bun.spawn([herdrBin(), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  let json: { result?: unknown; error?: { code?: string; message?: string } };
  try {
    json = JSON.parse(stdout);
  } catch {
    if (proc.exitCode === 0) return stdout;
    // refusals (agent_blocked …) come as JSON on stderr
    let refusal: typeof json | undefined;
    try {
      refusal = JSON.parse(stderr);
    } catch {}
    if (!refusal?.error)
      throw new HerdrError("herdr_failed", (stderr || stdout).trim() || `herdr exit ${proc.exitCode}`);
    json = refusal;
  }
  if (json.error)
    throw new HerdrError(json.error.code ?? "error", json.error.message ?? "herdr error");
  return json.result;
};

interface RawAgent {
  agent?: string;
  pane_id: string;
  agent_status?: string;
  terminal_title_stripped?: string;
  cwd?: string;
  workspace_id?: string;
  agent_session?: { kind?: string; value?: string };
}

export function toAgent(raw: RawAgent): Agent {
  const title = (raw.terminal_title_stripped ?? "")
    .replace(/^π\s*\S*\s*/u, "")
    .replace(/^[\p{Co}\s]+/u, "")
    .trim();
  return {
    pane: raw.pane_id,
    kind: raw.agent ?? "unknown",
    status: raw.agent_status ?? "unknown",
    title: title || raw.cwd?.split("/").pop() || raw.pane_id,
    cwd: raw.cwd ?? "",
    workspace: raw.workspace_id ?? "",
    sessionFile: raw.agent_session?.kind === "path" ? raw.agent_session.value : undefined,
  };
}

/** Label of the tab that records omp's voice during a live call on a Mac (macaudio.ts). */
export const LIVE_AUDIO_TAB = "hollr live audio";

export class Herdr {
  constructor(private readonly exec: Exec = execHerdr) {}

  async agents(): Promise<Agent[]> {
    const res = (await this.exec(["agent", "list"])) as { agents?: RawAgent[] };
    return (res.agents ?? []).map(toAgent);
  }

  /** herdr's own structure: workspaces → tabs → panes, with the labels you see in herdr. */
  async tree(): Promise<TreeWorkspace[]> {
    const [ws, tabs, panes] = (await Promise.all([
      this.exec(["workspace", "list"]),
      this.exec(["tab", "list"]),
      this.exec(["pane", "list"]),
    ])) as [
      { workspaces?: Array<Record<string, unknown>> },
      { tabs?: Array<Record<string, unknown>> },
      { panes?: Array<Record<string, unknown>> },
    ];
    const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
    const num = (v: unknown) => (typeof v === "number" ? v : 0);
    const treePanes = (panes.panes ?? []).map((p) => {
      const agent = typeof p.agent === "string" && p.agent ? p.agent : undefined;
      const raw = toAgent(p as unknown as RawAgent);
      return {
        tab: str(p.tab_id),
        pane: {
          pane: str(p.pane_id),
          agent,
          status: str(p.agent_status, "unknown"),
          title: agent ? raw.title : str(p.cwd).split("/").pop() || str(p.pane_id),
          cwd: str(p.cwd),
          focused: p.focused === true,
          live: agent === "omp",
        } satisfies TreePane,
      };
    });
    return (ws.workspaces ?? [])
      .map((w) => ({
        id: str(w.workspace_id),
        label: str(w.label) || `Workspace ${num(w.number)}`,
        number: num(w.number),
        focused: w.focused === true,
        status: str(w.agent_status, "unknown"),
        tabs: (tabs.tabs ?? [])
          // the Mac's live call records omp's voice in its own tab – plumbing, not a session
          .filter((t) => t.workspace_id === w.workspace_id && t.label !== LIVE_AUDIO_TAB)
          .map((t) => ({
            id: str(t.tab_id),
            label: str(t.label) || `Tab ${num(t.number)}`,
            number: num(t.number),
            focused: t.focused === true,
            panes: treePanes.filter((p) => p.tab === t.tab_id).map((p) => p.pane),
          }))
          .sort((a, b) => a.number - b.number),
      }))
      .sort((a, b) => a.number - b.number);
  }

  async agent(pane: string): Promise<Agent> {
    const res = (await this.exec(["agent", "get", pane])) as { agent: RawAgent };
    const agent = toAgent(res.agent);
    if (agent.kind === "omp") {
      // the session file omp actually has open beats herdr's (sometimes stale/missing) hint
      const pid = await this.agentPid(pane).catch(() => undefined);
      const open = pid ? openSessionFile(pid) : undefined;
      if (open) agent.sessionFile = open;
    }
    return agent;
  }

  /** PID of the agent process in the pane's foreground (e.g. omp). */
  async agentPid(pane: string, kind = "omp"): Promise<number | undefined> {
    const res = (await this.exec(["pane", "process-info", "--pane", pane])) as {
      process_info?: {
        foreground_processes?: Array<{ pid: number; name?: string; argv?: string[] }>;
      };
    };
    const procs = res.process_info?.foreground_processes ?? [];
    return (procs.find((p) => p.name === kind || p.argv?.[0]?.endsWith(kind)) ?? procs[0])?.pid;
  }

  /** Types text into the pane and presses Enter (works for slash commands). */
  async run(pane: string, text: string): Promise<void> {
    await this.exec(["pane", "run", pane, text]);
  }

  /** A new shell tab that doesn't take the focus; `workspace` "" = herdr's choice. */
  async openTab(workspace: string, label: string): Promise<{ tab: string; pane: string }> {
    const args = ["tab", "create", "--no-focus", "--label", label];
    if (workspace) args.push("--workspace", workspace);
    const res = (await this.exec(args)) as {
      tab?: { tab_id?: string };
      root_pane?: { pane_id?: string };
    };
    const tab = res.tab?.tab_id;
    const pane = res.root_pane?.pane_id;
    if (!tab || !pane) throw new HerdrError("create_failed", "herdr hat keinen Tab geliefert");
    return { tab, pane };
  }

  async closeTab(tab: string): Promise<void> {
    await this.exec(["tab", "close", tab]);
  }

  async prompt(pane: string, text: string): Promise<void> {
    if (await this.isAgent(pane)) await this.exec(["agent", "prompt", pane, text]);
    // plain terminal: type the command and press Enter
    else await this.exec(["pane", "run", pane, text]);
  }

  /** Whether herdr detects an agent (omp, claude, …) in the pane – else it's a plain terminal. */
  async isAgent(pane: string): Promise<boolean> {
    return (await this.agents()).some((a) => a.pane === pane);
  }

  /** The visible lines at the bottom of the agent's terminal. */
  async screen(pane: string, lines: number): Promise<string> {
    const screen = await this.exec(["agent", "read", pane, "--source", "visible", "--lines", String(lines)]);
    return typeof screen === "string" ? screen : "";
  }

  /** omp shows its live footer ("… · ␣ mute · ⎋ end"), whatever state it is in. */
  async liveActive(pane: string): Promise<boolean> {
    return hasLiveFooter(await this.screen(pane, 6));
  }

  /** omp's live footer state ("listening", "muted", "speaking", "working", …) or undefined. */
  async liveState(pane: string): Promise<string | undefined> {
    return parseLiveState(await this.screen(pane, 6));
  }

  /** Types text as is, without pressing Enter. */
  async typeText(pane: string, text: string): Promise<void> {
    await this.exec(["pane", "send-text", pane, text]);
  }

  async sendKeys(pane: string, keys: string[]): Promise<void> {
    const scope = (await this.isAgent(pane)) ? "agent" : "pane";
    // herdr has no names for these keys: send their terminal sequences as text, in order
    let run: string[] = [];
    const flush = async () => {
      if (run.length) await this.exec([scope, "send-keys", pane, ...run]);
      run = [];
    };
    for (const key of keys) {
      const seq = KEY_SEQUENCES[key];
      if (!seq) {
        run.push(key);
        continue;
      }
      await flush();
      await this.exec(["pane", "send-text", pane, seq]);
    }
    await flush();
  }
}

/** Keys herdr's send-keys doesn't know, as the escape sequences a terminal sends. */
export const KEY_SEQUENCES: Record<string, string> = {
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  home: "\x1bOH",
  end: "\x1bOF",
  delete: "\x1b[3~",
  insert: "\x1b[2~",
};

export function hasLiveFooter(screen: string): boolean {
  return /·\s*\S+\s+mute\s+·\s*\S+\s+end\b/u.test(screen);
}

/** Reads omp's live footer, e.g. "╰─ × muted · 󱁐 mute · 󱊷 end ─". */
export function parseLiveState(screen: string): string | undefined {
  const m = screen.match(/[●×◉○◌•]\s+(listening|muted|speaking|working|thinking|connecting)\s+·/u);
  return m?.[1];
}

export const AGENT_KINDS = ["omp", "claude", "codex"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number] | "shell";

/** Which agent CLIs are installed for this user (looked up like a login shell would). */
export function installedKinds(): AgentKind[] {
  const home = Bun.env.HOME ?? "";
  const dirs = [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.npm-global/bin`,
    "/usr/local/bin",
    "/usr/bin",
  ];
  const path = (Bun.env.PATH ?? "").split(":");
  const agents: AgentKind[] = AGENT_KINDS.filter((k) =>
    [...new Set([...dirs, ...path])].some(
      (d) => d && Bun.spawnSync(["test", "-x", `${d}/${k}`]).exitCode === 0,
    ),
  );
  // a plain terminal is always possible
  return [...agents, "shell"];
}

export interface NewChatRequest {
  kind: AgentKind;
  /** existing workspace id – a new tab is created there; omitted = new workspace */
  workspace?: string;
  cwd?: string;
  label?: string;
  /** model id / alias for the agent (omp selector, claude alias, codex slug) */
  model?: string;
  /** thinking (omp) or effort (claude, codex) */
  level?: string;
}

export async function newChat(herdr: Herdr, exec: Exec, req: NewChatRequest): Promise<string> {
  if (req.kind !== "shell" && !AGENT_KINDS.includes(req.kind))
    throw new HerdrError("bad_kind", `Unbekannter Agent ${req.kind}`);
  const label = (req.label ?? "")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .trim()
    .slice(0, 40);
  let cwd = req.cwd;
  if (req.workspace && !cwd) {
    const ws = (await herdr.tree()).find((w) => w.id === req.workspace);
    cwd = ws?.tabs.flatMap((t) => t.panes).find((p) => p.cwd)?.cwd;
  }
  // no project: start in the user's home, not in whatever herdr has focused
  if (!req.workspace && !cwd) cwd = Bun.env.HOME;
  const args = req.workspace
    ? ["tab", "create", "--workspace", req.workspace, "--no-focus"]
    : ["workspace", "create", "--no-focus"];
  if (cwd) args.push("--cwd", cwd);
  if (label) args.push("--label", label);
  const created = (await exec(args)) as {
    root_pane?: { pane_id?: string };
    pane?: { pane_id?: string };
  };
  const pane = created.root_pane?.pane_id ?? created.pane?.pane_id;
  if (!pane) throw new HerdrError("create_failed", "herdr hat kein Pane geliefert");
  await Bun.sleep(400); // let the shell come up
  if (req.kind === "shell") return pane;
  try {
    await exec([
      "agent",
      "start",
      `${req.kind}-${Date.now().toString(36)}`,
      "--kind",
      req.kind,
      "--pane",
      pane,
      ...((): string[] => {
        const extra = startArgs(req.kind, req.model, req.level);
        return extra.length ? ["--", ...extra] : [];
      })(),
    ]);
  } catch (err) {
    // e.g. Claude asks "trust this folder?" on first start – the chat exists and waits for the user
    if (!(err instanceof HerdrError && err.code === "agent_not_ready")) throw err;
  }
  return pane;
}

/** The main omp session JSONL a process has open (Linux /proc, macOS lsof). */
export function openSessionFile(pid: number): string | undefined {
  const isSession = (p: string) => /\/\.omp\/agent\/sessions\/[^/]+\/[^/]+\.jsonl$/.test(p);
  try {
    const { readdirSync, readlinkSync } = require("node:fs") as typeof import("node:fs");
    const dir = `/proc/${pid}/fd`;
    for (const fd of readdirSync(dir)) {
      try {
        const target = readlinkSync(`${dir}/${fd}`);
        if (isSession(target)) return target;
      } catch {}
    }
  } catch {
    try {
      const res = Bun.spawnSync(["lsof", "-p", String(pid), "-Fn"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      for (const line of res.stdout.toString().split("\n")) {
        if (line.startsWith("n") && isSession(line.slice(1))) return line.slice(1);
      }
    } catch {}
  }
  return undefined;
}
