// Which tab a space shows when you come back to it: the one you had selected there last – a session, or the space's
// own overview tab. Kept per "server|workspace" across restarts; a remembered session that's gone no longer counts.

export const LAST_TAB_KEY = "hollr.lastTab";

/** "server|workspace" → the pane last shown there, "" for the space overview */
export type LastTabs = Record<string, string>;

export const lastTabKey = (server: string, ws: string) => `${server}|${ws}`;

export function parseLastTabs(raw: string | null): LastTabs {
  try {
    const v = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** where to go back to: the overview, a session still in the space, or nothing remembered (caller's default) */
export function restoreTab(saved: string | undefined, panesInSpace: string[]): { overview: true } | { pane: string } | undefined {
  if (saved === undefined) return undefined;
  if (saved === "") return { overview: true };
  return panesInSpace.includes(saved) ? { pane: saved } : undefined;
}
