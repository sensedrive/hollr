// What came when in the desktop app (Settings → Neuigkeiten). Newest first; add an entry with every release.
// `build` is a running number – `settings.seenNotes` remembers the newest one the user has seen.
import { settings } from "./settings.svelte";

export interface ReleaseNote {
  build: number;
  version: string;
  date: string;
  /** German source strings, translated with t() when shown */
  items: { icon: string; text: string }[];
}

export const NOTES: ReleaseNote[] = [
  {
    build: 13,
    version: "0.32.9",
    date: "02.11.2026",
    items: [
      { icon: "◉", text: "Mac: ein Klick auf eine Mitteilung öffnet jetzt wirklich die Session, um die es geht" },
    ],
  },
  {
    build: 12,
    version: "0.32.8",
    date: "02.11.2026",
    items: [
      { icon: "⇄", text: "Jede Session merkt sich Chat oder Terminal – beim Wechsel der Tabs und nach einem Neustart" },
    ],
  },
  {
    build: 11,
    version: "0.32.7",
    date: "02.11.2026",
    items: [
      { icon: "⧉", text: "Terminal wie Ghostty: markieren kopiert sofort, „Auswahl kopiert“ bestätigt es – ohne Füll-Leerzeichen und Rand der Oberfläche" },
    ],
  },
  {
    build: 10,
    version: "0.32.6",
    date: "02.11.2026",
    items: [
      { icon: "⌶", text: "Terminal: Text markieren und mit ⌘C kopieren geht jetzt auch in omp, Claude und anderen Vollbild-Programmen – ⌥-Klick geht an das Programm" },
    ],
  },
  {
    build: 9,
    version: "0.32.5",
    date: "02.11.2026",
    items: [
      { icon: "✎", text: "Tabs umbenennen: Doppelklick auf einen Tab (oder Rechtsklick › Umbenennen) – der Name gilt auch in herdr" },
    ],
  },
  {
    build: 8,
    version: "0.32.4",
    date: "02.11.2026",
    items: [
      { icon: "↔", text: "Seitenleiste breiter oder schmaler ziehen – am rechten Rand; Doppelklick setzt sie zurück" },
      { icon: "◉", text: "Klick auf eine Mitteilung holt Hollr nach vorn und öffnet genau diese Session" },
    ],
  },
  {
    build: 7,
    version: "0.32.3",
    date: "02.11.2026",
    items: [
      { icon: "▭", text: "Tabs wie in herdr: über jeder Session alle Tabs ihres Space mit Status – ein Klick wechselt, ＋ startet eine neue Sitzung im selben Space" },
    ],
  },
  {
    build: 6,
    version: "0.32.2",
    date: "02.11.2026",
    items: [
      { icon: "├", text: "Seitenleiste wie herdr: alle Server mit ihren Spaces, Branch darunter, Worktrees eingerückt und einklappbar – ein Klick springt in die Session, die dich am meisten braucht" },
      { icon: "◌", text: "Spaces mit ✕ oder Rechtsklick aus der Seitenleiste nehmen – sie kommen von selbst zurück, sobald sie dich brauchen" },
      { icon: "✓", text: "Übersicht: lange laufende Agents lassen sich mit ✓ aus „Braucht dich“ nehmen, bis zur nächsten Runde" },
    ],
  },
  {
    build: 5,
    version: "0.32",
    date: "02.11.2026",
    items: [
      { icon: "☰", text: "Neue Übersicht: „Braucht dich“ nach Dringlichkeit mit der konkreten Frage, „Woran ich arbeite“ nach Projekt – antworten, Chat, Terminal, Git und Browser direkt von dort, mit Tastenkürzeln (?)" },
      { icon: ">_", text: "Echtes Terminal: die Oberfläche der Session live, eigene Shell im Ordner der Session, Links mit ⌘-Klick, verbindet sich selbst neu" },
      { icon: "🎙", text: "Diktat auf dem Gerät mit Whisper – mit deinem Fachvokabular, Modelle unter Einstellungen › Diktat" },
      { icon: "▢", text: "Ordner auf dem Server durchsuchen beim Anlegen von Sitzungen und Spaces" },
      { icon: "⌗", text: "Koppeln per Einmalcode – ideal von unterwegs über Tailscale" },
      { icon: "☑", text: "Server-Info: Einrichtungs-Checkliste mit Installieren und Neu starten" },
      { icon: "🔒", text: "App-Sperre mit Touch ID oder Passwort" },
      { icon: "✦", text: "Tipps & Tricks beim ersten Start – jederzeit unter Einstellungen › Allgemein" },
    ],
  },
  {
    build: 4,
    version: "0.16",
    date: "14.10.2026",
    items: [
      { icon: "✦", text: "Desktop-App mit allen Funktionen der iPhone-App" },
      { icon: "◐", text: "Designs: Dracula, Nord, Solarized, Gruvbox, Catppuccin, GitHub und mehr – hell, dunkel oder automatisch" },
      { icon: "▤", text: "Server-Info: Auslastung, Prozesse und ob der Server korrekt eingerichtet ist" },
      { icon: "⬢", text: "herdr, omp, Claude Code, Codex und Hollr direkt aus der App installieren und aktualisieren" },
      { icon: "◉", text: "Desktop-Mitteilungen, wenn ein Agent auf dich wartet, fertig ist oder einen Fehler hat" },
      { icon: "Aa", text: "Ganze App skalieren – auch mit ⌘+ / ⌘− / ⌘0" },
      { icon: "⇄", text: "App-Sprache Deutsch oder Englisch – unabhängig vom System" },
    ],
  },
  {
    build: 3,
    version: "0.15",
    date: "14.10.2026",
    items: [
      { icon: "⎇", text: "Git: Dateien, Änderungen mit Diff, Verlauf-Graph, Branches mit PR-Status" },
      { icon: "❒", text: "Spaces: Repos und Worktrees anlegen, öffnen und schließen" },
      { icon: "⌁", text: "localhost-Seiten des Servers im Browser öffnen – über SSH, ohne Zusatzdienst" },
    ],
  },
  {
    build: 2,
    version: "0.14",
    date: "14.10.2026",
    items: [
      { icon: "◆", text: "Modell und Thinking/Effort beim Start einer Sitzung wählen und unterwegs wechseln" },
      { icon: "▭", text: "Skeletons statt Lade-Kreisel" },
    ],
  },
  {
    build: 1,
    version: "0.13",
    date: "Oktober 2026",
    items: [
      { icon: "⛓", text: "Server per Link koppeln – nur SSH, kein Zusatzdienst" },
      { icon: "◉", text: "omp, Claude Code, Codex und Terminals öffnen, lesen, schreiben und schließen" },
      { icon: "▦", text: "Übersicht zeigt deine Sitzungen, gruppiert nach Maschine" },
    ],
  },
];

export const latestBuild = NOTES[0]?.build ?? 0;
export const hasUnseen = () => settings.seenNotes < latestBuild;
export const markSeen = () => {
  if (settings.seenNotes < latestBuild) settings.seenNotes = latestBuild;
};
