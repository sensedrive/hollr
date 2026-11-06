// How the space view and the git panel are laid out: column widths, what is collapsed, list/detail
// side by side or stacked. Remembered per computer and per place (space view, a session's side panel …).
// A session's side panel (which tab, or closed) is one choice for all sessions: switching
// session, space or worktree keeps it open – or closed. The git panel's tab is remembered the same way, per place.
import type { Tab } from "./components/git/nav";

/** list and detail: side by side, stacked (list on top), or chosen by the available width */
export type Arrange = "auto" | "side" | "stack";
/** where a git panel lives – each place keeps its own layout */
export type GitPlace = "space" | "side" | "dialog";

export interface GitLayout {
  /** Dateien / Änderungen / Verlauf / Branches as last left */
  tab: Tab;
  arrange: Arrange;
  /** list width when side by side */
  listW: number;
  /** list height when stacked */
  listH: number;
  /** detail takes the whole area (only while something is open) */
  listHidden: boolean;
}

export interface SpaceLayout {
  /** width of the space column (info + sessions) */
  leftW: number;
  leftHidden: boolean;
}

export const GIT_LAYOUT: GitLayout = { tab: "changes", arrange: "auto", listW: 380, listH: 260, listHidden: false };
export const SPACE_LAYOUT: SpaceLayout = { leftW: 360, leftHidden: false };

/** narrower than this, "auto" stacks list and detail */
export const AUTO_STACK_BELOW = 760;

export const gitKey = (place: GitPlace) => `hollr.gitLayout.${place}`;
export const SPACE_KEY = "hollr.spaceLayout";

/** The stored layout over the defaults; unknown keys and values of the wrong type are dropped. */
export function parseLayout<T extends object>(raw: string | null, defaults: T): T {
  const out = { ...defaults };
  if (raw == null) return out;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object") return out;
    for (const k of Object.keys(defaults) as (keyof T & string)[]) {
      const x = v[k];
      const d = defaults[k];
      if (typeof x !== typeof d || (typeof x === "number" && !Number.isFinite(x))) continue;
      if (k === "arrange" && !["auto", "side", "stack"].includes(x as string)) continue;
      if (k === "tab" && !["files", "changes", "history", "branches"].includes(x as string)) continue;
      out[k] = x as T[typeof k];
    }
  } catch {}
  return out;
}

export function loadLayout<T extends object>(key: string, defaults: T): T {
  try {
    return parseLayout(localStorage.getItem(key), defaults);
  } catch {
    return { ...defaults };
  }
}

export function saveLayout(key: string, layout: object) {
  try {
    localStorage.setItem(key, JSON.stringify(layout));
  } catch {}
}

/** `v` within [min, max]; when the room is too small for both, min wins */
export const clamp = (v: number, min: number, max: number) => Math.round(Math.max(min, Math.min(v, max)));

/** what "auto" means at this width */
export const resolveArrange = (a: Arrange, width: number): "side" | "stack" =>
  a !== "auto" ? a : width < AUTO_STACK_BELOW ? "stack" : "side";

/** the order the layout button cycles through */
export const nextArrange = (a: Arrange): Arrange => (a === "auto" ? "side" : a === "side" ? "stack" : "auto");

/** a session's right side panel tab; "" = closed */
export type SidePanel = "" | "chats" | "git" | "browser" | "info";
export const SIDE_PANEL_KEY = "hollr.agent.panel";
const SIDE_PANELS: readonly SidePanel[] = ["", "chats", "git", "browser", "info"];

/** The stored side panel; nothing or junk stored = closed. */
export const parseSidePanel = (raw: string | null): SidePanel =>
  SIDE_PANELS.includes(raw as SidePanel) ? (raw as SidePanel) : "";

/**
 * What a session opens with: a dashboard quick action ("git" / "browser") wins, else the panel last
 * left open (or closed). A chat with context has no "Nachfragen" tab – it shows Git instead.
 */
export function sidePanelFor(stored: SidePanel, open: string | undefined, fork: boolean): SidePanel {
  const p: SidePanel = open === "git" || open === "browser" ? open : stored;
  return p === "chats" && fork ? "git" : p;
}
