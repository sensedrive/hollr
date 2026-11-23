// Host relay for plugin pages (contract B): the page asks the app for the paired servers, gate calls on its
// manifest's allowlist and opening a session. Pure parsing here so the trust boundary is tested.

export type HostRequest =
  | { type: "servers"; id: string }
  | { type: "gate"; id: string; server: string; command: string; stdin: Record<string, unknown> }
  | { type: "open-session"; server: string; pane: string };

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
  if (m.type !== "gate") return undefined;
  if (!str(m.server) || !str(m.command, 40)) return { type: "reject", id: m.id, error: "Ungültige Anfrage" };
  if (!allowed.includes(m.command))
    return { type: "reject", id: m.id, error: `Gate-Befehl ${m.command} ist für dieses Plugin nicht freigegeben` };
  const stdin = m.stdin ?? {};
  if (typeof stdin !== "object" || Array.isArray(stdin)) return { type: "reject", id: m.id, error: "stdin muss ein Objekt sein" };
  return { type: "gate", id: m.id, server: m.server, command: m.command, stdin: stdin as Record<string, unknown> };
}
