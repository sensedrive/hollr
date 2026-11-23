// Host relay for plugin pages (contract B): the page asks the app for the paired servers, gate calls on its
// manifest's allowlist and opening a session. Pure parsing here so the trust boundary is tested.

export type HostRequest =
  | { type: "servers"; id: string }
  | { type: "theme"; id: string }
  | { type: "gate"; id: string; server: string; command: string; stdin: Record<string, unknown> }
  | { type: "open-session"; server: string; pane: string };

/** The app's colour variables a plugin page may mirror (theme.ts writes them on <html>). */
export const THEME_VARS = ["bg", "side", "card", "raised", "fg", "muted", "dim", "border", "accent", "red", "green", "yellow", "orange", "purple", "cyan", "pink", "blue"] as const;

export interface HostTheme {
  dark: boolean;
  vars: Record<string, string>;
}

/** Current palette as the plugin page gets it: `{dark, vars: {bg: "#000000", …}}`. */
export function readTheme(get: (cssVar: string) => string, dark: boolean): HostTheme {
  const vars: Record<string, string> = {};
  for (const k of THEME_VARS) {
    const v = get(`--${k}`).trim();
    if (v) vars[k] = v;
  }
  return { dark, vars };
}

export type HostReply = { hollr: 1; id: string; ok: true; data: unknown } | { hollr: 1; id: string; ok: false; error: string };

const str = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Validates a message from the plugin page; `undefined` = not a host request (or not allowed), ignore it.
 *  A gate call outside `allowed` comes back as an error so the page doesn't hang waiting. */
export function parseHostRequest(
  data: unknown,
  allowed: readonly string[],
): HostRequest | { type: "reject"; id: string; error: string } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const m = data as Record<string, unknown>;
  if (m.hollr !== 1) return undefined;
  if (m.type === "open-session") {
    return str(m.server) && str(m.pane, 100) ? { type: "open-session", server: m.server, pane: m.pane } : undefined;
  }
  if (!str(m.id, 100)) return undefined;
  if (m.type === "servers") return { type: "servers", id: m.id };
  if (m.type === "theme") return { type: "theme", id: m.id };
  if (m.type !== "gate") return undefined;
  if (!str(m.server) || !str(m.command, 40)) return { type: "reject", id: m.id, error: "Ungültige Anfrage" };
  if (!allowed.includes(m.command))
    return { type: "reject", id: m.id, error: `Gate-Befehl ${m.command} ist für dieses Plugin nicht freigegeben` };
  const stdin = m.stdin ?? {};
  if (typeof stdin !== "object" || Array.isArray(stdin)) return { type: "reject", id: m.id, error: "stdin muss ein Objekt sein" };
  return { type: "gate", id: m.id, server: m.server, command: m.command, stdin: stdin as Record<string, unknown> };
}
