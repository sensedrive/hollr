// How a session ("serverId|pane") was left – chat or terminal, the terminal's "Session" or "Eigene Shell",
// zen mode: switching tabs or sessions and coming back shows it the same way. Kept across restarts;
// closed sessions drop out after a while.
import type { TermMode } from "./terminal";

export type ViewMode = "chat" | "terminal";
export interface ViewPrefs {
  view?: ViewMode;
  term?: TermMode;
  zen?: boolean;
}

const KEY = "hollr.viewPrefs";
/** the earlier store: only chat / terminal, as [id, mode][] */
const OLD = "hollr.viewModes";
/** only the most recently used are kept */
const MAX = 200;

/** The stored prefs; the old chat/terminal list is taken over when there are none yet. */
export function parsePrefs(raw: string | null, old: string | null): Map<string, ViewPrefs> {
  try {
    if (raw != null) return new Map(JSON.parse(raw) as [string, ViewPrefs][]);
    if (old != null)
      return new Map(
        (JSON.parse(old) as [string, string][])
          .filter(([, m]) => m === "chat" || m === "terminal")
          .map(([id, m]) => [id, { view: m as ViewMode }]),
      );
  } catch {}
  return new Map();
}

function load(): Map<string, ViewPrefs> {
  try {
    const raw = localStorage.getItem(KEY);
    const map = parsePrefs(raw, raw == null ? localStorage.getItem(OLD) : null);
    if (raw == null) {
      localStorage.setItem(KEY, JSON.stringify([...map]));
      localStorage.removeItem(OLD);
    }
    return map;
  } catch {
    return new Map();
  }
}

let prefs = load();

export const viewPrefsOf = (id: string): ViewPrefs => prefs.get(id) ?? {};

/** Merges `patch` into the session's prefs; the session becomes the most recently used. Starts from what is
 *  stored: the other window (side conversation) may have remembered its sessions meanwhile. */
export function rememberViewPrefs(id: string, patch: ViewPrefs) {
  prefs = load();
  const cur = prefs.get(id) ?? {};
  if ((Object.keys(patch) as (keyof ViewPrefs)[]).every((k) => cur[k] === patch[k])) return;
  prefs.delete(id);
  prefs.set(id, { ...cur, ...patch });
  while (prefs.size > MAX) prefs.delete(prefs.keys().next().value!);
  try {
    localStorage.setItem(KEY, JSON.stringify([...prefs]));
  } catch {}
}
