/**
 * Side conversations ("Nebengespräch"): a copy of a pane's agent session in a new herdr tab of the same
 * workspace, started with a write guard, so you can talk about the session (omp /live) without disturbing
 * it – the main session keeps working and its files stay as they are.
 *
 * omp: the session JSONL is copied next to the original as a new, distinct session (own id, `parentSession`
 * = the original, like omp's own fork) and resumed with `--approval-mode=always-ask` (reads run, every write
 * or command asks). Claude Code: `--resume <id> --fork-session` in plan mode (read-only until you approve).
 * Forks are recorded in ~/.config/hollr/forks.json – only those can be closed with `fork-close`, and the
 * tree marks them so the apps show them as side conversations.
 */
import { constants, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Agent, Exec } from "./herdr";

export interface ForkRequest {
  /** herdr tab label; default "🎙 Nebengespräch · <title>" */
  label?: string;
  /** start with the write guard (default) */
  readOnly?: boolean;
}

export interface ForkEntry {
  pane: string;
  /** herdr's terminal id: a pane id that a later terminal gets again is not the fork */
  terminal?: string;
  /** the pane the fork was made from */
  of: string;
  kind: string;
  /** epoch ms of the fork: the side conversation is what the fork's log has after this */
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
 * `parentSession` = the original's id (as omp's own fork writes it), the title marked with `titlePrefix`.
 * Only complete lines are taken – the main agent may be in the middle of a turn. The session's artifact
 * folder (tool output, subagent transcripts) is copied too (copy-on-write where the file system can), so
 * `artifact://` and subagent links keep working and the fork never writes into the original's folder.
 * The original is only read.
 */
export function forkOmpSession(
  source: string,
  opts: { id?: string; now?: Date; titlePrefix?: string } = {},
): OmpFork {
  const raw = readFileSync(source, "utf8");
  const cut = raw.lastIndexOf("\n");
  const lines = (cut < 0 ? "" : raw.slice(0, cut)).split("\n");
  const now = opts.now ?? new Date();
  const id = opts.id ?? Bun.randomUUIDv7();
  const prefix = opts.titlePrefix ?? "";
  const retitle = (title: unknown) =>
    typeof title === "string" && prefix && !title.startsWith(prefix) ? `${prefix}${title}` : title;
  let parent: string | undefined;
  const out = lines.map((line) => {
    if (parent !== undefined && !line.startsWith('{"type":"title"')) return line;
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
        title: retitle(e.title),
        parentSession: parent,
        // omp's fork keeps the provider prompt cache of the original
        providerPromptCacheKey: e.providerPromptCacheKey ?? parent,
      });
    }
    if (e.type === "title" && typeof e.title === "string") {
      // omp rewrites this slot in place: keep the line's length by giving the pad what the title took
      const next: Record<string, unknown> = { ...e, title: retitle(e.title) };
      const grow = Buffer.byteLength(JSON.stringify(next)) - Buffer.byteLength(line);
      if (typeof e.pad === "string") next.pad = " ".repeat(Math.max(0, e.pad.length - grow));
      return JSON.stringify(next);
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

/** What the fork is told for the whole conversation (appended to its system prompt). */
export function sidePrompt(readOnly: boolean): string {
  return [
    "# Side conversation (Hollr)",
    "",
    "This session is a fork of another agent session that may still be running in another terminal. Everything",
    "before this point is that session's history up to the moment of the fork. From now on the user talks with you",
    "in a side conversation, usually by voice: about that session – questions, explanations, thinking out loud –",
    "without disturbing it. Afterwards they go back to the main session.",
    "",
    "- Answer and explain. Keep answers short and conversational; they are often spoken aloud.",
    "- Read files, search the code and run read-only commands when that helps to answer.",
    ...(readOnly
      ? [
          "- Change nothing: do not edit, write, move or delete files, do not run commands that change files, git,",
          "  packages, services or anything else, and do not start subagents that could. The main session may be",
          "  working on the same files right now. If a tool asks for approval to write, that is the guard working.",
          "- When the user wants a change, say what should change (they take it to the main session) instead of doing it.",
        ]
      : ["- Make changes only when the user explicitly asks for them."]),
    "- Do not carry on with the main session's task on your own.",
    "- Answer in the language the user speaks.",
  ].join("\n");
}

/** CLI args for the fork's agent: resume the copy / fork the session, with the guard and the side prompt. */
export function forkArgs(kind: string, session: string, promptFile: string, readOnly: boolean, newId?: string): string[] {
  if (kind === "omp")
    return [`--resume=${session}`, ...(readOnly ? ["--approval-mode=always-ask"] : []), `--append-system-prompt=${promptFile}`];
  if (kind === "claude")
    return [
      "--resume",
      session,
      "--fork-session",
      ...(newId ? ["--session-id", newId] : []),
      ...(readOnly ? ["--permission-mode", "plan"] : []),
      "--append-system-prompt-file",
      promptFile,
    ];
  throw new Error("unsupported");
}

/** The tab label: what the app sent (cleaned), else "🎙 Nebengespräch · <title>". */
export function forkLabel(title: string, label?: string): string {
  const clean = (s: string) => s.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Co}]/gu, "").trim();
  // by code points: a cut emoji would leave half a surrogate pair in herdr's label
  return [...(clean(label ?? "") || `🎙 Nebengespräch · ${clean(title)}`)].slice(0, 80).join("");
}

/** A pane as herdr's `tab create` / `pane list` report it. */
interface HerdrPane {
  pane_id?: string;
  terminal_id?: string;
}

interface TabCreated {
  tab?: { tab_id?: string };
  root_pane?: HerdrPane;
}

/** Every pane herdr has, with its terminal id ("" when herdr doesn't report one). */
export async function paneTerminals(exec: Exec): Promise<Map<string, string>> {
  const res = (await exec(["pane", "list"])) as { panes?: HerdrPane[] };
  return new Map((res.panes ?? []).flatMap((p) => (p.pane_id ? [[p.pane_id, p.terminal_id ?? ""] as const] : [])));
}

/**
 * Forks `agent`'s session into a new tab of its workspace and registers it. Errors: `unsupported` (not omp /
 * Claude), `no_session` (nothing said yet – nothing to refer to), herdr's own (tab, start).
 */
export async function forkPane(
  exec: Exec,
  agent: Agent,
  req: ForkRequest,
  opts: { file?: string; promptDir?: string } = {},
): Promise<ForkEntry & { tab?: string }> {
  if (agent.kind !== "omp" && agent.kind !== "claude") throw new Error("unsupported");
  if (!agent.sessionFile) throw new Error("no_session");
  const readOnly = req.readOnly !== false;
  const at = Date.now();
  // the prompt as a file: no quoting through herdr's shell, and it stays readable for whoever wonders
  const dir = opts.promptDir ?? join(homedir(), ".config", "hollr");
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, readOnly ? "side-conversation.md" : "side-conversation-rw.md");
  writeFileSync(promptFile, `${sidePrompt(readOnly)}\n`);

  let session: string;
  let args: string[];
  let copy: OmpFork | undefined;
  if (agent.kind === "omp") {
    copy = forkOmpSession(agent.sessionFile, { titlePrefix: "🎙 " });
    session = copy.file;
    args = forkArgs("omp", copy.file, promptFile, readOnly);
  } else {
    // Claude makes the copy itself; the fork's id is chosen here so the registry knows it at once
    session = crypto.randomUUID();
    args = forkArgs("claude", basename(agent.sessionFile).replace(/\.jsonl$/, ""), promptFile, readOnly, session);
  }
  const dropCopy = () => {
    if (!copy) return;
    rmSync(copy.file, { force: true });
    rmSync(copy.file.replace(/\.jsonl$/, ""), { recursive: true, force: true });
  };

  let created: TabCreated;
  try {
    const label = forkLabel(agent.title, req.label);
    created = (await exec(["tab", "create", "--workspace", agent.workspace, "--no-focus", "--cwd", agent.cwd, "--label", label])) as TabCreated;
  } catch (err) {
    dropCopy();
    throw err;
  }
  const pane = created.root_pane?.pane_id;
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
  const terminal = created.root_pane?.terminal_id ?? (await paneTerminals(exec).catch(() => undefined))?.get(pane);
  const entry: ForkEntry = { pane, terminal: terminal || undefined, of: agent.pane, kind: agent.kind, at, session };
  const file = opts.file ?? forksFile();
  saveForks([...loadForks(file).filter((e) => e.pane !== pane), entry], file);
  return { ...entry, tab: created.tab?.tab_id };
}

/** Closes a registered fork's pane (refuses any other pane: `not_a_fork`); one already gone is just forgotten. */
export async function closeFork(exec: Exec, pane: string, file = forksFile()): Promise<void> {
  const list = loadForks(file);
  const panes = await paneTerminals(exec);
  const entry = findFork(list, pane, panes.get(pane) || undefined);
  if (!entry) throw new Error("not_a_fork");
  if (panes.has(pane)) await exec(["pane", "close", pane]);
  saveForks(
    list.filter((e) => e !== entry),
    file,
  );
}
