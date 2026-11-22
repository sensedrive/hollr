// What this app shares with the phone, per server (`hollr gate shared`): seen / dismissed / unread results,
// hidden long runs, "Meine Sitzungen" and the dragged order of spaces, worktrees and tabs. The server keeps it, so
// both apps show the same; its live feed says `shared` when another device changed it (listenFeeds loads again).
// Changes show right away and are sent as a patch; a failed one is taken back. A server whose Hollr doesn't know
// `shared` yet gets a doc that lives in memory only.
import { gate } from "./api";
import { alertAsk } from "./ask.svelte";
import { t } from "./i18n";
import {
  applyChanges, dropServer, effective, emptyShared, migrationChanges, normalize, type Legacy, type SharedChange,
  type SharedState,
} from "./sharedState";

export type { SharedChange, SharedState } from "./sharedState";

const EMPTY: SharedState = Object.freeze(emptyShared());

/** Not migrated (the old values don't map onto the shared keys) – just gone. */
const DROPPED = ["hollr.inbox.seen", "hollr.inbox.since", "hollr.inbox.unread", "hollr.inbox.status", "hollr.hiddenLong"];
/** Moved to each server once (sharedState.ts migrationChanges), then removed entry by entry. */
const LEGACY = {
  mySessions: "hollr.mySessions",
  spaceOrder: "hollr.sidebar.order",
  worktreeOrder: "hollr.sidebar.wtorder",
  tabOrder: "hollr.tabOrder",
} as const;

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
const asMap = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string[]>) : {});

function readLegacy(): Legacy {
  const my = readJson(LEGACY.mySessions);
  return {
    mySessions: Array.isArray(my) ? my.filter((x): x is string => typeof x === "string") : [],
    spaceOrder: asMap(readJson(LEGACY.spaceOrder)),
    worktreeOrder: asMap(readJson(LEGACY.worktreeOrder)),
    tabOrder: asMap(readJson(LEGACY.tabOrder)),
  };
}

function writeLegacy(local: Legacy) {
  try {
    for (const key of Object.keys(LEGACY) as (keyof Legacy)[]) {
      const v = local[key];
      if (Array.isArray(v) ? v.length : Object.keys(v).length) localStorage.setItem(LEGACY[key], JSON.stringify(v));
      else localStorage.removeItem(LEGACY[key]);
    }
  } catch {}
}

if (typeof localStorage !== "undefined")
  try {
    for (const key of DROPPED) localStorage.removeItem(key);
  } catch {}

/** an older server answers `shared` with not_allowed */
const tooOld = (e: unknown) => e instanceof Error && e.message === "not_allowed";

/** a failed change from a click or drag – shown like other failed actions */
export const showError = (e: unknown) => void alertAsk(t("Fehler"), e instanceof Error ? e.message : String(e));

interface Pending {
  seq: number;
  changes: SharedChange[];
}

class Shared {
  /** per server: the doc as shown – the server's plus own changes still on their way (replaced whole, never
   *  changed in place) */
  docs = $state.raw<Record<string, SharedState>>({});

  /** not reactive: the server's last answer, own changes in flight, and which servers are old */
  private base: Record<string, SharedState> = {};
  private pending: Record<string, Pending[]> = {};
  private writes: Record<string, number> = {};
  private answered: Record<string, number> = {};
  private old = new Set<string>();
  private loading: Record<string, Promise<void> | undefined> = {};
  private again = new Set<string>();
  private paired: string[] = [];

  /** the server's doc (empty until loaded) */
  of = (server: string): SharedState => this.docs[server] ?? EMPTY;

  private show(server: string) {
    const own = (this.pending[server] ?? []).flatMap((p) => p.changes);
    this.docs = { ...this.docs, [server]: applyChanges(this.base[server] ?? EMPTY, own) };
  }

  /** The paired servers changed (or the app started): load every one of them. */
  sync(servers: string[]) {
    this.paired = servers;
    for (const s of servers) void this.load(s);
  }

  /** Loads the server's doc – at start, after a reconnect, and when its feed reports a change. A call while a load
   *  runs loads once more afterwards (that load may have read the doc before the change). */
  load(server: string): Promise<void> {
    const running = this.loading[server];
    if (running) {
      this.again.add(server);
      return running;
    }
    const run = async () => {
      do {
        this.again.delete(server);
        await this.fetch(server);
      } while (this.again.has(server));
    };
    return (this.loading[server] = run().finally(() => delete this.loading[server]));
  }

  private async fetch(server: string) {
    const started = this.writes[server] ?? 0;
    try {
      const r = await gate<{ shared?: unknown }>(server, "shared", { op: "get" });
      this.old.delete(server);
      // an own change went out meanwhile: its answer (or the feed after it) brings the newer doc
      if ((this.writes[server] ?? 0) === started) {
        this.base[server] = normalize(r.shared);
        this.show(server);
      }
      await this.migrate(server);
    } catch (e) {
      if (!tooOld(e) || this.old.has(server)) return; // unreachable: the next reconnect or refresh loads again
      this.old.add(server);
      // works from memory, starting from what this app kept on its own until that server is updated
      this.base[server] ??= applyChanges(emptyShared(), migrationChanges(EMPTY, server, readLegacy()));
      this.show(server);
    }
  }

  /** What this app kept on its own goes to the server once; then it is removed here. */
  private async migrate(server: string) {
    const local = readLegacy();
    const changes = migrationChanges(this.of(server), server, local);
    if (changes.length)
      try {
        await this.send(server, changes);
      } catch {
        return; // kept – the next load tries again
      }
    // read again: the tab bar may have written its own entry meanwhile
    writeLegacy(dropServer(readLegacy(), server, this.paired));
  }

  /**
   * Changes the server's doc. `make` gets the doc once it is loaded (whole lists are written, so an unloaded doc
   * would wipe them); unchanged values are left out, nothing changed sends nothing. Throws when the server
   * refuses – the change is taken back then.
   */
  async update(server: string, make: (doc: SharedState) => SharedChange[]) {
    if (!this.docs[server]) await (this.loading[server] ?? this.load(server));
    if (!this.docs[server]) throw new Error(t("Der Server ist gerade nicht erreichbar."));
    await this.send(server, make(this.of(server)));
  }

  private async send(server: string, all: SharedChange[]) {
    const changes = effective(this.of(server), all);
    if (!changes.length) return;
    const seq = (this.writes[server] = (this.writes[server] ?? 0) + 1);
    const mine: Pending = { seq, changes };
    (this.pending[server] ??= []).push(mine);
    this.show(server);
    const done = () => (this.pending[server] = (this.pending[server] ?? []).filter((p) => p !== mine));
    if (this.old.has(server)) {
      done();
      this.base[server] = applyChanges(this.base[server] ?? EMPTY, changes);
      return this.show(server);
    }
    try {
      const r = await gate<{ shared?: unknown }>(server, "shared", { op: "patch", changes });
      done();
      // answers can overtake each other: a later change's answer already holds this one
      if (seq > (this.answered[server] ?? 0)) {
        this.answered[server] = seq;
        this.base[server] = normalize(r.shared);
      }
      this.show(server);
    } catch (e) {
      done();
      if (tooOld(e)) {
        this.old.add(server);
        this.base[server] = applyChanges(this.base[server] ?? EMPTY, changes);
        return this.show(server);
      }
      this.show(server);
      throw e;
    }
  }
}

export const shared = new Shared();
