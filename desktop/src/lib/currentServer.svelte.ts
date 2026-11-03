// The remote you are on: the server of the open view (session, space, server info, tools); on views without
// one (overview, agents, settings) the last one. The server tabs show it, the sidebar lists only its spaces.
import { app, nav } from "./store.svelte";

const KEY = "hollr.currentServer";

const picked = $state({ id: localStorage.getItem(KEY) ?? "" });

$effect.root(() => {
  $effect(() => {
    const r = nav.route;
    if (!("server" in r) || r.server === picked.id) return;
    picked.id = r.server;
    try {
      localStorage.setItem(KEY, r.server);
    } catch {}
  });
});

/** the current remote's id – a paired one, else the first (first start, removed server) */
export function currentServer(): string {
  return app.servers.some((s) => s.id === picked.id) ? picked.id : (app.servers[0]?.id ?? "");
}
