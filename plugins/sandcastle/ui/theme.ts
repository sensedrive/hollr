/** Mirrors Hollr's palette (Settings › Design, light/dark) into this page's CSS variables. */
import type { HostTheme } from "./api";

const NAMES: Record<string, true> = { bg: true, side: true, card: true, raised: true, fg: true, muted: true, dim: true, border: true, accent: true, red: true, green: true, yellow: true, orange: true, purple: true, cyan: true, pink: true, blue: true };
// colours only: whatever the host sends ends up in a style attribute
const COLOUR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\))$/i;

export function applyTheme(t: HostTheme | null): boolean {
  if (!t || typeof t !== "object" || !t.vars || typeof t.vars !== "object") return false;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) if (Object.hasOwn(NAMES, k) && typeof v === "string" && COLOUR.test(v.trim())) root.style.setProperty(`--${k}`, v.trim());
  root.style.colorScheme = t.dark ? "dark" : "light";
  root.style.setProperty("--on-accent", t.dark ? "#0b0c0f" : "#ffffff");
  root.dataset.theme = t.dark ? "dark" : "light";
  return true;
}
