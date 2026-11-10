// Plugins on a server (`plugins` gate, server/src/plugins.ts): list them, start one's web UI.
import { gate } from "./api";

export interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  error?: string;
}

export const listPlugins = (server: string) =>
  gate<{ plugins: PluginInfo[] }>(server, "plugins", { op: "list" }).then((r) => r.plugins);

/** Starts the plugin if needed; `url` is http://localhost:<port>/#token=… on the server. */
export const openPlugin = (server: string, id: string) =>
  gate<{ port: number; url: string }>(server, "plugins", { op: "open", id });
