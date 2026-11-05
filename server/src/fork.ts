/**
 * Forks: a new chat that continues with the copied history of a pane's agent session, in a new herdr tab
 * of the same workspace (or, on reset, in the old fork's tab). The original session keeps running untouched.
 *
 * omp: the session JSONL is copied next to the original as a new, distinct session (own id, `parentSession`
 * = the original, like omp's own fork) and resumed. Claude Code: `--resume <id> --fork-session`.
 * Forks are recorded in ~/.config/hollr/forks.json – for the tree's fork mark, for reset (`replace`) and
 * for the cutoff time (`at`) from which the fork's own conversation starts.
 */
import { constants, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Agent, Exec } from "./herdr";

export interface ForkRequest {
  /** herdr tab label; default the session's title */
  label?: string;
  /** reset: this earlier fork of the same pane is replaced by a fresh one – in its tab, which keeps its place */
  replace?: string;
}

export interface ForkEntry {
  pane: string;
  /** herdr's terminal id: a pane id that a later terminal gets again is not the fork */
  terminal?: string;
  /** the pane the fork was made from */
  of: string;
  kind: string;
  /** epoch ms of the fork: the fork's own conversation is what its log has after this */
  at: number;
  /** the fork's session file (omp) or id (claude) */
  session?: string;
}

/** What the tree shows on a fork pane. */
export interface ForkMark {
  of: string;
  at: number;
}

export const forksFile = () => Bun.env.HOLLR_FORKS_FILE ?? join(homedir(), ".config", "hollr", "forks.json");

export function loadForks(file = forksFile()): ForkEntry[] {
  try {
    const list = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(list) ? list.filter((e): e is ForkEntry => typeof e?.pane === "string" && typeof e?.of === "string") : [];
  } catch {
    return [];
  }
}

/** Written whole and renamed into place: gate calls run in parallel and must never read half a file. */
export function saveForks(list: ForkEntry[], file = forksFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(list, null, 1)}\n`);
  renameSync(tmp, file);
}

/** The registered fork in `pane` – with herdr's terminal id when known, so a reused pane id doesn't count. */
export function findFork(list: ForkEntry[], pane: string, terminal?: string): ForkEntry | undefined {
  return list.find((e) => e.pane === pane && (!e.terminal || !terminal || e.terminal === terminal));
}

/**
 * Fork marks for the tree's panes (pane → terminal id). Forks whose pane is gone (closed in herdr, herdr
 * restarted) are dropped from the registry – the file is only written when something went.
 */
export function forkMarks(panes: Map<string, string>, file = forksFile()): Map<string, ForkMark> {
  const list = loadForks(file);
  const marks = new Map<string, ForkMark>();
  if (!list.length) return marks;
  const here = (e: ForkEntry) => panes.has(e.pane) && (!e.terminal || !panes.get(e.pane) || e.terminal === panes.get(e.pane));
  // a fork registered while this tree's pane list was being read isn't in that list yet: fresh entries stay
  const alive = list.filter((e) => here(e) || Date.now() - e.at < 120_000);
  if (alive.length !== list.length) {
    try {
      saveForks(alive, file);
    } catch {}
  }
  for (const e of alive) if (here(e)) marks.set(e.pane, { of: e.of, at: e.at });
  return marks;
}

// ---------------------------------------------------------------- omp session copy

/** omp names session files `<ISO time with - for : and .>_<session id>.jsonl`. */
export const sessionFileName = (at: Date, id: string) => `${at.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;

export interface OmpFork {
  file: string;
  id: string;
  parent: string;
}

/**
 * Copies an omp session into a new, distinct session in the same folder: header with a new id and time,
 * `parentSession` = the original's id (as omp's own fork writes it); the title stays as it is.
 * Only complete lines are taken – the main agent may be in the middle of a turn. The session's artifact
 * folder (tool output, subagent transcripts) is copied too (copy-on-write where the file system can), so
 * `artifact://` and subagent links keep working and the fork never writes into the original's folder.
 * The original is only read.
 */
export function forkOmpSession(
  source: string,
  opts: { id?: string; now?: Date } = {},
): OmpFork {
  const raw = readFileSync(source, "utf8");
  const cut = raw.lastIndexOf("\n");
  const lines = (cut < 0 ? "" : raw.slice(0, cut)).split("\n");
  const now = opts.now ?? new Date();
  const id = opts.id ?? Bun.randomUUIDv7();
  let parent: string | undefined;
  const out = lines.map((line) => {
    if (parent !== undefined) return line;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      return line;
    }
    if (e.type === "session" && parent === undefined) {
      parent = typeof e.id === "string" ? e.id : "";
      return JSON.stringify({
        ...e,
        id,
        timestamp: now.toISOString(),
        parentSession: parent,
        // omp's fork keeps the provider prompt cache of the original
        providerPromptCacheKey: e.providerPromptCacheKey ?? parent,
      });
    }
    return line;
  });
  if (!parent) throw new Error("no_session_header");
  const file = join(dirname(source), sessionFileName(now, id));
  writeFileSync(file, `${out.join("\n")}\n`, { flag: "wx" });
  const artifacts = source.replace(/\.jsonl$/, "");
  if (existsSync(artifacts)) {
    try {
      cpSync(artifacts, file.replace(/\.jsonl$/, ""), { recursive: true, mode: constants.COPYFILE_FICLONE });
    } catch {}
  }
  return { file, id, parent };
}

// ---------------------------------------------------------------- starting the fork

/** CLI args for the fork's agent: resume the copy (omp) / fork the session (Claude). */
export function forkArgs(kind: string, session: string, newId?: string): string[] {
  if (kind === "omp") return [`--resume=${session}`];
  if (kind === "claude") return ["--resume", session, "--fork-session", ...(newId ? ["--session-id", newId] : [])];
  throw new Error("unsupported");
}

/** The tab label: what the app sent (cleaned), else the session's title. */
export function forkLabel(title: string, label?: string): string {
  const clean = (s: string) => s.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Co}]/gu, "").trim();
  // by code points: a cut emoji would leave half a surrogate pair in herdr's label
  return [...(clean(label ?? "") || clean(title))].slice(0, 80).join("");
}

/** A pane as herdr's `tab create` / `pane list` report it. */
interface HerdrPane {
  pane_id?: string;
  terminal_id?: string;
}

interface TabCreated {
  tab?: { tab_id?: string };
  root_pane?: HerdrPane;
  /** `pane split` answers with the new pane here */
  pane?: HerdrPane & { tab_id?: string };
}

/** Every pane herdr has, with its terminal id ("" when herdr doesn't report one). */
export async function paneTerminals(exec: Exec): Promise<Map<string, string>> {
  const res = (await exec(["pane", "list"])) as { panes?: HerdrPane[] };
  return new Map((res.panes ?? []).flatMap((p) => (p.pane_id ? [[p.pane_id, p.terminal_id ?? ""] as const] : [])));
}

/**
 * Forks `agent`'s session into a new tab of its workspace and registers it. With `replace` (reset), the
 * earlier fork of the same pane makes way: the new one opens as a split in its tab, then the old pane closes –
 * the tab keeps its place and name, the conversation starts over from the session as it is now.
 * Errors: `unsupported` (not omp / Claude), `no_session` (nothing said yet – nothing to refer to),
 * `not_a_fork` (`replace` is no fork of this pane), herdr's own (tab, start).
 */
export async function forkPane(
  exec: Exec,
  agent: Agent,
  req: ForkRequest,
  opts: { file?: string } = {},
): Promise<ForkEntry & { tab?: string }> {
  if (agent.kind !== "omp" && agent.kind !== "claude") throw new Error("unsupported");
  if (!agent.sessionFile) throw new Error("no_session");
  const file = opts.file ?? forksFile();
  let old: ForkEntry | undefined;
  let oldAlive = false;
  if (req.replace) {
    const panes = await paneTerminals(exec);
    old = findFork(loadForks(file), req.replace, panes.get(req.replace) || undefined);
    if (!old || old.of !== agent.pane) throw new Error("not_a_fork");
    oldAlive = panes.has(old.pane);
  }
  const at = Date.now();
  let session: string;
  let args: string[];
  let copy: OmpFork | undefined;
  if (agent.kind === "omp") {
    copy = forkOmpSession(agent.sessionFile);
    session = copy.file;
    args = forkArgs("omp", copy.file);
  } else {
    // Claude makes the copy itself; the fork's id is chosen here so the registry knows it at once
    session = crypto.randomUUID();
    args = forkArgs("claude", basename(agent.sessionFile).replace(/\.jsonl$/, ""), session);
  }
  const dropCopy = () => {
    if (!copy) return;
    rmSync(copy.file, { force: true });
    rmSync(copy.file.replace(/\.jsonl$/, ""), { recursive: true, force: true });
  };

  let created: TabCreated;
  try {
    created = (await exec(
      old && oldAlive
        ? ["pane", "split", old.pane, "--direction", "right", "--no-focus", "--cwd", agent.cwd]
        : ["tab", "create", "--workspace", agent.workspace, "--no-focus", "--cwd", agent.cwd, "--label", forkLabel(agent.title, req.label)],
    )) as TabCreated;
  } catch (err) {
    dropCopy();
    throw err;
  }
  const made = created.root_pane ?? created.pane;
  const pane = made?.pane_id;
  if (!pane) {
    dropCopy();
    throw new Error("herdr hat kein Pane geliefert");
  }
  await Bun.sleep(400); // let the shell come up
  try {
    // a big session takes omp a while to load
    await exec(["agent", "start", `${agent.kind}-fork-${at.toString(36)}`, "--kind", agent.kind, "--pane", pane, "--timeout", "120000", "--", ...args]);
  } catch (err) {
    // e.g. Claude asks "trust this folder?" – the fork exists and waits for the user (HerdrError's code, read
    // structurally: this module only imports herdr's types)
    if (!(err instanceof Error && "code" in err && err.code === "agent_not_ready")) {
      await exec(["pane", "close", pane]).catch(() => {});
      dropCopy();
      throw err;
    }
  }
  // the reset's old conversation goes only once the new one runs (a failed start keeps it)
  if (old && oldAlive) await exec(["pane", "close", old.pane]).catch(() => {});
  const terminal = made?.terminal_id ?? (await paneTerminals(exec).catch(() => undefined))?.get(pane);
  const entry: ForkEntry = { pane, terminal: terminal || undefined, of: agent.pane, kind: agent.kind, at, session };
  saveForks([...loadForks(file).filter((e) => e.pane !== pane && e.pane !== old?.pane), entry], file);
  return { ...entry, tab: created.tab?.tab_id ?? created.pane?.tab_id };
}
