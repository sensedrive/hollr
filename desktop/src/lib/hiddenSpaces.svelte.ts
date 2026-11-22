// Spaces hidden with „Verstecken“: off the sidebar's main list and the dashboard, herdr keeps running. Kept on the
// server (`space` hide/unhide, `hidden` in the spaces list), so the phone shows the same; its live feed reports a
// change made on another device. Blocked sessions still show when hidden.
import { gate } from "./api";
import { hello } from "./serverapi";
import { t } from "./i18n";
import { app, refreshSpaces, type PaneRef } from "./store.svelte";
import type { FullSpace } from "./views/spaces/spaces";

/** where this app kept hidden spaces before they moved to the server (serverId|workspaceId) */
const LEGACY = "hollr.sidebar.hidden";

const spacesOf = (server: string) => (app.spaces[server] ?? []) as FullSpace[];

/** the first Hollr that keeps hidden spaces on the server */
const SINCE = [0, 47, 0];
/** an older server runs hide/unhide as some other space request – it fails or answers without the list */
async function tooOld(server: string) {
  try {
    const have = (await hello(server)).hollr.split(".").map(Number);
    for (let i = 0; i < SINCE.length; i++) if ((have[i] ?? 0) !== SINCE[i]) return (have[i] ?? 0) < SINCE[i]!;
    return false;
  } catch {
    return false;
  }
}

/** sets the flag in the loaded list right away – the server's answer and the next refresh confirm it */
function mark(server: string, ids: Set<string>) {
  const spaces = app.spaces[server];
  if (!spaces) return;
  app.spaces[server] = (spaces as FullSpace[]).map((s) => (!!s.hidden === ids.has(s.id) ? s : { ...s, hidden: ids.has(s.id) }));
}

class HiddenSpaces {
  has = (server: string, ws: string) => !!spacesOf(server).find((s) => s.id === ws)?.hidden;
  /** the server's hidden spaces, in its order */
  list = (server: string) => spacesOf(server).filter((s) => s.hidden);

  hide = (server: string, ws: string) => this.set(server, ws, true);
  unhide = (server: string, ws: string) => this.set(server, ws, false);

  private async set(server: string, ws: string, hidden: boolean) {
    const before = new Set(this.list(server).map((s) => s.id));
    const next = new Set(before);
    if (hidden) next.add(ws);
    else next.delete(ws);
    mark(server, next);
    try {
      const r = await gate<{ hidden?: string[] }>(server, "space", { op: hidden ? "hide" : "unhide", ws });
      if (!Array.isArray(r.hidden)) throw new Error("no hidden list");
      mark(server, new Set(r.hidden));
    } catch (e) {
      mark(server, before);
      if (await tooOld(server)) throw new Error(t("Hollr auf diesem Server ist zu alt zum Verstecken – in Werkzeuge aktualisieren."));
      throw e;
    }
    // a refresh that started before the change must not bring the old state back
    void refreshSpaces(server);
  }

  /** Moves what this app hid on its own (before 0.47) to the server, once its spaces are loaded. */
  async migrate(server: string) {
    let legacy: string[];
    try {
      legacy = JSON.parse(localStorage.getItem(LEGACY) ?? "[]");
    } catch {
      legacy = [];
    }
    const mine = legacy.filter((key) => key.startsWith(`${server}|`));
    if (!mine.length) return;
    const ids = new Set(spacesOf(server).map((s) => s.id));
    for (const key of mine) {
      const ws = key.slice(server.length + 1);
      if (ids.has(ws) && !this.has(server, ws)) {
        try {
          await this.set(server, ws, true);
        } catch {
          return; // server too old: try again after its update
        }
      }
    }
    const rest = legacy.filter((key) => !mine.includes(key));
    try {
      if (rest.length) localStorage.setItem(LEGACY, JSON.stringify(rest));
      else localStorage.removeItem(LEGACY);
    } catch {}
  }
}

export const hiddenSpaces = new HiddenSpaces();

/** the session's space is off the list and it doesn't wait for you */
export const isHidden = (r: PaneRef) => r.pane.status !== "blocked" && hiddenSpaces.has(r.server.id, r.workspace.id);
