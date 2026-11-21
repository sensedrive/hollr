// Spaces hidden with „Verstecken" (serverId|workspaceId): off the sidebar and dashboard, herdr keeps running.
// „Aus der Liste nehmen" closes the workspace in herdr instead. Blocked sessions still show when hidden.
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
  unhide(server: string, ws: string) {
    const key = `${server}|${ws}`;
    if (!this.ids.has(key)) return;
    const next = new Set(this.ids);
    next.delete(key);
    this.set(next);
  }
  /** shows a server's hidden spaces again */
  showAll(server: string) {
    this.set(new Set([...this.ids].filter((id) => !id.startsWith(`${server}|`))));
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
