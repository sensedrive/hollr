/** Server texts the app shows (server info, tools, push) in the app's language. German is the source. */
export type Lang = "de" | "en";

export const toLang = (v?: string): Lang => (v?.toLowerCase().startsWith("en") ? "en" : "de");

const EN: Record<string, string> = {
  "nicht gefunden": "not found",
  "PulseAudio läuft": "PulseAudio running",
  ja: "yes",
  nein: "no",
  "Dienste ohne Login (linger)": "Services without login (linger)",
  unbekannt: "unknown",
  fehlt: "missing",
  "Gekoppelte Geräte": "Paired devices",
  "SSH-Host-Key": "SSH host key",
  "Hollr-Wächter (Push)": "Hollr watcher (push)",
  "kein systemd": "no systemd",
  läuft: "running",
  gestoppt: "stopped",
  "Push-Schlüssel": "Push key",
  "nicht eingerichtet (in der App importieren)": "not set up (import it in the app)",
  "Hollr-Server": "Hollr server",
  "Wartet auf dich": "Waiting for you",
  Fertig: "Done",
};

export function tr(lang: Lang, text: string): string {
  return lang === "en" ? (EN[text] ?? text) : text;
}
