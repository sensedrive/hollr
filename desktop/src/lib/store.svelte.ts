// App-wide state: paired servers, herdr trees and spaces (refreshed every 5 s), "my sessions",
// navigation and the global dialogs. Views read from here instead of loading on their own.
import * as api from "./api";
import type { Pane, Server, Workspace } from "./api";
import { type Space, spaces as loadSpaces } from "./git";

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
  | { view: "agent"; server: string; pane: string }
  | { view: "settings"; page?: "design" | "servers" | "notes" | "about" }
  | { view: "serverinfo"; server: string }
  | { view: "tools"; server: string };

export const nav = $state<{ route: Route; history: Route[] }>({ route: { view: "dashboard" }, history: [] });

export function go(route: Route) {
  if (JSON.stringify(route) === JSON.stringify(nav.route)) return;
  nav.history = [...nav.history.slice(-30), nav.route];
  nav.route = route;
  if (route.view === "agent") mySessions.touch(`${route.server}|${route.pane}`);
}

export function back() {
  const prev = nav.history.at(-1);
  nav.history = nav.history.slice(0, -1);
  nav.route = prev ?? { view: "dashboard" };
}

export const openAgent = (server: string, pane: string) => go({ view: "agent", server, pane });

// ------------------------------------------------------------ dialogs

export const dialogs = $state({
  pair: false,
  /** new session; optional preset server / workspace */
  newSession: null as null | { server?: string; ws?: string },
  newSpace: null as null | { server?: string },
});

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

/** herdr numbers unnamed tabs: show the workspace name instead of "1" */
export const tabName = (tab: string, workspace: string) => (/^(Tab )?\d+$/.test(tab) ? workspace : tab);

export function allPanes(serverId?: string): PaneRef[] {
  const out: PaneRef[] = [];
  for (const server of app.servers) {
    if (serverId && server.id !== serverId) continue;
    for (const workspace of app.trees[server.id] ?? [])
      for (const tab of workspace.tabs)
        for (const pane of tab.panes) out.push({ server, workspace, tab, pane, id: `${server.id}|${pane.pane}` });
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
    await refresh(server);
    if (spaces) await refreshSpaces(server);
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

export async function refresh(...only: string[]) {
  await Promise.all(
    app.servers.filter((s) => !only.length || only.includes(s.id)).map(async (s) => {
      try {
        app.trees[s.id] = await api.tree(s.id);
        delete app.errors[s.id];
      } catch (e) {
        app.errors[s.id] = String(e instanceof Error ? e.message : e);
      } finally {
        app.loaded[s.id] = true;
      }
    }),
  );
  // forget my sessions whose pane is gone on a server that just answered
  const alive = new Set(allPanes().map((r) => r.id));
  const answered = new Set(app.servers.filter((s) => !app.errors[s.id]).map((s) => s.id));
  const kept = mySessions.ids.filter((id) => !answered.has(id.split("|")[0] ?? "") || alive.has(id));
  if (kept.length !== mySessions.ids.length) {
    mySessions.ids = kept;
    mySessions.save();
  }
}

export async function refreshSpaces(serverId?: string) {
  await Promise.all(
    app.servers
      .filter((s) => !serverId || s.id === serverId)
      .map(async (s) => {
        try {
          app.spaces[s.id] = await loadSpaces(s.id);
        } catch (e) {
          app.errors[s.id] = String(e instanceof Error ? e.message : e);
        }
      }),
  );
}
