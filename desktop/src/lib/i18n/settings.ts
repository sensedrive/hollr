// Settings, design, server info, tools, release notes, notifications and pairing (German source → English).
export default {
  "Tailscale / Fernzugriff": "Tailscale / remote access",
  "Lokales Netzwerk": "Local network",
  "1 Werkzeug installieren/aktualisieren": "Install/update 1 tool",
  "{n} Werkzeuge installieren/aktualisieren": "Install/update {n} tools",
  "Entfernte Anmeldung (SSH) einschalten": "Turn on Remote Login (SSH)",
  "Auf dem Server ausführen": "Run on the server",
  // settings navigation
  Einstellungen: "Settings",
  Allgemein: "General",
  Design: "Design",
  "Server & Geräte": "Servers & devices",
  Neuigkeiten: "What's new",
  Neu: "New",
  Über: "About",
  Mehr: "More",
  Zurück: "Back",

  // general
  Ansicht: "Display",
  "Ansicht skalieren": "Scale view",
  Winzig: "Tiny",
  "Sehr klein": "Very small",
  Klein: "Small",
  Groß: "Large",
  "Sehr groß": "Very large",
  Riesig: "Huge",
  Zurücksetzen: "Reset",
  "Skaliert die ganze App. Auch mit {mod}+ / {mod}− / {mod}0.": "Scales the whole app. Also with {mod}+ / {mod}− / {mod}0.",
  "App-Sprache": "App language",
  "Wie System": "Like system",
  "Deutsch oder Englisch – unabhängig von der Systemsprache. Der Server antwortet in derselben Sprache.":
    "German or English – independent of the system language. The server answers in the same language.",
  Mitteilungen: "Notifications",
  "Fragen & Bestätigungen": "Questions & confirmations",
  "Aufgabe fertig": "Task done",
  Fehler: "Error",
  "Test-Mitteilung senden": "Send test notification",
  "Test-Mitteilung – Mitteilungen funktionieren.": "Test notification – notifications work.",
  "Gesendet.": "Sent.",
  "Mitteilungen sind im System nicht erlaubt.": "Notifications are not allowed by the system.",
  "Mitteilungen sind im System nicht erlaubt. In den Systemeinstellungen für Hollr erlauben.":
    "Notifications are not allowed by the system. Allow them for Hollr in the system settings.",
  "Hollr meldet sich auf diesem Computer, wenn ein Agent auf dich wartet, fertig ist oder mit einem Fehler stoppt – solange die App läuft. Die Sitzung, die du gerade ansiehst, bleibt still.":
    "Hollr notifies you on this computer when an agent waits for you, finishes or stops with an error – while the app is running. The session you are looking at stays quiet.",
  "Zeigt auch Terminals ohne Agent in den Listen.": "Also shows terminals without an agent in the lists.",

  // design
  Automatisch: "Automatic",
  "System folgen": "Follow system",
  "Dunkles Design": "Dark theme",
  "Helles Design": "Light theme",
  Dunkel: "Dark",
  Hell: "Light",
  "Wechselt mit dem Hell-/Dunkelmodus des Systems. Unten je ein dunkles und ein helles Design wählen.":
    "Switches with the system's light/dark mode. Pick one dark and one light theme below.",
  "Ein festes Design – oder „System folgen“ für hell am Tag und dunkel in der Nacht.":
    "One fixed theme – or “Follow system” for light by day and dark at night.",

  // servers
  "Server-Info": "Server info",
  Werkzeuge: "Tools",
  "Server aus Hollr entfernen?": "Remove server from Hollr?",
  "Auf dem Server bleibt der Schlüssel bis `hollr revoke {device}`.": "The key stays on the server until `hollr revoke {device}`.",
  "{n} Agents · Gerät {device}": "{n} agents · device {device}",
  "Team: Jede Person koppelt ihr eigenes Gerät mit `hollr pair`. Entfernen auf dem Server mit `hollr revoke <name>`.":
    "Team: everyone pairs their own device with `hollr pair`. Remove on the server with `hollr revoke <name>`.",

  // pairing + setup commands
  "Server einrichten": "Set up a server",
  "Befehl kopieren": "Copy command",
  "1. Entfernte Anmeldung (SSH) einschalten": "1. Turn on Remote Login (SSH)",
  "1. SSH-Server (falls noch nicht da)": "1. SSH server (if not installed yet)",
  "2. Hollr installieren und Kopplungslink anzeigen": "2. Install Hollr and show the pairing link",
  "Schon installiert? Nur koppeln:": "Already installed? Just pair:",
  "Der Installer erkennt apt, dnf, yum, pacman, zypper und apk und lässt alles Vorhandene in Ruhe.":
    "The installer detects apt, dnf, yum, pacman, zypper and apk and leaves everything already installed alone.",
  "So erscheint dieser Computer in `hollr devices` auf dem Server.": "This is how this computer shows up in `hollr devices` on the server.",
  Kopplungslink: "Pairing link",
  Einfügen: "Paste",
  "Kopple …": "Pairing …",
  "{label} ist gekoppelt": "{label} is paired",
  Fertig: "Done",
  "Nochmal versuchen": "Try again",
  "Noch kein Hollr auf dem Server?": "No Hollr on the server yet?",
  Methode: "Method",
  Kopplungscode: "Pairing code",
  "Auf dem Server `hollr pair` ausführen – der Code steht unter dem QR-Code, gilt 10 Minuten und nur einmal. Von unterwegs: am Server „Tailscale / Fernzugriff“ wählen und Tailscale auf diesem Computer verbinden.":
    "Run `hollr pair` on the server – the code is shown below the QR code, valid for 10 minutes and only once. From elsewhere: choose “Tailscale / remote access” on the server and connect Tailscale on this computer.",
  "Der Code hat 16 Zeichen, z. B. K7Q2-M9XA-3PLD-W8RT.": "The code has 16 characters, e.g. K7Q2-M9XA-3PLD-W8RT.",
  "Der Code stimmt nicht. Bitte genau so eingeben, wie er am Server steht.": "The code is wrong. Please enter it exactly as shown on the server.",
  "Zu viele falsche Versuche – der Code ist gesperrt. Am Server einen neuen erzeugen („n“ + Enter).":
    "Too many wrong attempts – the code is locked. Create a new one on the server (“n” + Enter).",
  "Der Code ist abgelaufen oder wurde schon benutzt. Am Server einen neuen erzeugen: hollr pair":
    "The code has expired or was already used. Create a new one on the server: hollr pair",
  "Der Server ({ip}) ist nicht erreichbar. Ist Tailscale auf diesem Computer verbunden und läuft „hollr pair“ am Server noch?":
    "The server ({ip}) can't be reached. Is Tailscale connected on this computer, and is “hollr pair” still running on the server?",
  "Der Server ({ip}) ist nicht erreichbar. Gleiches Netzwerk? Läuft „hollr pair“ am Server noch?":
    "The server ({ip}) can't be reached. Same network? Is “hollr pair” still running on the server?",
  "Die Antwort des Servers passt nicht zum Code.": "The server's answer doesn't match the code.",

  // server info
  Auslastung: "Load",
  Last: "Load avg",
  "{cpu} % · {cores} Kerne": "{cpu} % · {cores} cores",
  "{cores} Kerne": "{cores} cores",
  "Kernel {kernel} · läuft seit {uptime} · Hollr {hollr}": "Kernel {kernel} · up {uptime} · Hollr {hollr}",
  "{d} T {h} h": "{d} d {h} h",
  "{h} h {m} min": "{h} h {m} min",
  "{m} min": "{m} min",
  Einrichtung: "Setup",
  "Einrichtung · alles korrekt": "Setup · all good",
  "Einrichtung · {n} Problem(e)": "Setup · {n} problem(s)",
  "Prozesse · nach CPU": "Processes · by CPU",
  Alle: "All",
  "Hollr & Agents": "Hollr & Agents",
  "Prozess suchen": "Search processes",
  Name: "Name",
  Benutzer: "User",
  "Keine Prozesse gefunden.": "No processes found.",
  "Neu laden": "Reload",
  Aktualisieren: "Update",

  // tools
  "Werkzeuge auf {server}": "Tools on {server}",
  "Nach Updates suchen": "Check for updates",
  "Suche …": "Checking …",
  installiert: "installed",
  "nicht installiert": "not installed",
  Installieren: "Install",
  "{version} installieren": "Install {version}",
  "Auf {version} aktualisieren": "Update to {version}",
  "Installiere …": "Installing …",
  "Aktualisiere …": "Updating …",
  Aktuell: "Up to date",
  "Trotzdem neu installieren": "Reinstall anyway",
  "Fehlgeschlagen (Exit {exit})": "Failed (exit {exit})",
  "Protokoll anzeigen": "Show log",
  "Protokoll ausblenden": "Hide log",
  "Installiert und aktualisiert im Hintergrund auf dem Server – läuft weiter, auch wenn du die App schließt.":
    "Installs and updates in the background on the server – keeps running even if you close the app.",

  // notifications (texts of server/src/push via watch.ts)
  "{agent} wartet auf dich": "{agent} is waiting for you",
  "{agent} ist fertig · {time}": "{agent} is done · {time}",
  "{agent} ist mit einem Fehler gestoppt": "{agent} stopped with an error",
  "Fehler: {error}": "Error: {error}",
  unbekannt: "unknown",
  "Wartet auf dich": "Waiting for you",

  // release notes + about
  Anfang: "Beginning",
  "Version {version}": "Version {version}",
  "Oktober 2026": "October 2026",
  Version: "Version",
  App: "App",
  Lizenz: "License",
  Quellcode: "Source code",
  "Fehler melden oder Wunsch äußern": "Report a bug or request a feature",
  "Deine Agents auf dem Server – per SSH, ohne Zusatzdienst.": "Your agents on the server – over SSH, no extra service.",
  "Hollr ist Open Source (MIT) – github.com/sensedrive/hollr": "Hollr is open source (MIT) – github.com/sensedrive/hollr",
  "Desktop-App mit allen Funktionen der iPhone-App": "Desktop app with all features of the iPhone app",
  "Worktrees in der Seitenleiste lassen sich per Ziehen umsortieren. Die Reihenfolge bleibt auf diesem Mac.":
    "Worktrees in the sidebar can be reordered by dragging. The order stays on this Mac.",
  "Doppelklick auf einen Space öffnet den Space selbst. Ein Klick bleibt beim zuletzt offenen Tab.":
    "Double-clicking a space opens the space itself. One click still returns to the tab you last had open.",
  "Vorlesen-Leiste an der Markierung: ✕ oder ein Klick daneben blendet sie aus. Dieselbe Markierung holt sie nicht zurück.":
    "The read-aloud bar on a selection: ✕ or a click beside it hides it. The same selection does not bring it back.",
  "„Worktrees einklappen“ zeigt einen Pfeil statt des abgeschnittenen Icon-Namens":
    "“Collapse worktrees” shows an arrow instead of the clipped icon name",
  "Der blaue Punkt (fertig) verschwindet, sobald du das Fenster offen hattest. Ein neues Ergebnis danach setzt ihn wieder.":
    "The blue dot (finished) goes away once you had that window open. A new result afterwards brings it back.",
  "Space aus der Liste nehmen oder schließen blendet auch seine offene Session aus. Die Session selbst läuft weiter, wenn du sie nur aus der Liste nimmst.":
    "Removing a space from the list or closing it also leaves its open session. The session keeps running when you only take the space off the list.",
  "Rechtsklick wie in herdr: Umbenennen, Gruppe schließen, Worktree öffnen (alle Checkouts, Tippen filtert) und Worktrees einklappen":
    "Right-click like herdr: rename, close group, open worktree (every checkout, typing filters) and collapse worktrees",
  "Übersicht: ✕ blendet die Meldung aus. Die Sitzung läuft weiter. Beenden geht nur noch über das Menü der Karte.":
    "Overview: ✕ hides the notice. The session keeps running. Ending it is only in the card's menu.",
  "Neuer Space unten in der Seitenleiste: öffnet ein Terminal, die Beschriftung folgt dem Ordner, sobald du das Projekt wechselst":
    "New space at the bottom of the sidebar: opens a terminal, the label follows the folder as soon as you change project",
  "Rechtsklick auf einen Space zeigt nur noch die Aktionen – die Sitzungsliste ist weg, die Tabs bleiben in der Leiste":
    "Right-clicking a space shows only the actions – the session list is gone, the tabs stay in the bar",
  "Neuer Worktree direkt im Rechtsklick eines Space: Branch-Name, Enter – der Worktree entsteht und omp startet darin":
    "New worktree straight from a space's right-click: branch name, Enter – the worktree is created and omp starts in it",
  "Jeder Space merkt sich seinen Tab: Zurück aus einem anderen Space landest du wieder auf dem Tab, den du dort zuletzt offen hattest – auch nach einem Neustart":
    "Every space remembers its tab: coming back from another space lands on the tab you last had open there – also after a restart",
  "Git-Stand sofort aktuell: pull, fetch, commit oder checkout – auch in einem normalen Terminal oder außerhalb von Hollr – zeigen ↑/↓ und Änderungen nach wenigen Sekunden":
    "Git state up to date right away: pull, fetch, commit or checkout – also in a plain terminal or outside Hollr – show ↑/↓ and changes within seconds",
  "Letzte Sitzung eines Space lässt sich schließen – der Space bleibt mit einem leeren Terminal; scheitert das Schließen, siehst du warum":
    "The last session of a space can be closed – the space stays with an empty terminal; if closing fails, you see why",
  "Space schließen mit Worktrees: der Dialog zeigt, welche Worktree-Spaces mit schließen; Spaces mit gelöschtem Ordner sind markiert und lassen sich schließen":
    "Closing a space with worktrees: the dialog shows which worktree spaces close with it; spaces whose folder was deleted are marked and can be closed",
  "Terminal-Links öffnen genau die angezeigte Adresse: lange umgebrochene URLs vollständig, localhost auf diesem Mac unverändert, bei entfernten Servern zeigt der Dialog die Tunnel-Adresse; Emoji verschieben die Zeile nicht mehr":
    "Terminal links open exactly the address shown: long wrapped URLs in full, localhost on this Mac unchanged, for remote servers the dialog shows the tunnel address; emoji no longer shift the line",
  "Neue Sitzung: statt endloser Platzhalter ein Startbild mit Agent und Version, Modell, Kontext, Ordner, Branch, MCP-Status, Update-Hinweis und ersten Schritten – vorher hing der Chat, bis das erste Wort fiel":
    "New session: instead of endless placeholders a start screen with agent and version, model, context, folder, branch, MCP status, update hint and first steps – the chat used to hang until the first word",
  "Git-Verlauf zeigt auch Remote-Branches (abschaltbar), lange Branch-Namen werden gekürzt":
    "Git history also shows remote branches (can be turned off), long branch names are shortened",
  "Seitenbereich, Git-Tab und Chat/Terminal bleiben, wie du sie zuletzt hattest, auch beim Wechsel von Space oder Worktree":
    "Side panel, git tab and chat/terminal stay as you last had them, also when switching space or worktree",
  "iPhone-App im neuen Design: Übersicht mit „Braucht dich“ und „Läuft gerade“ (Alle / Arbeitet / Neu), „neues Ergebnis“ in Blau, flache Werkzeugschritte, Modell und Kontext im Eingabefeld, Linien-Icons, helles Thema „Hollr Hell“":
    "iPhone app in the new design: overview with “Needs you” and “Running now” (All / Working / New), “new result” in blue, flat tool steps, model and context in the composer, line icons, light theme “Hollr Light”",
  "Dialoge, Menüs, App-Sperre, Dateivorschau und Vorlese-Leiste im neuen Overlay-Stil; „Nachfragen“ (⌘⇧K) zu markiertem Text":
    "Dialogs, menus, app lock, file preview and read-aloud bar in the new overlay style; “Ask about it” (⌘⇧K) for selected text",
  "Neuer Chat mit Kontext (⌘⇧L, ⋯, ⌘K): ein leerer Chat im Tab neben der Session, der ihren Verlauf im Hintergrund kennt – ein normaler Chat ohne Sonderfenster; ⋯ › Zurücksetzen und Ergebnis in den Hauptchat":
    "New chat with context (⌘⇧L, ⋯, ⌘K): an empty chat in a tab next to the session that knows its history in the background – an ordinary chat, no extra window; ⋯ › Reset and Result to the main chat",
  "Linien-Icons überall statt Emoji-Zeichen": "Line icons everywhere instead of emoji glyphs",
  "Ruhigere Oberfläche: Server-Wechsel in der Seitenleiste, ⌘K sucht Sessions, Spaces und Befehle (Eingabe fokussieren jetzt ⌘J); keine Kopfzeile mehr – die Werkzeuge sitzen in der Tab-Leiste, Modell und Kontext im Eingabefeld, eine offene Frage hängt über dem Eingabefeld":
    "Calmer interface: server switch in the sidebar, ⌘K searches sessions, spaces and commands (focus input is now ⌘J); no header any more – the tools sit in the tab bar, model and context in the composer, an open question hangs above the composer",
  "Status: „neues Ergebnis“ in Blau statt „fertig“, die Übersicht zeigt „Läuft gerade“ mit Filter Alle / Arbeitet / Neu; Linien-Icons und besser lesbarer gedimmter Text":
    "Status: “new result” in blue instead of “done”, the overview shows “Running now” with an All / Working / New filter; line icons and more legible dim text",
  "Nebengespräch im eigenen Fenster: Chat, Terminal, Live und alles andere – bezogen auf die Haupt-Session, ohne sie zu stören; „↺ Zurücksetzen“ startet es neu vom aktuellen Stand, das Ergebnis geht als Entwurf in den Hauptchat":
    "Side conversation in its own window: chat, terminal, live and everything else – about the main session without disturbing it; “↺ Reset” restarts it from the current state, the result goes into the main chat as a draft",
  "Live auf demselben Mac wie der Server hört und spricht wieder – die App hängte sich an die BlackHole-Geräte des Servers":
    "Live on the same Mac as the server hears and speaks again – the app attached itself to the server's BlackHole devices",
  "Im Chat suchen (⌘F): alle Treffer markiert, ↑/↓ bzw. ⌘G, auch in zugeklappten Karten; rechts eine Übersicht des Chats mit den Fundstellen – klicken oder ziehen zum Scrollen (⋯ › Übersicht)":
    "Search the chat (⌘F): all hits highlighted, ↑/↓ or ⌘G, also inside folded cards; on the right an overview of the chat with the hits – click or drag to scroll (⋯ › Overview)",
  "Pfade öffnen: Dateipfade im Chat (Klick) und im Terminal (⌘-Klick) öffnen eine Vorschau – Bilder mit Zoom, Code an der richtigen Zeile, Ordner zum Durchklicken; mit „Pfad kopieren“ und „Im Git-Panel öffnen“":
    "Open paths: file paths in the chat (click) and terminal (⌘-click) open a preview – images with zoom, code at the right line, folders to browse; with “Copy path” and “Open in the git panel”",
  "Nebengespräch: neben einer Session über sie reden (Live mit omp, ⌘⇧L), ohne sie zu stören – eine schreibgeschützte Abzweigung im Seitenbereich, das Ergebnis auf Wunsch als Entwurf zurück in den Hauptchat":
    "Side conversation: talk about a session next to it (live with omp, ⌘⇧L) without disturbing it – a read-only fork in the side panel, the result optionally as a draft back in the main chat",
  "Vorlesen: Die Leiste zeigt den gelesenen Text (Zusammenfassung oder Original) und bleibt offen, bis du sie schließt – mit Tempo (0,7–1,6×), „Nochmal“, Wechsel zwischen Original und Zusammenfassung und ⚙ zu den Einstellungen":
    "Read aloud: the panel shows the text being read (summary or original) and stays open until you close it – with speed (0.7–1.6×), “Again”, switching between original and summary, and ⚙ to the settings",
  "Zusammenfassung vorlesen: neben markiertem Text oder mit ⌘⌥⇧S fasst omp auf dem Server zusammen (Modell und Konto unter Einstellungen › Vorlesen) – danach ist das Original einen Klick entfernt":
    "Read a summary aloud: next to selected text or with ⌘⌥⇧S omp summarizes on the server (model and account in Settings › Read aloud) – the original is one click away afterwards",
  "Terminal: Eine Markierung bleibt stehen, wenn du die Maus danach bewegst – vorher verschwand sie sofort":
    "Terminal: a selection stays when you move the mouse afterwards – it used to vanish at once",
  "Terminal: Wird eine Session schon woanders angezeigt (iPhone, zweites Fenster, hängende Verbindung), übernimmt die neue Ansicht – statt „already has an attached client“":
    "Terminal: when a session is already shown elsewhere (iPhone, a second window, a stale connection), the new view takes over – instead of “already has an attached client”",
  "Phonon 40m ohne Hugging Face: ein Klick auf „Laden“ unter Einstellungen › Vorlesen holt das Modell (148 MB, Deutsch, Englisch, Französisch, Spanisch, Portugiesisch) – kein Konto, kein Token; über 100 Stimmen sind dabei":
    "Phonon 40m without Hugging Face: one click on “Download” in Settings › Read aloud fetches the model (148 MB, German, English, French, Spanish, Portuguese) – no account, no token; over 100 voices included",
  "Vorlesen: Text im Chat oder Terminal markieren und „Vorlesen“ tippen (⌘⇧S) – mit Phonon 40m auf dem Gerät, bis dahin mit der macOS-Stimme; Einstellungen › Vorlesen":
    "Read aloud: select text in the chat or terminal and tap “Read aloud” (⌘⇧S) – with Phonon 40m on the device, until then with the macOS voice; Settings › Read aloud",
  "Warten auf Hintergrund-Jobs zeigt, worauf: Absicht, Jobs, Laufzeit – und wenn fertig, wie lange es gedauert hat":
    "Waiting on background jobs shows what for: intent, jobs, runtime – and when done, how long it took",
  "Ruhigerer Statusblock über dem Eingabefeld: was der Agent gerade tut, die aktuelle Aufgabe mit Phase, Hintergrund-Jobs mit Absicht und Laufzeit":
    "A calmer status block above the composer: what the agent does right now, the current task with its phase, background jobs with intent and runtime",
  "Bash-Karten zeigen den Ordner, wenn der Befehl außerhalb des Projekts lief; Grep-Bereiche lesbar statt mit Semikolons":
    "Bash cards show the folder when the command ran outside the project; grep scopes readable instead of semicolon-separated",
  "Claude Code im Chat: der ganze Verlauf statt nur des Bildschirms – Fragen, Freigaben und der Ordner-Check als Karten zum Antippen":
    "Claude Code in the chat: the whole conversation instead of just the screen – questions, permission prompts and the folder check as cards to tap",
  "Änderungen als echte Diffs mit Zeilennummern und Syntaxfarben; lange Diffs klappen ein":
    "Changes as real diffs with line numbers and syntax colours; long diffs fold",
  "TODO-Listen im Verlauf: jede Änderung als kompakte Zeile, die neueste offen, Erledigtes durchgestrichen":
    "TODO lists in the conversation: every change as a compact line, the newest open, done items struck through",
  "Grep mit Fundstellen, Dateilisten, Subagenten mit ihrer Antwort, Websuche mit Links, Bash mit mehr Ausgabe und Kopierknöpfen":
    "Grep with matching lines, file lists, subagents with their answer, web search with links, bash with more output and copy buttons",
  "Antworten mit Syntax-Highlighting, Kopierknopf an jedem Codeblock und besseren Tabellen":
    "Answers with syntax highlighting, a copy button on every code block and better tables",
  "Statuszeile sagt „Wartet auf dich“, solange der Agent auf dich wartet – die Arbeitszeit zählt ohne diese Wartezeit":
    "The status line says “Waiting for you” while the agent waits for you – working time no longer counts that wait",
  "Git-Stand in Seitenleiste und Spaces aktualisiert sich nach git pull, Commit oder Checkout – nach Aktivität in einer Session binnen Sekunden, sonst spätestens nach 30 s":
    "Git state in the sidebar and spaces updates after git pull, commit or checkout – within seconds after activity in a session, otherwise within 30 s",
  "Terminal: Beim Markieren über den oberen oder unteren Rand ziehen scrollt die Session mit – die ganze Auswahl landet in der Zwischenablage":
    "Terminal: dragging a selection past the top or bottom edge scrolls the session along – the whole selection goes to the clipboard",
  "iPhone: Das Terminal scrollt leichter – feinere Schritte, und ein schneller Wisch läuft mit Schwung aus":
    "iPhone: the terminal scrolls more easily – finer steps, and a quick flick glides on",
  "iPhone: Powerline- und Nerd-Font-Zeichen in Shell-Prompts werden im Terminal richtig gezeichnet":
    "iPhone: Powerline and Nerd Font characters in shell prompts are drawn properly in the terminal",
  "Terminal: Shift+Enter macht in omp und Claude Code eine neue Zeile, statt abzuschicken":
    "Terminal: Shift+Enter makes a new line in omp and Claude Code instead of sending",
  "Terminal: Powerline- und Nerd-Font-Zeichen in Shell-Prompts (Pfeile, Branch-Symbol) werden richtig gezeichnet statt als Kästchen":
    "Terminal: Powerline and Nerd Font characters in shell prompts (arrows, branch symbol) are drawn properly instead of as boxes",
  "Die Seitenleiste zeigt nur den Rechner, den du oben in den Server-Tabs gewählt hast – auch auf der Übersicht bleibt er gewählt":
    "The sidebar shows only the machine you picked in the server tabs at the top – it stays picked on the overview too",
  "Server-Tabs oben: zwischen deinen Rechnern wechseln – mit Verbindungspunkt, „Braucht dich“-Zähler und ⌘⌥1…9; ein Klick öffnet die zuletzt genutzte Session dort":
    "Server tabs at the top: switch between your machines – with connection dot, “Needs you” count and ⌘⌥1…9; a click opens the session you last used there",
  "Tabs per Drag & Drop umsortieren – Server-Tabs und Session-Tabs (die Reihenfolge gilt in Hollr)":
    "Reorder tabs by drag & drop – server tabs and session tabs (the order applies in Hollr)",
  "Der Space ist jetzt der erste Tab – die Tab-Leiste bleibt auch in der Space-Ansicht stehen":
    "The space is now the first tab – the tab bar stays in the space view too",
  "Live läuft weiter, wenn du Tab oder Session wechselst – die Live-Pille in der Seitenleiste zeigt Zustand, Mikro und Auflegen; Tabs, Server und Seitenleiste markieren, wo gesprochen wird":
    "Live keeps running when you switch tab or session – the live pill in the sidebar shows state, mic and hang up; tabs, servers and sidebar mark where the call is",
  "Live merkt eine abgerissene Verbindung („Verbindung verloren“, neu verbinden) und folgt dem Wechsel von Mikrofon und Lautsprecher (AirPods, Bildschirm)":
    "Live notices a dropped connection (“Connection lost”, reconnect) and follows microphone and speaker changes (AirPods, display)",
  "Neue Einstellung „Kopfhörer: Mikrofon immer an“ – du kannst omp dann jederzeit unterbrechen":
    "New setting “Headphones: mic always on” – you can then interrupt omp any time",
  "Uhrzeiten im Chat und eine Zeitleiste über dem Terminal: wann du was geschrieben hast und wann omp geantwortet hat":
    "Times in the chat and a time strip above the terminal: when you wrote what and when omp answered",
  "Terminal-Modus ohne doppelte TODO-Liste und Statuszeile; „Session / Eigene Shell“ und Zen-Modus merkt sich jede Session":
    "Terminal mode without the duplicate TODO list and status line; every session remembers “Session / Own shell” and zen mode",
  "Space-Ansicht frei anordnen: Spalten ziehen, einklappen (⌘\\), Liste und Detail nebeneinander oder untereinander":
    "Arrange the space view freely: drag columns, collapse them (⌘\\), list and detail side by side or stacked",
  "Aus der Seitenleiste genommene Spaces verschwinden auch aus der Übersicht – bis sie dich brauchen":
    "Spaces removed from the sidebar also disappear from the overview – until they need you",
  "Eine neue omp-Session zeigt nicht mehr den Chat einer anderen Session im selben Ordner (braucht hollr 0.33 auf dem Server)":
    "A new omp session no longer shows the chat of another session in the same folder (needs hollr 0.33 on the server)",
  "Live: nach dem Stummschalten hört omp wieder zu – auch wenn die Stummschaltung in omp selbst (Leertaste) aufgehoben wurde; bisher blieb das Mikrofon stumm, obwohl „hört zu“ angezeigt wurde":
    "Live: omp listens again after muting – also when it was unmuted in omp itself (Space); so far the mic stayed silent although “listening” was shown",
  "Tabs schließen: ✕ am Tab, Mittelklick oder Rechtsklick › Schließen – Sessions mit Agent nach Rückfrage":
    "Close tabs: ✕ on the tab, middle click or right-click › Close – sessions with an agent after asking",
  "„Braucht dich“: eine fertige Session gilt als gesehen, sobald du sie öffnest – Fragen bleiben, bis sie beantwortet sind":
    "“Needs you”: a finished session counts as seen as soon as you open it – questions stay until answered",
  "Mac: ein Klick auf eine Mitteilung öffnet jetzt wirklich die Session, um die es geht":
    "Mac: clicking a notification now really opens the session it is about",
  "Jede Session merkt sich Chat oder Terminal – beim Wechsel der Tabs und nach einem Neustart":
    "Every session remembers chat or terminal – when switching tabs and after a restart",
  "Terminal wie Ghostty: markieren kopiert sofort, „Auswahl kopiert“ bestätigt es – ohne Füll-Leerzeichen und Rand der Oberfläche":
    "Terminal like Ghostty: selecting copies right away, “Selection copied” confirms it – without the interface’s padding and margin",
  "Terminal: Text markieren und mit ⌘C kopieren geht jetzt auch in omp, Claude und anderen Vollbild-Programmen – ⌥-Klick geht an das Programm":
    "Terminal: selecting text and copying with ⌘C now also works in omp, Claude and other full-screen programs – ⌥-click goes to the program",
  "Tabs umbenennen: Doppelklick auf einen Tab (oder Rechtsklick › Umbenennen) – der Name gilt auch in herdr":
    "Rename tabs: double-click a tab (or right-click › Rename) – the name applies in herdr too",
  "Seitenleiste breiter oder schmaler ziehen – am rechten Rand; Doppelklick setzt sie zurück":
    "Drag the sidebar wider or narrower – at its right edge; double-click resets it",
  "Klick auf eine Mitteilung holt Hollr nach vorn und öffnet genau diese Session":
    "Clicking a notification brings Hollr to the front and opens exactly that session",
  "Seitenleiste breiter / schmaler": "Sidebar wider / narrower",
  "Ziehen: Breite ändern · Doppelklick: zurücksetzen": "Drag: change width · double-click: reset",
  "Tabs wie in herdr: über jeder Session alle Tabs ihres Space mit Status – ein Klick wechselt, ＋ startet eine neue Sitzung im selben Space":
    "Tabs like in herdr: above every session all tabs of its space with their status – one click switches, ＋ starts a new session in the same space",
  "Seitenleiste wie herdr: alle Server mit ihren Spaces, Branch darunter, Worktrees eingerückt und einklappbar – ein Klick springt in die Session, die dich am meisten braucht":
    "Sidebar like herdr: every server with its spaces, branch below, worktrees indented and foldable – a click jumps into the session that needs you most",
  "Spaces mit ✕ oder Rechtsklick aus der Seitenleiste nehmen – sie kommen von selbst zurück, sobald sie dich brauchen":
    "Remove spaces from the sidebar with ✕ or right-click – they come back by themselves as soon as they need you",
  "Übersicht: lange laufende Agents lassen sich mit ✓ aus „Braucht dich“ nehmen, bis zur nächsten Runde":
    "Overview: long-running agents can be taken out of “Needs you” with ✓ until their next turn",
  "Neue Übersicht: „Braucht dich“ nach Dringlichkeit mit der konkreten Frage, „Woran ich arbeite“ nach Projekt – antworten, Chat, Terminal, Git und Browser direkt von dort, mit Tastenkürzeln (?)":
    "New overview: “Needs you” by urgency with the actual question, “What I’m working on” by project – answer, chat, terminal, Git and browser right from there, with shortcuts (?)",
  "Echtes Terminal: die Oberfläche der Session live, eigene Shell im Ordner der Session, Links mit ⌘-Klick, verbindet sich selbst neu":
    "Real terminal: the session’s interface live, your own shell in the session’s folder, links with ⌘-click, reconnects by itself",
  "Diktat auf dem Gerät mit Whisper – mit deinem Fachvokabular, Modelle unter Einstellungen › Diktat":
    "On-device dictation with Whisper – with your technical vocabulary, models under Settings › Dictation",
  "Ordner auf dem Server durchsuchen beim Anlegen von Sitzungen und Spaces":
    "Browse server folders when creating sessions and spaces",
  "Koppeln per Einmalcode – ideal von unterwegs über Tailscale": "Pair with a one-time code – ideal on the go via Tailscale",
  "Server-Info: Einrichtungs-Checkliste mit Installieren und Neu starten":
    "Server info: setup checklist with install and restart",
  "App-Sperre mit Touch ID oder Passwort": "App lock with Touch ID or password",
  "Tipps & Tricks beim ersten Start – jederzeit unter Einstellungen › Allgemein":
    "Tips & tricks on first start – any time under Settings › General",
  "Designs: Dracula, Nord, Solarized, Gruvbox, Catppuccin, GitHub und mehr – hell, dunkel oder automatisch":
    "Themes: Dracula, Nord, Solarized, Gruvbox, Catppuccin, GitHub and more – light, dark or automatic",
  "Server-Info: Auslastung, Prozesse und ob der Server korrekt eingerichtet ist":
    "Server info: load, processes and whether the server is set up correctly",
  "herdr, omp, Claude Code, Codex und Hollr direkt aus der App installieren und aktualisieren":
    "Install and update herdr, omp, Claude Code, Codex and Hollr right from the app",
  "Desktop-Mitteilungen, wenn ein Agent auf dich wartet, fertig ist oder einen Fehler hat":
    "Desktop notifications when an agent waits for you, finishes or fails",
  "Ganze App skalieren – auch mit ⌘+ / ⌘− / ⌘0": "Scale the whole app – also with ⌘+ / ⌘− / ⌘0",
  "App-Sprache Deutsch oder Englisch – unabhängig vom System": "App language German or English – independent of the system",
  "Git: Dateien, Änderungen mit Diff, Verlauf-Graph, Branches mit PR-Status":
    "Git: files, changes with diff, history graph, branches with PR status",
  "Spaces: Repos und Worktrees anlegen, öffnen und schließen": "Spaces: create, open and close repos and worktrees",
  "localhost-Seiten des Servers im Browser öffnen – über SSH, ohne Zusatzdienst":
    "Open the server's localhost pages in the browser – over SSH, no extra service",
  "Modell und Thinking/Effort beim Start einer Sitzung wählen und unterwegs wechseln":
    "Pick model and thinking/effort when starting a session and switch on the fly",
  "Skeletons statt Lade-Kreisel": "Skeletons instead of spinners",
  "Server per Link koppeln – nur SSH, kein Zusatzdienst": "Pair servers with a link – SSH only, no extra service",
  "omp, Claude Code, Codex und Terminals öffnen, lesen, schreiben und schließen":
    "Open, read, write to and close omp, Claude Code, Codex and terminals",
  "Übersicht zeigt deine Sitzungen, gruppiert nach Maschine": "Overview shows your sessions, grouped by machine",
  // prompt snippets
  "Nach oben": "Move up",
  "Keine Bausteine.": "No snippets.",
  "Neuer Baustein …": "New snippet …",
  "Hinzufügen": "Add",
  "Erscheinen als Chips über dem Eingabefeld; ein Klick fügt den Text an der Schreibmarke ein.": "Shown as chips above the input field; a click inserts the text at the cursor.",
  "Standard wiederherstellen": "Restore defaults",
  // folder picker
  "Ordner wählen": "Choose folder",
  "Übergeordneter Ordner": "Parent folder",
  "Ordner filtern": "Filter folders",
  "Projekt-Orte": "Project locations",
  "Nichts gefunden.": "Nothing found.",
  "Keine Unterordner.": "No subfolders.",
  "Wählen": "Choose",
  "Klick öffnet den Ordner, „Wählen“ übernimmt ihn direkt. Git-Repos sind markiert.": "Click opens the folder, “Choose” picks it right away. Git repos are marked.",
  "Neuer Unterordner": "New subfolder",
  "Wird beim Anlegen des Space erstellt.": "Created together with the space.",
  "Diesen wählen": "Choose this one",
  "Durchsuchen …": "Browse …",
  // setup checklist
  "Installation läuft – in einer Minute neu prüfen.": "Installing – check again in a minute.",
  "Wächter läuft wieder.": "Watcher is running again.",
  "Neustart hat nicht geklappt.": "Restart failed.",
  "Einrichtung · {ok}/{n} bereit": "Setup · {ok}/{n} ready",
  "Alles eingerichtet": "All set up",
  "Neu starten": "Restart",
  "Push richtest du in der Hollr-App auf dem iPhone ein: Server › Einrichtung › „Push einrichten“.": "Set up push in the Hollr app on your iPhone: Server › Setup › “Set up push”.",
  // tips tour
  "Neu und praktisch": "New and handy",
  "Los geht’s": "Let’s go",
  "Weiter": "Next",
  "Tipps & Tricks": "Tips & tricks",
  "Oben auf der Startseite: Fragen von omp mit einem Klick beantworten, wartenden oder fertigen Agents direkt antworten.": "At the top of the home screen: answer omp's questions with a click, reply directly to waiting or finished agents.",
  "Wartet ein Agent auf dich oder ist fertig, meldet sich Hollr mit einer Mitteilung – ein Klick öffnet den Chat. Abschaltbar unter Einstellungen › Allgemein.": "When an agent waits for you or is done, Hollr sends a notification – a click opens the chat. Turn off under Settings › General.",
  "{mod}K findet jede Sitzung und jeden Befehl. Im Chat: {mod}J Eingabe, {mod}⇧G Git & Dateien, {mod}⇧B Browser, {mod}⇧I Info, {mod}⇧M Modell, {mod}. bricht ab.": "{mod}K finds every session and command. In a chat: {mod}J input, {mod}⇧G Git & files, {mod}⇧B browser, {mod}⇧I info, {mod}⇧M model, {mod}. interrupts.",
  "{mod}⇧T wechselt zwischen Chat und dem Terminal der Session – derselbe Bildschirm wie am Rechner.": "{mod}⇧T switches between the chat and the session's terminal – the same screen as on the computer.",
  "Bausteine und @": "Snippets and @",
  "Über dem Eingabefeld stehen deine Prompt-Bausteine. „@“ schlägt Dateien aus dem Repo vor.": "Your prompt snippets sit above the input field. “@” suggests files from the repo.",
  "Anhänge": "Attachments",
  "Büroklammer, Einfügen oder einfach ins Eingabefeld ziehen: Bilder und Dateien gehen mit an den Agent.": "Paper clip, paste or just drag into the input field: images and files go along to the agent.",
  "Änderungen prüfen": "Review changes",
  "Git & Dateien › Änderungen: Dateien stagen, verwerfen oder kommentieren. Unten: Commit, Push, PR.": "Git & files › Changes: stage, discard or comment on files. At the bottom: commit, push, PR.",
  "Ordner durchsuchen": "Browse folders",
  "Neue Sitzung oder neuer Space: „Durchsuchen …“ zeigt die Ordner des Servers, Git-Repos sind markiert. Tippen geht weiterhin.": "New session or new space: “Browse …” shows the server's folders, git repos marked. Typing still works.",
  "Einrichtung prüfen": "Check setup",
  "Server-Info: was auf dem Server noch fehlt, mit „Installieren“, „Neu starten“ oder einem Befehl zum Kopieren.": "Server info: what's still missing on the server, with “Install”, “Restart” or a command to copy.",
  "{mod}⇧F: nur Verlauf und Eingabe – dein Entwurf bleibt beim Umschalten erhalten.": "{mod}⇧F: only history and input – your draft survives switching.",
  "Unterwegs auf dem iPhone": "On the go with iPhone",
  "Widgets, Siri, Live-Aktivität und Antworten aus der Mitteilung gibt es in der iPhone-App – mit denselben Servern.": "Widgets, Siri, Live Activity and replying from notifications live in the iPhone app – with the same servers.",
  // app lock (Touch ID / password); the reasons finish macOS' "„Hollr“ versucht, …" / "Hollr is trying to …"
  Sicherheit: "Security",
  "Mit {name} sperren": "Lock with {name}",
  "Mit {name} entsperren": "Unlock with {name}",
  "Fragt beim Öffnen und nach mehr als 30 Sekunden im Hintergrund.": "Asks when opening and after more than 30 seconds in the background.",
  "Hollr ist gesperrt": "Hollr is locked",
  "Die Agents arbeiten auf dem Server weiter.": "The agents keep working on the server.",
  Passwort: "Password",
  "Hollr zu entsperren": "unlock Hollr",
  "die Sperre einzuschalten": "turn on the lock",
  "die Sperre auszuschalten": "turn off the lock",
  "Live-Sprache": "Live voice",
  "Kopfhörer: Mikrofon immer an": "Headphones: microphone always on",
  "Ohne Kopfhörer schaltet Hollr das Mikrofon stumm, solange omp spricht (sonst hört omp sich selbst) – nur deutlich lauteres Reinreden kommt durch. Mit Kopfhörern kannst du jederzeit unterbrechen. Gilt sofort, auch mitten im Gespräch.":
    "Without headphones Hollr mutes the microphone while omp speaks (otherwise omp hears itself) – only clearly louder talking gets through. With headphones you can interrupt any time. Applies at once, even mid-call.",
};
