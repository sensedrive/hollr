// German is the source language; English when the system runs in English.
const en: Record<string, string> = {
  Sitzungen: "Sessions",
  "Neue Sitzung": "New session",
  "Server koppeln": "Pair server",
  "Kein Server gekoppelt": "No server paired",
  "Auf dem Server `hollr pair --link` ausführen und den Link hier einfügen.":
    "Run `hollr pair --link` on the server and paste the link here.",
  Gerätename: "Device name",
  Koppeln: "Pair",
  Abbrechen: "Cancel",
  Öffnen: "Open",
  "Nachricht an": "Message to",
  "Befehl ausführen …": "Run a command …",
  Senden: "Send",
  Tasten: "Keys",
  bereit: "ready",
  arbeitet: "working",
  "wartet auf dich": "waiting for you",
  fertig: "done",
  Terminal: "Terminal",
  "Wähle links eine Sitzung.": "Pick a session on the left.",
  Was: "What",
  Wo: "Where",
  "Kein Projekt (Home)": "No project (home)",
  "Neuer Workspace": "New workspace",
  "Ordner auf dem Server": "Folder on the server",
  "Name (optional)": "Name (optional)",
  Modell: "Model",
  Standard: "Default",
  "Shell ohne Agent": "Shell without agent",
  "nicht installiert": "not installed",
  Entfernen: "Remove",
  "Sitzung beenden": "End session",
  "Modell wechseln": "Switch model",
  Wechseln: "Switch",
  "Gilt nur für diese Sitzung.": "Applies to this session only.",
  "Shells anzeigen": "Show shells",
  "Ask – omp wartet auf dich": "Ask – omp is waiting for you",
  "Lädt …": "Loading …",
  "wartet auf Hintergrund-Jobs": "waiting for background jobs",
  "Modell suchen": "Search models",
};

const lang = (navigator.language || "de").toLowerCase().startsWith("de") ? "de" : "en";

export function t(text: string): string {
  return lang === "en" ? (en[text] ?? text) : text;
}

export function statusLabel(s: string): string {
  return t({ idle: "bereit", done: "fertig", working: "arbeitet", blocked: "wartet auf dich" }[s] ?? s);
}
