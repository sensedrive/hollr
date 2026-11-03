// Spaces taken off the list ("Aus der Liste nehmen", "serverId|workspaceId"): gone from the sidebar and the
// dashboard alike, per computer. A session there that waits for you shows up anyway.
import type { PaneRef } from "./store.svelte";

const KEY = "hollr.sidebar.hidden";

function load(): Set<string> {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return new Set<string>();
  }
}

class HiddenSpaces {
  ids = $state(load());
  has = (server: string, ws: string) => this.ids.has(`${server}|${ws}`);
  hide(server: string, ws: string) {
    this.set(new Set(this.ids).add(`${server}|${ws}`));
  }
  showAll() {
    this.set(new Set());
  }
  private set(ids: Set<string>) {
    this.ids = ids;
    try {
      localStorage.setItem(KEY, JSON.stringify([...ids]));
    } catch {}
  }
}

export const hiddenSpaces = new HiddenSpaces();

/** the session's space is off the list and it doesn't wait for you */
export const isHidden = (r: PaneRef) => r.pane.status !== "blocked" && hiddenSpaces.has(r.server.id, r.workspace.id);
