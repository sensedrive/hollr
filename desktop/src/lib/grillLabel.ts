// Grill session labels („Grill TENDR-1071 · #3551“, „Auto-Grill #3551“, „Grill TENDR-1071“): the link from a herdr
// session to its card on the Sandcastle board. Same regex as the server and the plugin.
const FULL = /^(Auto-)?Grill (?:([A-Z][A-Z0-9]+-\d+) · )?#(\d+)$/;
const KEY_ONLY = /^(Auto-)?Grill ([A-Z][A-Z0-9]+-\d+)$/;

/** The board's deep-link ticket (`<KEY>:<n>`, `:<n>` or `<KEY>:`) for a Grill label, else undefined. */
export function grillTicket(label: string | undefined): string | undefined {
  const s = label?.trim() ?? "";
  const m = FULL.exec(s);
  if (m) return `${m[2] ?? ""}:${m[3]}`;
  const k = KEY_ONLY.exec(s);
  return k ? `${k[2]}:` : undefined;
}
