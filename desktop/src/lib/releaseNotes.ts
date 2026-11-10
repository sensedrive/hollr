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
    build: 34,
    version: "0.44.2",
    date: "10.11.2026",
    items: [
      { icon: "⑂", text: "Neuer Worktree direkt im Rechtsklick eines Space: Branch-Name, Enter – der Worktree entsteht und omp startet darin" },
    ],
  },
  {
    build: 33,
    version: "0.44.1",
    date: "07.11.2026",
    items: [
      { icon: "▢", text: "Jeder Space merkt sich seinen Tab: Zurück aus einem anderen Space landest du wieder auf dem Tab, den du dort zuletzt offen hattest – auch nach einem Neustart" },
    ],
  },
  {
    build: 32,
    version: "0.44.0",
    date: "06.11.2026",
    items: [
      { icon: "⑂", text: "Git-Stand sofort aktuell: pull, fetch, commit oder checkout – auch in einem normalen Terminal oder außerhalb von Hollr – zeigen ↑/↓ und Änderungen nach wenigen Sekunden" },
      { icon: "✕", text: "Letzte Sitzung eines Space lässt sich schließen – der Space bleibt mit einem leeren Terminal; scheitert das Schließen, siehst du warum" },
      { icon: "▢", text: "Space schließen mit Worktrees: der Dialog zeigt, welche Worktree-Spaces mit schließen; Spaces mit gelöschtem Ordner sind markiert und lassen sich schließen" },
      { icon: "↗", text: "Terminal-Links öffnen genau die angezeigte Adresse: lange umgebrochene URLs vollständig, localhost auf diesem Mac unverändert, bei entfernten Servern zeigt der Dialog die Tunnel-Adresse; Emoji verschieben die Zeile nicht mehr" },
    ],
  },
  {
    build: 31,
    version: "0.43.0",
    date: "06.11.2026",
    items: [
      { icon: "✦", text: "Neue Sitzung: statt endloser Platzhalter ein Startbild mit Agent und Version, Modell, Kontext, Ordner, Branch, MCP-Status, Update-Hinweis und ersten Schritten – vorher hing der Chat, bis das erste Wort fiel" },
      { icon: "⑂", text: "Git-Verlauf zeigt auch Remote-Branches (abschaltbar), lange Branch-Namen werden gekürzt" },
      { icon: "▥", text: "Seitenbereich, Git-Tab und Chat/Terminal bleiben, wie du sie zuletzt hattest, auch beim Wechsel von Space oder Worktree" },
    ],
  },
  {
    build: 30,
    version: "0.42.0",
    date: "06.11.2026",
    items: [
      { icon: "📱", text: "iPhone-App im neuen Design: Übersicht mit „Braucht dich“ und „Läuft gerade“ (Alle / Arbeitet / Neu), „neues Ergebnis“ in Blau, flache Werkzeugschritte, Modell und Kontext im Eingabefeld, Linien-Icons, helles Thema „Hollr Hell“" },
      { icon: "▢", text: "Dialoge, Menüs, App-Sperre, Dateivorschau und Vorlese-Leiste im neuen Overlay-Stil; „Nachfragen“ (⌘⇧K) zu markiertem Text" },
    ],
  },
  {
    build: 29,
    version: "0.41.0",
    date: "05.11.2026",
    items: [
      { icon: "⑂", text: "Neuer Chat mit Kontext (⌘⇧L, ⋯, ⌘K): ein leerer Chat im Tab neben der Session, der ihren Verlauf im Hintergrund kennt – ein normaler Chat ohne Sonderfenster; ⋯ › Zurücksetzen und Ergebnis in den Hauptchat" },
      { icon: "✎", text: "Linien-Icons überall statt Emoji-Zeichen" },
    ],
  },
  {
    build: 28,
    version: "0.40.0",
    date: "05.11.2026",
    items: [
      { icon: "🧭", text: "Ruhigere Oberfläche: Server-Wechsel in der Seitenleiste, ⌘K sucht Sessions, Spaces und Befehle (Eingabe fokussieren jetzt ⌘J); keine Kopfzeile mehr – die Werkzeuge sitzen in der Tab-Leiste, Modell und Kontext im Eingabefeld, eine offene Frage hängt über dem Eingabefeld" },
      { icon: "🔵", text: "Status: „neues Ergebnis“ in Blau statt „fertig“, die Übersicht zeigt „Läuft gerade“ mit Filter Alle / Arbeitet / Neu; Linien-Icons und besser lesbarer gedimmter Text" },
    ],
  },
  {
    build: 27,
    version: "0.39.0",
    date: "05.11.2026",
    items: [
      { icon: "🎙", text: "Nebengespräch im eigenen Fenster: Chat, Terminal, Live und alles andere – bezogen auf die Haupt-Session, ohne sie zu stören; „↺ Zurücksetzen“ startet es neu vom aktuellen Stand, das Ergebnis geht als Entwurf in den Hauptchat" },
      { icon: "🔈", text: "Live auf demselben Mac wie der Server hört und spricht wieder – die App hängte sich an die BlackHole-Geräte des Servers" },
      { icon: "⌕", text: "Im Chat suchen (⌘F): alle Treffer markiert, ↑/↓ bzw. ⌘G, auch in zugeklappten Karten; rechts eine Übersicht des Chats mit den Fundstellen – klicken oder ziehen zum Scrollen (⋯ › Übersicht)" },
    ],
  },
  {
    build: 26,
    version: "0.38.0",
    date: "05.11.2026",
    items: [
      { icon: "📂", text: "Pfade öffnen: Dateipfade im Chat (Klick) und im Terminal (⌘-Klick) öffnen eine Vorschau – Bilder mit Zoom, Code an der richtigen Zeile, Ordner zum Durchklicken; mit „Pfad kopieren“ und „Im Git-Panel öffnen“" },
    ],
  },
  {
    build: 25,
    version: "0.37.0",
    date: "04.11.2026",
    items: [
      { icon: "🎙", text: "Nebengespräch: neben einer Session über sie reden (Live mit omp, ⌘⇧L), ohne sie zu stören – eine schreibgeschützte Abzweigung im Seitenbereich, das Ergebnis auf Wunsch als Entwurf zurück in den Hauptchat" },
      { icon: "🔊", text: "Vorlesen: Die Leiste zeigt den gelesenen Text (Zusammenfassung oder Original) und bleibt offen, bis du sie schließt – mit Tempo (0,7–1,6×), „Nochmal“, Wechsel zwischen Original und Zusammenfassung und ⚙ zu den Einstellungen" },
    ],
  },
  {
    build: 24,
    version: "0.36.0",
    date: "04.11.2026",
    items: [
      { icon: "📝", text: "Zusammenfassung vorlesen: neben markiertem Text oder mit ⌘⌥⇧S fasst omp auf dem Server zusammen (Modell und Konto unter Einstellungen › Vorlesen) – danach ist das Original einen Klick entfernt" },
      { icon: "▭", text: "Terminal: Eine Markierung bleibt stehen, wenn du die Maus danach bewegst – vorher verschwand sie sofort" },
      { icon: "⇄", text: "Terminal: Wird eine Session schon woanders angezeigt (iPhone, zweites Fenster, hängende Verbindung), übernimmt die neue Ansicht – statt „already has an attached client“" },
    ],
  },
  {
    build: 23,
    version: "0.35.1",
    date: "04.11.2026",
    items: [
      { icon: "🔊", text: "Phonon 40m ohne Hugging Face: ein Klick auf „Laden“ unter Einstellungen › Vorlesen holt das Modell (148 MB, Deutsch, Englisch, Französisch, Spanisch, Portugiesisch) – kein Konto, kein Token; über 100 Stimmen sind dabei" },
    ],
  },
  {
    build: 22,
    version: "0.35.0",
    date: "04.11.2026",
    items: [
      { icon: "🔊", text: "Vorlesen: Text im Chat oder Terminal markieren und „Vorlesen“ tippen (⌘⇧S) – mit Phonon 40m auf dem Gerät, bis dahin mit der macOS-Stimme; Einstellungen › Vorlesen" },
      { icon: "⏳", text: "Warten auf Hintergrund-Jobs zeigt, worauf: Absicht, Jobs, Laufzeit – und wenn fertig, wie lange es gedauert hat" },
      { icon: "▤", text: "Ruhigerer Statusblock über dem Eingabefeld: was der Agent gerade tut, die aktuelle Aufgabe mit Phase, Hintergrund-Jobs mit Absicht und Laufzeit" },
      { icon: "$", text: "Bash-Karten zeigen den Ordner, wenn der Befehl außerhalb des Projekts lief; Grep-Bereiche lesbar statt mit Semikolons" },
    ],
  },
  {
    build: 21,
    version: "0.34.0",
    date: "03.11.2026",
    items: [
      { icon: "✦", text: "Claude Code im Chat: der ganze Verlauf statt nur des Bildschirms – Fragen, Freigaben und der Ordner-Check als Karten zum Antippen" },
      { icon: "±", text: "Änderungen als echte Diffs mit Zeilennummern und Syntaxfarben; lange Diffs klappen ein" },
      { icon: "☑", text: "TODO-Listen im Verlauf: jede Änderung als kompakte Zeile, die neueste offen, Erledigtes durchgestrichen" },
      { icon: "⌕", text: "Grep mit Fundstellen, Dateilisten, Subagenten mit ihrer Antwort, Websuche mit Links, Bash mit mehr Ausgabe und Kopierknöpfen" },
      { icon: "</>", text: "Antworten mit Syntax-Highlighting, Kopierknopf an jedem Codeblock und besseren Tabellen" },
      { icon: "⚠", text: "Statuszeile sagt „Wartet auf dich“, solange der Agent auf dich wartet – die Arbeitszeit zählt ohne diese Wartezeit" },
    ],
  },
  {
    build: 20,
    version: "0.33.4",
    date: "03.11.2026",
    items: [
      { icon: "⑂", text: "Git-Stand in Seitenleiste und Spaces aktualisiert sich nach git pull, Commit oder Checkout – nach Aktivität in einer Session binnen Sekunden, sonst spätestens nach 30 s" },
    ],
  },
  {
    build: 19,
    version: "0.33.3",
    date: "03.11.2026",
    items: [
      { icon: "⇕", text: "Terminal: Beim Markieren über den oberen oder unteren Rand ziehen scrollt die Session mit – die ganze Auswahl landet in der Zwischenablage" },
      { icon: "📱", text: "iPhone: Das Terminal scrollt leichter – feinere Schritte, und ein schneller Wisch läuft mit Schwung aus" },
      { icon: "⑂", text: "iPhone: Powerline- und Nerd-Font-Zeichen in Shell-Prompts werden im Terminal richtig gezeichnet" },
    ],
  },
  {
    build: 18,
    version: "0.33.2",
    date: "03.11.2026",
    items: [
      { icon: "⏎", text: "Terminal: Shift+Enter macht in omp und Claude Code eine neue Zeile, statt abzuschicken" },
      { icon: "⑂", text: "Terminal: Powerline- und Nerd-Font-Zeichen in Shell-Prompts (Pfeile, Branch-Symbol) werden richtig gezeichnet statt als Kästchen" },
    ],
  },
  {
    build: 17,
    version: "0.33.1",
    date: "03.11.2026",
    items: [
      { icon: "▤", text: "Die Seitenleiste zeigt nur den Rechner, den du oben in den Server-Tabs gewählt hast – auch auf der Übersicht bleibt er gewählt" },
    ],
  },
  {
    build: 16,
    version: "0.33.0",
    date: "03.11.2026",
    items: [
      { icon: "▭", text: "Server-Tabs oben: zwischen deinen Rechnern wechseln – mit Verbindungspunkt, „Braucht dich“-Zähler und ⌘⌥1…9; ein Klick öffnet die zuletzt genutzte Session dort" },
      { icon: "⇄", text: "Tabs per Drag & Drop umsortieren – Server-Tabs und Session-Tabs (die Reihenfolge gilt in Hollr)" },
      { icon: "❒", text: "Der Space ist jetzt der erste Tab – die Tab-Leiste bleibt auch in der Space-Ansicht stehen" },
      { icon: "〰", text: "Live läuft weiter, wenn du Tab oder Session wechselst – die Live-Pille in der Seitenleiste zeigt Zustand, Mikro und Auflegen; Tabs, Server und Seitenleiste markieren, wo gesprochen wird" },
      { icon: "⚠", text: "Live merkt eine abgerissene Verbindung („Verbindung verloren“, neu verbinden) und folgt dem Wechsel von Mikrofon und Lautsprecher (AirPods, Bildschirm)" },
      { icon: "🎧", text: "Neue Einstellung „Kopfhörer: Mikrofon immer an“ – du kannst omp dann jederzeit unterbrechen" },
      { icon: "🕑", text: "Uhrzeiten im Chat und eine Zeitleiste über dem Terminal: wann du was geschrieben hast und wann omp geantwortet hat" },
      { icon: ">_", text: "Terminal-Modus ohne doppelte TODO-Liste und Statuszeile; „Session / Eigene Shell“ und Zen-Modus merkt sich jede Session" },
      { icon: "⇔", text: "Space-Ansicht frei anordnen: Spalten ziehen, einklappen (⌘\\), Liste und Detail nebeneinander oder untereinander" },
      { icon: "◌", text: "Aus der Seitenleiste genommene Spaces verschwinden auch aus der Übersicht – bis sie dich brauchen" },
      { icon: "✓", text: "Eine neue omp-Session zeigt nicht mehr den Chat einer anderen Session im selben Ordner (braucht hollr 0.33 auf dem Server)" },
    ],
  },
  {
    build: 15,
    version: "0.32.11",
    date: "03.11.2026",
    items: [
      { icon: "〰", text: "Live: nach dem Stummschalten hört omp wieder zu – auch wenn die Stummschaltung in omp selbst (Leertaste) aufgehoben wurde; bisher blieb das Mikrofon stumm, obwohl „hört zu“ angezeigt wurde" },
    ],
  },
  {
    build: 14,
    version: "0.32.10",
    date: "02.11.2026",
    items: [
      { icon: "✕", text: "Tabs schließen: ✕ am Tab, Mittelklick oder Rechtsklick › Schließen – Sessions mit Agent nach Rückfrage" },
      { icon: "✓", text: "„Braucht dich“: eine fertige Session gilt als gesehen, sobald du sie öffnest – Fragen bleiben, bis sie beantwortet sind" },
    ],
  },
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
