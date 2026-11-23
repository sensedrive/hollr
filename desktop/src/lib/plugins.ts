// Plugins on a server (`plugins` gate, server/src/plugins.ts): list them, start one's web UI.
import { gate } from "./api";
import { settings } from "./settings.svelte";

// ---- pinned plugins: shown as their own entries in the sidebar's top navigation

export const isPinned = (server: string, id: string) => settings.pinnedPlugins.some((p) => p.server === server && p.id === id);

export function togglePin(server: string, id: string, name: string): void {
  settings.pinnedPlugins = isPinned(server, id)
    ? settings.pinnedPlugins.filter((p) => !(p.server === server && p.id === id))
    : [...settings.pinnedPlugins, { server, id, name }];
}

export interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  /** gate commands the app relays for the plugin page */
  host?: { gate: string[] };
  error?: string;
}

export const listPlugins = (server: string) =>
  gate<{ plugins: PluginInfo[] }>(server, "plugins", { op: "list" }).then((r) => r.plugins);

/** Starts the plugin if needed; `url` is http://localhost:<port>/#token=… on the server. */
export const openPlugin = (server: string, id: string) =>
  gate<{ port: number; url: string }>(server, "plugins", { op: "open", id });

/** per server for this app session: whether it lists the Sandcastle plugin (the board) */
const hasBoard = new Map<string, Promise<boolean>>();

function listsBoard(server: string) {
  let p = hasBoard.get(server);
  if (!p) {
    p = listPlugins(server).then(
      (l) => l.some((x) => x.id === "sandcastle" && !x.error),
      () => {
        hasBoard.delete(server); // offline or too old: ask again next time
        return false;
      },
    );
    hasBoard.set(server, p);
  }
  return p;
}

/** The server whose Sandcastle board to show: `prefer` when it has the plugin, else the first of `servers` that does. */
export async function boardServer(prefer: string, servers: string[]): Promise<string | undefined> {
  if (await listsBoard(prefer)) return prefer;
  for (const s of servers) if (s !== prefer && (await listsBoard(s))) return s;
  return undefined;
}
