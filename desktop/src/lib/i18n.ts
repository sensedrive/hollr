// German is the source language. English comes from the dictionaries in ./i18n/*.ts
// (one file per feature: `export default { "Deutsch": "English" }`).
import { settings } from "./settings.svelte";

const en: Record<string, string> = Object.assign(
  {},
  ...Object.values(import.meta.glob<{ default: Record<string, string> }>("./i18n/*.ts", { eager: true })).map((m) => m.default),
);

const systemLang = (navigator.language || "de").toLowerCase().startsWith("de") ? "de" : "en";

export const lang = () => (settings.lang === "de" || settings.lang === "en" ? settings.lang : systemLang);

/** Translates a German UI string; `{name}` placeholders are filled from `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  let out = lang() === "en" ? (en[text] ?? text) : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

export function statusLabel(s: string): string {
  return t({ idle: "bereit", done: "fertig", working: "arbeitet", blocked: "wartet auf dich" }[s] ?? s);
}
