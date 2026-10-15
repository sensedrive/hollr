/** Server texts the app shows (server info, tools, push) in the app's language. German is the source. */
export type Lang = "de" | "en";

export const toLang = (v?: string): Lang => (v?.toLowerCase().startsWith("en") ? "en" : "de");

const EN: Record<string, string> = {
  "nicht gefunden": "not found",
  "Live-Audio (BlackHole)": "Live audio (BlackHole)",
  "optional – in der iPhone-App unter Mitteilungen importieren":
    "optional – import it in the iPhone app under Notifications",
  "SSH (Entfernte Anmeldung)": "SSH (Remote Login)",
  "Port 22 offen": "port 22 open",
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
  "omp angemeldet": "omp signed in",
  "fehlt – keine Mitteilungen von diesem Rechner": "missing – no notifications from this computer",
  "kein Anbieter – im Terminal: omp, dann /login": "no provider – in a terminal: omp, then /login",
  "nicht eingerichtet (in der App importieren)": "not set up (import it in the app)",
  "Hollr-Server": "Hollr server",
  "Wartet auf dich": "Waiting for you",
  Fertig: "Done",
};

export function tr(lang: Lang, text: string): string {
  return lang === "en" ? (EN[text] ?? text) : text;
}
