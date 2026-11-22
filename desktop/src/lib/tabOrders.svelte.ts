// The server tabs' order dragged into place – per computer (the server ids are this app's own). It lives in the
// "servers" entry of `hollr.tabOrder`; the other entries there are a workspace's tab orders from earlier versions,
// waiting to move to their server's shared doc (shared.svelte.ts), so they are left alone here.
const KEY = "hollr.tabOrder";

function load(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

class ServerOrder {
  ids = $state<string[] | undefined>(load().servers);
  set(ids: string[]) {
    this.ids = ids;
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...load(), servers: ids }));
    } catch {}
  }
}

export const serverOrder = new ServerOrder();
