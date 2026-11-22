// What the desktop app and the phone share about this server, kept here so both always show the same:
// which results were seen or dismissed, sessions marked unread, "Meine Sitzungen", the dragged order of spaces,
// worktrees and tabs. (Hidden spaces: hiddenspaces.ts.) A change rewrites `shared.json`; the live feed sees it
// and tells every connected app to load it again.
//
// "Seen" and "dismissed" belong to one status of a pane: `tree` stamps every pane with `since`, the server time
// it entered its current status (pane-status.json). Both apps key their cards with that, so a result seen on the
// phone is seen on the Mac – and a new result (a new status) shows again.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stateDir } from "./hiddenspaces";
import type { TreeWorkspace } from "./herdr";

export const SHARED_FILE = "shared.json";
const STATUS_FILE = "pane-status.json";

export interface SharedState {
  /** pane → the `since` of the status whose result was looked at */
  seen: Record<string, number>;
  /** pane → the `since` of the status whose card was removed by hand */
  dismissed: Record<string, number>;
  /** panes marked unread by hand (cleared when opened) */
  unread: Record<string, true>;
  /** pane → turn start of a long run taken off "Braucht dich" */
  hiddenLong: Record<string, number>;
  /** "Meine Sitzungen", newest first */
  mySessions: string[];
  /** dragged order of the space groups (the first space id of each) */
  spaceOrder: string[];
  /** repo space → its worktree spaces in dragged order */
  worktreeOrder: Record<string, string[]>;
  /** space → its tab ids in dragged order */
  tabOrder: Record<string, string[]>;
}

const empty = (): SharedState => ({
  seen: {},
  dismissed: {},
  unread: {},
  hiddenLong: {},
  mySessions: [],
  spaceOrder: [],
  worktreeOrder: {},
  tabOrder: {},
});

/** per top-level key: a map of what (number / true / id list), or one id list */
const SHAPE: Record<keyof SharedState, "number" | "true" | "ids" | "list"> = {
  seen: "number",
  dismissed: "number",
  unread: "true",
  hiddenLong: "number",
  mySessions: "list",
  spaceOrder: "list",
  worktreeOrder: "ids",
  tabOrder: "ids",
};
const MAX_IDS = 500;

const file = (name: string) => join(stateDir(), name);

function readJson(name: string): unknown {
  try {
    return JSON.parse(readFileSync(file(name), "utf8"));
  } catch {
    return undefined;
  }
}

/** Written whole and renamed into place: gate calls run in parallel and must never read half a file. */
function writeJson(name: string, data: unknown) {
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${file(name)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, file(name));
}

const isIds = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function valid(shape: (typeof SHAPE)[keyof SharedState], v: unknown): boolean {
  if (shape === "number") return typeof v === "number" && Number.isFinite(v);
  if (shape === "true") return v === true;
  return isIds(v);
}

export function loadShared(): SharedState {
  const raw = readJson(SHARED_FILE) as Partial<Record<keyof SharedState, unknown>> | undefined;
  const state = empty();
  if (!raw || typeof raw !== "object") return state;
  for (const key of Object.keys(SHAPE) as (keyof SharedState)[]) {
    const shape = SHAPE[key];
    const v = raw[key];
    if (shape === "list") {
      if (isIds(v)) (state[key] as string[]) = v.slice(0, MAX_IDS);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const map = state[key] as Record<string, unknown>;
      for (const [k, x] of Object.entries(v))
        if (valid(shape, x)) map[k] = shape === "ids" ? (x as string[]).slice(0, MAX_IDS) : x;
    }
  }
  return state;
}

/** One change: `path` = [key] for a list, [key, entry] for a map; `value` null removes the entry. */
export interface SharedChange {
  path: string[];
  value: unknown;
}

/** Applies changes in order; an invalid one throws before anything is written. */
export function applyChanges(state: SharedState, changes: SharedChange[]): SharedState {
  const next = structuredClone(state);
  for (const { path, value } of changes) {
    const key = path[0] as keyof SharedState;
    const shape = SHAPE[key];
    if (!shape) throw new Error(`Unbekannter Eintrag: ${path[0]}`);
    if (shape === "list") {
      if (path.length !== 1) throw new Error(`${key}: ganze Liste erwartet`);
      if (value === null) (next[key] as string[]) = [];
      else if (isIds(value)) (next[key] as string[]) = [...new Set(value)].slice(0, MAX_IDS);
      else throw new Error(`${key}: Liste von Ids erwartet`);
      continue;
    }
    const entry = path[1];
    if (path.length !== 2 || !entry) throw new Error(`${key}: Eintrag fehlt`);
    const map = next[key] as Record<string, unknown>;
    if (value === null) delete map[entry];
    else if (valid(shape, value))
      map[entry] = shape === "ids" ? [...new Set(value as string[])].slice(0, MAX_IDS) : value;
    else throw new Error(`${key}.${entry}: ungültiger Wert`);
  }
  return next;
}

/** Two devices changing at once must not lose one change: read–change–write runs under a lock file. */
function withLock<T>(fn: () => T): T {
  mkdirSync(stateDir(), { recursive: true });
  const lock = file(`${SHARED_FILE}.lock`);
  const until = Date.now() + 3000;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      // a lock left by a killed process
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock);
      } catch {}
      if (Date.now() > until)
        throw new Error("Gemeinsamer Zustand ist gerade gesperrt – bitte gleich noch einmal");
      Bun.sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {}
  }
}

export function patchShared(changes: SharedChange[]): SharedState {
  return withLock(() => {
    const state = loadShared();
    const next = applyChanges(state, changes);
    // every write wakes every app's feed: a patch that changes nothing must not start another round
    if (JSON.stringify(next) !== JSON.stringify(state)) writeJson(SHARED_FILE, next);
    return next;
  });
}

type StatusMap = Record<string, { status: string; since: number }>;

/**
 * Stamps every pane with `since` (when it entered its current status) and forgets shared entries of panes herdr
 * no longer has. The first look at a status counts as its start – changes while no app asked come with the time
 * the next app asked. An empty tree (herdr restarting) changes nothing.
 */
export function stampPanes(workspaces: TreeWorkspace[], now = Date.now()): void {
  const panes = workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes));
  if (!panes.length) return;
  const known = (readJson(STATUS_FILE) ?? {}) as StatusMap;
  let changed = false;
  const next: StatusMap = {};
  for (const p of panes) {
    const was = known[p.pane];
    if (was && was.status === p.status && typeof was.since === "number") next[p.pane] = was;
    else {
      next[p.pane] = { status: p.status, since: now };
      changed = true;
    }
  }
  if (Object.keys(known).some((id) => !next[id])) changed = true;
  if (changed) {
    // another call may have stamped the same change a moment ago: keep its time, so both apps get one key
    const again = (readJson(STATUS_FILE) ?? {}) as StatusMap;
    for (const [id, s] of Object.entries(next)) {
      const other = again[id];
      if (
        other &&
        other.status === s.status &&
        other.since !== s.since &&
        typeof other.since === "number"
      )
        next[id] = other;
    }
    writeJson(STATUS_FILE, next);
  }
  for (const p of panes) p.since = next[p.pane]?.since;
  pruneShared(new Set(panes.map((p) => p.pane)));
}

/** Drops pane entries for panes that are gone (herdr reuses pane ids – a new session must not inherit them). */
function pruneShared(alive: Set<string>) {
  const state = loadShared();
  const stale =
    Object.keys(state.seen).some((id) => !alive.has(id)) ||
    Object.keys(state.dismissed).some((id) => !alive.has(id)) ||
    Object.keys(state.unread).some((id) => !alive.has(id)) ||
    Object.keys(state.hiddenLong).some((id) => !alive.has(id)) ||
    state.mySessions.some((id) => !alive.has(id));
  if (!stale) return;
  const changes: SharedChange[] = [];
  for (const key of ["seen", "dismissed", "unread", "hiddenLong"] as const)
    for (const id of Object.keys(state[key]))
      if (!alive.has(id)) changes.push({ path: [key, id], value: null });
  changes.push({ path: ["mySessions"], value: state.mySessions.filter((id) => alive.has(id)) });
  try {
    patchShared(changes);
  } catch {}
}
