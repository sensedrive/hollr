// How the space view and the git panel are laid out: column widths, what is collapsed, list/detail
// side by side or stacked. Remembered per computer and per place (space view, a session's side panel …).

/** list and detail: side by side, stacked (list on top), or chosen by the available width */
export type Arrange = "auto" | "side" | "stack";
/** where a git panel lives – each place keeps its own layout */
export type GitPlace = "space" | "side" | "dialog";

export interface GitLayout {
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

export const GIT_LAYOUT: GitLayout = { arrange: "auto", listW: 380, listH: 260, listHidden: false };
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
