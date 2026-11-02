// Chat or terminal, remembered per session ("serverId|pane"): switching tabs or sessions and coming back
// shows the session the way it was left. Kept across restarts; closed sessions drop out after a while.
export type ViewMode = "chat" | "terminal";

const KEY = "hollr.viewModes";
/** only the most recently used are kept */
const MAX = 200;

function load(): Map<string, ViewMode> {
  try {
    return new Map(JSON.parse(localStorage.getItem(KEY) ?? "[]") as [string, ViewMode][]);
  } catch {
    return new Map();
  }
}

const modes = load();

export const viewModeOf = (id: string): ViewMode | undefined => modes.get(id);

export function rememberViewMode(id: string, mode: ViewMode) {
  if (modes.get(id) === mode) return;
  modes.delete(id);
  modes.set(id, mode);
  while (modes.size > MAX) modes.delete(modes.keys().next().value!);
  try {
    localStorage.setItem(KEY, JSON.stringify([...modes]));
  } catch {}
}
