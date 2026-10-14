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
