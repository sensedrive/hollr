// App-wide state: paired servers, herdr trees and spaces (refreshed every 5 s), "my sessions",
// navigation and the global dialogs. Views read from here instead of loading on their own.
import { isSideChatLabel } from "./sidechats.svelte";
import * as api from "./api";
import type { Pane, Server, Workspace } from "./api";
import { type Space, spaces as loadSpaces } from "./git";
import * as d from "./drafts";
import { chatLabel } from "./contextChatText";
import { LAST_TAB_KEY, lastTabKey, parseLastTabs, restoreTab } from "./lastTab";

export const app = $state({
  servers: [] as Server[],
  trees: {} as Record<string, Workspace[]>,
  spaces: {} as Record<string, Space[]>,
  errors: {} as Record<string, string>,
  /** first tree load per server finished (for skeletons) */
  loaded: {} as Record<string, boolean>,
  /** live change feed connected (then polling is only a slow safety net) */
  live: {} as Record<string, boolean>,
  /** bumped on every pushed change – views that load on their own can react */
  changes: 0,
});

// ------------------------------------------------------------ navigation

export type Route =
  | { view: "dashboard" }
  | { view: "agents" }
  | { view: "spaces" }
  | { view: "space"; server: string; ws: string }
  /** `open`: show the terminal, or the git / browser side panel right away (`url` for the browser) */
  | { view: "agent"; server: string; pane: string; open?: AgentOpen; url?: string }
  | { view: "settings"; page?: "design" | "servers" | "notes" | "about" | "dictation" | "speech" }
  | { view: "serverinfo"; server: string }
  | { view: "tools"; server: string };

export type AgentOpen = "terminal" | "git" | "browser";

export const nav = $state<{ route: Route; history: Route[] }>({ route: { view: "dashboard" }, history: [] });

export function go(route: Route) {
  if (JSON.stringify(route) === JSON.stringify(nav.route)) return;
  nav.history = [...nav.history.slice(-30), nav.route];
  nav.route = route;
  if (route.view === "agent") mySessions.touch(`${route.server}|${route.pane}`);
  rememberTab(route);
}

// ---- the tab each space had selected last (its overview or a session): switching spaces comes back to it
const lastTabs: Record<string, string> = (() => {
  try {
    return parseLastTabs(localStorage.getItem(LAST_TAB_KEY));
  } catch {
    return {};
  }
})();

function rememberTab(route: Route) {
  let key: string;
  let value: string;
  if (route.view === "space") [key, value] = [lastTabKey(route.server, route.ws), ""];
  else if (route.view === "agent") {
    const ref = findPane(route.server, route.pane);
    if (!ref) return;
    [key, value] = [lastTabKey(route.server, ref.workspace.id), route.pane];
  } else return;
  if (lastTabs[key] === value) return;
  lastTabs[key] = value;
  try {
    localStorage.setItem(LAST_TAB_KEY, JSON.stringify(lastTabs));
  } catch {}
}

/** the tab to show when switching to a space: the one selected there last, if it still exists */
export function lastTabRoute(server: string, ws: string): Route | undefined {
  const panes = allPanes(server).filter((r) => r.workspace.id === ws).map((r) => r.pane.pane);
  const hit = restoreTab(lastTabs[lastTabKey(server, ws)], panes);
  if (!hit) return undefined;
  return "pane" in hit ? { view: "agent", server, pane: hit.pane } : { view: "space", server, ws };
}

export function back() {
  const prev = nav.history.at(-1);
  nav.history = nav.history.slice(0, -1);
  nav.route = prev ?? { view: "dashboard" };
  rememberTab(nav.route);
}

export const openAgent = (server: string, pane: string) => go({ view: "agent", server, pane });

// ------------------------------------------------------------ dialogs

export const dialogs = $state({
  pair: false,
  /** new session; optional preset server / workspace */
  newSession: null as null | { server?: string; ws?: string },
  newSpace: null as null | { server?: string },
});

/** Last field values of the create dialogs, so an accidental close loses nothing (this run only). */
export const dialogMemory = {
  newSession: { folder: "", label: "" },
  newSpace: { branch: "", base: "", folder: "~/projects/", label: "" },
};

// ------------------------------------------------------------ drafts (unsent composer text)

/** Composer text per session ("serverId|pane"), saved shortly after each change and when the window goes. */
class DraftStore {
  all = $state<d.Drafts>(this.load());
  /** ↑ history per session (memory only) */
  #recall: Record<string, string[]> = {};
  #timer: ReturnType<typeof setTimeout> | undefined;

  load(): d.Drafts {
    try {
      return d.parseDrafts(localStorage.getItem(d.DRAFTS_KEY));
    } catch {
      return {};
    }
  }
  text = (key: string) => this.all[key]?.text ?? "";
  setText(key: string, text: string) {
    d.setText(this.all, key, text);
    this.save();
  }
  beginSend(key: string, msg: string) {
    d.beginSend(this.all, key, msg);
    this.save();
  }
  endSend(key: string, msg: string, ok: boolean) {
    d.endSend(this.all, key, msg, ok);
    this.save();
  }
  recall = (key: string) => this.#recall[key] ?? [];
  setRecall(key: string, list: string[]) {
    this.#recall[key] = list.slice(0, d.RECALL_MAX);
  }
  save() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), 300);
  }
  flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      localStorage.setItem(d.DRAFTS_KEY, d.serializeDrafts($state.snapshot(this.all)));
    } catch {}
  }
}

export const drafts = new DraftStore();
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => drafts.flush());
  window.addEventListener("pagehide", () => drafts.flush());
}

// ------------------------------------------------------------ my sessions

const MY = "hollr.mySessions";

function loadMy(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MY) ?? "[]");
  } catch {
    return [];
  }
}

/** Sessions opened or started in Hollr ("serverId|pane", most recent first) – the dashboard shows these. */
class MySessions {
  ids = $state<string[]>(loadMy());
  touch(id: string) {
    if (this.ids[0] === id) return;
    this.ids = [id, ...this.ids.filter((x) => x !== id)];
    this.save();
  }
  remove(id: string) {
    this.ids = this.ids.filter((x) => x !== id);
    this.save();
  }
  /** keeps only the ids `keep` accepts */
  prune(keep: (id: string) => boolean) {
    const kept = this.ids.filter(keep);
    if (kept.length === this.ids.length) return;
    this.ids = kept;
    this.save();
  }
  save() {
    try {
      localStorage.setItem(MY, JSON.stringify(this.ids));
    } catch {}
  }
}

export const mySessions = new MySessions();

// ------------------------------------------------------------ lookups

export interface PaneRef {
  server: Server;
  workspace: Workspace;
  tab: Workspace["tabs"][number];
  pane: Pane;
  /** "serverId|pane" */
  id: string;
}

/** shown name of a herdr tab: unnamed ones (herdr numbers them) by their workspace; forks from earlier versions
 *  without their old prefix (contextChatText.ts) */
export const tabName = (tab: string, workspace: string) => (/^(Tab )?\d+$/.test(tab) ? workspace : chatLabel(tab));

export function allPanes(serverId?: string): PaneRef[] {
  const out: PaneRef[] = [];
  for (const server of app.servers) {
    if (serverId && server.id !== serverId) continue;
    for (const workspace of app.trees[server.id] ?? [])
      for (const tab of workspace.tabs)
        for (const pane of tab.panes) {
          // a sidechat's fork lives in its session's "Nachfragen" panel, not in lists, tabs or the inbox
          if (pane.fork && isSideChatLabel(tab.label)) continue;
          out.push({ server, workspace, tab, pane, id: `${server.id}|${pane.pane}` });
        }
  }
  return out;
}

export const findPane = (server: string, pane: string) =>
  allPanes(server).find((r) => r.pane.pane === pane);

export const serverById = (id: string) => app.servers.find((s) => s.id === id);

// ------------------------------------------------------------ loading

export async function loadServers() {
  app.servers = await api.servers();
  if (!app.servers.length) dialogs.pair = true;
  api.feedsSync(app.servers.map((s) => s.id)).catch(() => {});
  await refresh();
}

/** Pushed changes from the servers' live feeds (`hollr gate events`). */
export async function listenFeeds(): Promise<() => void> {
  const offChanged = await api.onChanged(async ({ server, spaces }) => {
    app.changes++;
    if (!spaces) refreshSpacesSoon(server);
    // side by side: a pull's ↓N shouldn't wait for the session tree
    await Promise.all([refresh(server), spaces && refreshSpaces(server)]);
  });
  const offLive = await api.onFeed(({ server, live }) => {
    app.live[server] = live;
  });
  return () => {
    offChanged();
    offLive();
  };
}

/** Polling: fast while a server has no live feed, otherwise only every 30 s as a safety net. */
let lastFull = 0;
export function poll() {
  const full = Date.now() - lastFull > 30_000;
  if (full) lastFull = Date.now();
  const due = app.servers.filter((s) => full || !app.live[s.id]).map((s) => s.id);
  if (due.length) refresh(...due);
}

/** per server: newest tree request – an older answer arriving later must not overwrite it */
const treeSeq: Record<string, number> = {};

export async function refresh(...only: string[]) {
  await Promise.all(
    app.servers.filter((s) => !only.length || only.includes(s.id)).map(async (s) => {
      const seq = (treeSeq[s.id] = (treeSeq[s.id] ?? 0) + 1);
      try {
        const tree = await api.tree(s.id);
        if (seq !== treeSeq[s.id]) return;
        app.trees[s.id] = tree;
        delete app.errors[s.id];
      } catch (e) {
        if (seq !== treeSeq[s.id]) return;
        app.errors[s.id] = String(e instanceof Error ? e.message : e);
      } finally {
        app.loaded[s.id] = true;
      }
    }),
  );
  // forget my sessions whose pane is gone on a server that just answered
  const alive = new Set(allPanes().map((r) => r.id));
  const answered = new Set(app.servers.filter((s) => !app.errors[s.id]).map((s) => s.id));
  mySessions.prune((id) => !answered.has(id.split("|")[0] ?? "") || alive.has(id));
}

/** when each server's spaces (with their git state) were last loaded */
const spacesAt: Record<string, number> = {};
const spacesSoon: Record<string, ReturnType<typeof setTimeout>> = {};
/** per server: newest spaces request – a pull right after a fetch sends two quick changes; the older answer
 *  arriving last must not bring back the old ↓N */
const spacesSeq: Record<string, number> = {};

export async function refreshSpaces(serverId?: string) {
  await Promise.all(
    app.servers
      .filter((s) => !serverId || s.id === serverId)
      .map(async (s) => {
        const seq = (spacesSeq[s.id] = (spacesSeq[s.id] ?? 0) + 1);
        try {
          const spaces = await loadSpaces(s.id);
          if (seq !== spacesSeq[s.id]) return;
          app.spaces[s.id] = spaces;
          spacesAt[s.id] = Date.now();
        } catch (e) {
          if (seq !== spacesSeq[s.id]) return;
          app.errors[s.id] = String(e instanceof Error ? e.message : e);
        }
      }),
  );
}

/** Session activity (status, title, folder) may come with a commit or checkout the server's git watch already
 *  reported (`spaces: true`) – or, on servers before that watch, didn't: reload the spaces, at most every 5 s. */
function refreshSpacesSoon(server: string) {
  if (spacesSoon[server]) return;
  const wait = Math.max(0, (spacesAt[server] ?? 0) + 5_000 - Date.now());
  spacesSoon[server] = setTimeout(() => {
    delete spacesSoon[server];
    void refreshSpaces(server);
  }, wait);
}

/** The safety net, every 10 s from the space lists: servers without a live feed each time, the others every
 *  30 s (a change the server's git watch missed, e.g. a repo past its refs-folder budget). */
export function pollSpaces() {
  const now = Date.now();
  for (const s of app.servers) {
    if (!app.live[s.id] || now - (spacesAt[s.id] ?? 0) >= 30_000) void refreshSpaces(s.id);
  }
}
