// The tab orders dragged into place, per computer: "servers" for the server tabs, "serverId|workspaceId" for a
// workspace's tabs (herdr tab ids). Only the most recently changed are kept.
const KEY = "hollr.tabOrder";
const MAX = 300;

function load(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

class TabOrders {
  all = $state(load());
  set(key: string, ids: string[]) {
    const { [key]: _, ...rest } = this.all;
    const keys = Object.keys(rest);
    for (const k of keys.slice(0, Math.max(0, keys.length + 1 - MAX))) delete rest[k];
    this.all = { ...rest, [key]: ids };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.all));
    } catch {}
  }
}

export const tabOrders = new TabOrders();
