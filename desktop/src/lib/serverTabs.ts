// The server tab bar's memory: the session last opened on each server ("serverId" → pane), kept across
// restarts, and the rule which session a click on a server tab opens.
const KEY = "hollr.lastSession";

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

const last = load();

export const lastSessionOf = (server: string): string | undefined => last[server];

export function rememberSession(server: string, pane: string) {
  if (last[server] === pane) return;
  last[server] = pane;
  try {
    localStorage.setItem(KEY, JSON.stringify(last));
  } catch {}
}

/** blocked > done > working; everything else is no reason to go there */
const URGENCY = ["blocked", "done", "working"];

/**
 * The pane a click on a server tab opens: the last session opened there (also while its tree is still
 * loading), else the one that needs you most, else none (→ Server-Info).
 */
export function serverTarget(
  lastPane: string | undefined,
  panes: readonly { pane: string; status: string }[],
  loaded: boolean,
): string | undefined {
  if (lastPane && (!loaded || panes.some((p) => p.pane === lastPane))) return lastPane;
  let best: { pane: string; rank: number } | undefined;
  for (const p of panes) {
    const rank = URGENCY.indexOf(p.status);
    if (rank >= 0 && (!best || rank < best.rank)) best = { pane: p.pane, rank };
  }
  return best?.pane;
}
