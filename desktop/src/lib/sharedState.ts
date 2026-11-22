// What the desktop app and the phone share per server (`hollr gate shared`, server/src/shared.ts): the doc's shape
// and its change rules, mirrored here so a change shows right away (optimistic) and an unchanged value is never
// sent. Pure – the per-server store lives in shared.svelte.ts.

export interface SharedState {
  /** pane → the `since` of the status whose result was looked at (on any device) */
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

export type SharedKey = keyof SharedState;

/** `path` = [key] for a list, [key, entry] for a map; `value` null removes the entry (empties the list). */
export interface SharedChange {
  path: [SharedKey] | [SharedKey, string];
  value: unknown;
}

/** "Meine Sitzungen" keeps this many */
export const MY_SESSIONS_MAX = 60;

const LISTS = new Set<SharedKey>(["mySessions", "spaceOrder"]);
const KEYS: SharedKey[] = ["seen", "dismissed", "unread", "hiddenLong", "mySessions", "spaceOrder", "worktreeOrder", "tabOrder"];

export const emptyShared = (): SharedState => ({
  seen: {},
  dismissed: {},
  unread: {},
  hiddenLong: {},
  mySessions: [],
  spaceOrder: [],
  worktreeOrder: {},
  tabOrder: {},
});

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The server's answer as a full doc – anything malformed counts as absent. */
export function normalize(raw: unknown): SharedState {
  const out = emptyShared();
  if (!isMap(raw)) return out;
  for (const key of KEYS) {
    const v = raw[key];
    if (LISTS.has(key)) {
      if (isIds(v)) (out[key] as string[]) = v;
      continue;
    }
    if (!isMap(v)) continue;
    const map = out[key] as Record<string, unknown>;
    for (const [k, x] of Object.entries(v)) {
      const ok = key === "unread" ? x === true : key === "worktreeOrder" || key === "tabOrder" ? isIds(x) : typeof x === "number";
      if (ok) map[k] = x;
    }
  }
  return out;
}

export function valueAt(state: SharedState, path: SharedChange["path"]): unknown {
  const v = state[path[0]];
  return path.length === 1 ? v : (v as Record<string, unknown>)[path[1]];
}

/** null, absent and an empty list mean the same to the server */
export function sameValue(a: unknown, b: unknown): boolean {
  const none = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && !v.length);
  if (none(a) || none(b)) return none(a) && none(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/** Applies changes like the server does (it validates; here they come from this app only). */
export function applyChanges(state: SharedState, changes: SharedChange[]): SharedState {
  if (!changes.length) return state;
  const next = { ...state };
  for (const { path, value } of changes) {
    const key = path[0];
    if (path.length === 1) {
      (next[key] as string[]) = isIds(value) ? [...new Set(value)] : [];
      continue;
    }
    const map = { ...(next[key] as Record<string, unknown>) };
    if (value === null || value === undefined) delete map[path[1]];
    else map[path[1]] = value;
    (next[key] as Record<string, unknown>) = map;
  }
  return next;
}

/** only the changes that change something – the rest is never sent */
export const effective = (state: SharedState, changes: SharedChange[]) =>
  changes.filter((c) => !sameValue(valueAt(state, c.path), c.value));

/** `ids` with `id` in front, at most `max` */
export const toFront = (ids: readonly string[], id: string, max = MY_SESSIONS_MAX) =>
  [id, ...ids.filter((x) => x !== id)].slice(0, max);

/** removals for map entries whose space is gone – orders of closed spaces would pile up otherwise */
export const staleEntries = (key: "worktreeOrder" | "tabOrder", map: Record<string, unknown>, alive: Set<string>): SharedChange[] =>
  Object.keys(map).filter((k) => !alive.has(k)).map((k) => ({ path: [key, k], value: null }));

// ------------------------------------------------------------ one-time move of what this app kept on its own

/** What earlier versions kept in localStorage, keyed by this app's own server ids. */
export interface Legacy {
  /** "serverId|pane", newest first (`hollr.mySessions`) */
  mySessions: string[];
  /** serverId → group order (`hollr.sidebar.order`) */
  spaceOrder: Record<string, string[]>;
  /** "serverId|repoSpace" → worktree order (`hollr.sidebar.wtorder`) */
  worktreeOrder: Record<string, string[]>;
  /** "serverId|workspace" → tab order, plus the server tabs' own "servers" entry (`hollr.tabOrder`) */
  tabOrder: Record<string, string[]>;
}

const serverOf = (key: string) => (key.includes("|") ? key.slice(0, key.indexOf("|")) : undefined);

/** the entries of `map` keyed "server|rest", as rest → value */
function mine(map: Record<string, string[]>, server: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(map)) if (serverOf(k) === server && isIds(v) && v.length) out[k.slice(server.length + 1)] = v;
  return out;
}

/** This server's legacy values as changes – for the entries the shared doc has nothing in yet (another device may
 *  have filled them already; those win). Maps go entry by entry: one tab order dragged on the phone must not keep
 *  every other workspace's order here from moving over. */
export function migrationChanges(doc: SharedState, server: string, local: Legacy): SharedChange[] {
  const out: SharedChange[] = [];
  if (!doc.mySessions.length) {
    const panes = local.mySessions.filter((id) => serverOf(id) === server).map((id) => id.slice(server.length + 1));
    if (panes.length) out.push({ path: ["mySessions"], value: [...new Set(panes)].slice(0, MY_SESSIONS_MAX) });
  }
  const order = local.spaceOrder[server];
  if (!doc.spaceOrder.length && isIds(order) && order.length) out.push({ path: ["spaceOrder"], value: order });
  for (const key of ["worktreeOrder", "tabOrder"] as const)
    for (const [k, v] of Object.entries(mine(local[key], server)))
      if (!doc[key][k]?.length) out.push({ path: [key, k], value: v });
  return out;
}

/**
 * The legacy values without what the server now holds for `server` (`doc`: its doc after the migration;
 * `written`: the migration's changes the server took – "Meine Sitzungen" may be pruned there right away, since it
 * forgets closed sessions). Anything else stays: a value another device's won over, and every value of another
 * server id – also one no longer paired (a re-paired machine gets a new id here; its old values are kept rather
 * than lost unseen).
 */
export function settled(local: Legacy, server: string, doc: SharedState, written: SharedChange[] = []): Legacy {
  const own = (key: string) => serverOf(key) === server;
  const wrote = (key: SharedKey) => written.some((c) => c.path[0] === key);
  const held = (key: "worktreeOrder" | "tabOrder") =>
    Object.fromEntries(Object.entries(local[key]).filter(([k, v]) => !own(k) || !sameValue(doc[key][k.slice(server.length + 1)], v)));
  const sessionsHeld = wrote("mySessions") || local.mySessions.filter(own).every((id) => doc.mySessions.includes(id.slice(server.length + 1)));
  return {
    mySessions: sessionsHeld ? local.mySessions.filter((id) => !own(id)) : local.mySessions,
    spaceOrder: Object.fromEntries(Object.entries(local.spaceOrder).filter(([s, v]) => s !== server || !sameValue(doc.spaceOrder, v))),
    worktreeOrder: held("worktreeOrder"),
    tabOrder: held("tabOrder"),
  };
}
