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
  "Neuer Worktree: eingefügte Leerzeichen fallen weg. Während er angelegt wird, zeigt das Feld „wird angelegt“ und nimmt keinen zweiten an.":
    "New worktree: pasted whitespace is removed. While it is being created the field says so and will not take another.",
  "Der blaue Punkt an einem Space bleibt weg, nachdem du ihn angesehen hast – auch nach einem Neustart. Ein neues Ergebnis bringt ihn zurück.":
    "The blue dot on a space stays gone after you have looked at it, including after a restart. A new result brings it back.",
  "Neue Sitzung öffnet sofort ein Terminal im aktuellen Space; omp, Claude Code & Co. startest du dort selbst. Der neue Tab wird auch in herdr aktiv.":
    "New session opens a terminal in the current space right away; start omp, Claude Code & co. there yourself. The new tab becomes active in herdr too.",
  "Space-Menü aufgeräumt: „Space beenden“ beendet Tabs und Agenten (Dateien und Branch bleiben), „Ausblenden“ nur aus der Liste, „Worktree löschen …“ auf Wunsch samt Branch. Spaces lassen sich per Ziehen sortieren.":
    "Space menu tidied up: “End space” stops tabs and agents (files and branch stay), “Hide” only takes it off the list, “Delete worktree …” optionally with its branch. Spaces can be reordered by dragging.",
  "Notizen als Sprungmarken: Text markieren, „Notiz erstellen“ – die Stelle leuchtet in der Übersichtsleiste von Chat und Terminal, ein Klick springt hin.":
    "Notes as jump marks: select text, “Create note” – the spot lights up in the overview bar of chat and terminal, a click jumps there.",
  "Das Terminal hat eine echte Übersicht: der Verlauf in Miniatur mit seinen Farben, klicken oder ziehen zum Scrollen. Der Umschalter „Session / Eigene Shell“ ist weg.":
    "The terminal has a real overview: its scrollback in miniature with its colours, click or drag to scroll. The “Session / Own shell” switch is gone.",
  "Nachfragen ohne Markierung, mit oder ohne Kontext des Hauptchats (spart Tokens), „/“ schlägt Skills vor. Die Liste lässt sich einklappen, Nachfragen umbenennen und schließen (gibt Speicher frei).":
    "Side questions without a selection, with or without the main chat's context (saves tokens), “/” suggests skills. The list folds away, side questions can be renamed and closed (frees memory).",
  "Hintergrund-Jobs anklicken: Befehl, Laufzeit und – wenn fertig – die Ausgabe.":
    "Click background jobs: command, run time and – once done – the output.",
  "Spaces und Tabs lassen sich als ungelesen markieren (blauer Punkt).":
    "Spaces and tabs can be marked as unread (blue dot).",
  "„Braucht dich“-Karten ohne Knöpfe: ein Klick auf die Karte öffnet die Sitzung. omp-Artefakte (local://…) öffnen sich in der Vorschau.":
    "“Needs you” cards without buttons: a click on the card opens the session. omp artifacts (local://…) open in the preview.",
  "Chat in Terminal-Farben (fett, Code, Tabellenköpfe). Die Prompt-Bausteine über dem Eingabefeld sind aus – in Einstellungen › Allgemein wieder einschaltbar.":
    "Chat in terminal colours (bold, code, table heads). The prompt snippets above the input field are off – switch them back on in Settings › General.",
  "Behoben: Schließen-Dialog hing, Zahlen der Änderungen im Schließen-Dialog und Git-Panel, verwaiste Worktrees samt Branch löschen, Rückfragen erscheinen wieder (statt stumm „Nein“).":
    "Fixed: the close dialog hung, change counts in the close dialog and git panel, orphaned worktrees can be deleted with their branch, confirmations show again (instead of a silent “no”).",
  "Sandcastle: Ansicht „Versionen“ – welches Projekt auf welchem Rechner mit welcher lul-workr-Version läuft, ob der Bereich passt oder die Schleife noch abgezweigt ist; Aktualisieren je Rechner.":
    "Sandcastle: “Versions” view – which project runs on which computer with which lul-workr version, whether the range fits or the loop is still forked; update per computer.",
  "Sandcastle: Jedes eingereihte Ticket gehört genau einem Rechner – Läufe auf Mac und workr ziehen nie dieselben Tickets.":
    "Sandcastle: every queued ticket belongs to exactly one computer – runs on the Mac and workr never pick the same tickets.",
  "Werkzeuge: neues Werkzeug „lul-workr“ – Skills und Sandcastle als ein versioniertes Paket je Rechner; Installieren und Aktualisieren per Knopf, jeder Skill liegt danach genau einmal vor.":
    "Tools: new tool “lul-workr” – skills and Sandcastle as one versioned package per computer; install and update at a tap, afterwards every skill exists exactly once.",
  "Sandcastle einrichten: geklont wird so, wie der Rechner GitHub erreicht (SSH, wenn seine Projekte SSH nutzen) – sonst scheiterte später jedes Holen am Passwort.":
    "Sandcastle setup: clones the way the computer reaches GitHub (SSH when its projects use SSH) – otherwise every later fetch failed asking for a password.",
  "Sandcastle: „Maschine wechseln“ im Lauf-Panel – die Warteschlange zieht auf einen anderen Rechner um; fehlt dort das Projekt, richtet das Board es ein (klonen, lokale Dateien nach Bestätigung kopieren, Abhängigkeiten, Prüfliste).":
    "Sandcastle: “Switch machine” in the run panel – the queue moves to another computer; if the project is missing there, the board sets it up (clone, copy local files after you confirm, dependencies, checklist).",
  "Sandcastle: Der Grill-Stand stimmt – fertig gegrillt, sobald Story und Kinder auf GitHub stehen; laufende Grills zeigen ihren Schritt aus dem Ablauf-Log, sonst „Stand unbekannt“ statt geratener Zahlen.":
    "Sandcastle: the grill state is right – grilled as soon as the story and its children are on GitHub; running grills show their step from the flow log, otherwise “state unknown” instead of guessed numbers.",
  "Sandcastle: Issues, die auf etwas anderes als ein Issue warten (etwa ein Release), gelten als blockiert und werden nicht mehr in Läufe genommen.":
    "Sandcastle: issues waiting on something other than an issue (a release, say) count as blocked and are no longer taken into runs.",
  "Sandcastle: Lauf-Panel und Lauf-Leiste zeigen den Lauf je Kind-Issue – Runde mit Planer, Kinder bauen und Merge, „3/9 gemergt“ je Story und jedes Kind mit seinem Stand.":
    "Sandcastle: run panel and run dock show the run per child issue – the round with planner, building children and merge, “3/9 merged” per story and every child with its state.",
  "Sandcastle: sichtbar, was gerade läuft – „Implementer an #3605 · Code-Review an #3604“, mit „seit …“ an den laufenden Kindern.":
    "Sandcastle: see what runs right now – “Implementer on #3605 · Code review on #3604”, with “since …” on running children.",
  "Sandcastle auf dem iPhone: Lauf-Leiste als Blatt mit wischbaren Story-Chips, Lauf-Panel im Vollbild.":
    "Sandcastle on the iPhone: the run dock as a sheet with swipeable story chips, the run panel full screen.",
  "Suche (⌘K) merkt sich die letzte Eingabe – markiert, sodass Tippen eine neue beginnt; × im Feld löscht sie.":
    "Search (⌘K) keeps your last query – selected, so typing starts a new one; × in the field clears it.",
  "Spaces: was Hollr für Sandcastle-Läufe und Grills öffnet, steht in einer eigenen Gruppe „Sandcastle & Grills“.":
    "Spaces: what Hollr opens for Sandcastle runs and grills sits in its own group “Sandcastle & grills”.",
  "Grillen holt vorher den neuesten Stand in den Hauptordner (nur Vorspulen, eigene Änderungen bleiben); klappt das nicht, sagt das Board warum.":
    "Grilling first brings the main checkout up to date (fast-forward only, your changes stay); if that fails, the board says why.",
  "Spaces: *4 ↑1 ↓29 erklärt sich beim Darüberfahren – geänderte Dateien, nicht gepushte Commits, Commits hinter dem Server.":
    "Spaces: hover *4 ↑1 ↓29 for what it means – changed files, unpushed commits, commits behind the server.",
  "Plugins bleiben offen: Wer vom Sandcastle-Board in einen Chat wechselt und zurück, findet es genau so wieder – Filter, geöffnetes Ticket, Scrollstand.":
    "Plugins stay open: switching from the Sandcastle board to a chat and back finds it exactly as you left it – filters, open ticket, scroll position.",
  "Sandcastle: Läufe ohne Ablauf-Log zeigen keinen geratenen Schritt mehr (bisher hing er auf „Vorprüfung“), sondern was der Agent zuletzt geschrieben hat und gerade tut.":
    "Sandcastle: runs without a flow log no longer show a guessed step (it used to stick at “Pre-check”), but what the agent last wrote and is doing now.",
  "Sandcastle: neue Läufe-Ansicht – je Rechner ein klarer Status, rechts „Was passiert gerade“ als Zeitleiste von Start bis Bericht, deutlicher Hinweis, wenn der Lauf auf deine Antwort wartet.":
    "Sandcastle: new runs view – a clear status per machine, on the right “What's happening” as a timeline from start to report, a clear note when the run waits for your answer.",
  "Sandcastle: „Neuer Lauf“ stellt alles ein – Agent und Modell, Parallelität, Ziel-Branch, Batch oder einzeln, Testserver und Testanweisung – mit Vorschau des genauen Befehls; der Agent fragt danach nichts mehr.":
    "Sandcastle: “New run” sets everything – agent and model, parallelism, target branch, batch or one by one, test server and test instructions – with a preview of the exact command; the agent asks nothing afterwards.",
  "Sandcastle: Tickets direkt aus ihrer Seitenleiste in einen Lauf einreihen, nach vorne holen oder herausnehmen.":
    "Sandcastle: queue tickets into a run right from their side panel, move them to the front or take them out.",
  "Sandcastle: echter Fortschritt aus dem Ablauf-Log von skippr – welche Rolle gerade an welchem Ticket arbeitet.":
    "Sandcastle: real progress from skippr's flow log – which role is working on which ticket right now.",
  "Behoben: Ein Ticket aus der Suche oder einem Link öffnet sich im Board auch ein zweites Mal, nachdem du es geschlossen hast.":
    "Fixed: a ticket from search or a link opens on the board again after you closed it.",
  "Sandcastle: Läufe starten auch in Projekten, deren Schleife die Warteschlange noch nicht kennt – mit den eingereihten Tickets als feste Liste; „▷ Lauf starten“ direkt in der Rechnerzeile der Lauf-Leiste.":
    "Sandcastle: runs also start in projects whose loop doesn't know the queue yet – with the queued tickets as a fixed list; “▷ Start run” right in the machine's row of the run dock.",
  "Hollrs Tastenkürzel (⌘K, ⌘1, ⌘N, ⌘, …) funktionieren auch, während ein Plugin wie das Sandcastle-Board den Fokus hat.":
    "Hollr's shortcuts (⌘K, ⌘1, ⌘N, ⌘, …) also work while a plugin like the Sandcastle board has the focus.",
  "Suche (⌘K) findet Tickets: JIRA-Schlüssel, #Issue-Nummern oder Wörter aus dem Titel – ↩ öffnet das Ticket im Sandcastle-Board.":
    "Search (⌘K) finds tickets: JIRA keys, #issue numbers or words from the title – ↩ opens the ticket on the Sandcastle board.",
  "Übersicht: „Läuft gerade“ links und startet mit „Arbeitet“, „Braucht dich“ rechts.":
    "Overview: “Running now” on the left and starting with “Working”, “Needs you” on the right.",
  "Tickets (z. B. TENDR-1037) und Issues/PRs (#3575) in Chat und Terminal sind klickbar – öffnet das Sandcastle-Board direkt auf dem Ticket, ohne Board die GitHub- bzw. JIRA-Seite.":
    "Tickets (e.g. TENDR-1037) and issues/PRs (#3575) in chat and terminal are clickable – opens the Sandcastle board right on the ticket, without a board the GitHub or JIRA page.",
  "Übersicht: „Zuletzt“ statt „Alle“ – alle Agenten in einer Liste, wer zuletzt etwas gemeldet hat, steht oben; arbeitende zeigen, seit wann sie arbeiten.":
    "Overview: “Recent” instead of “All” – every agent in one list, the one that reported last on top; working ones show for how long they've been at it.",
  "Behoben: Auch omp-Sitzungen, die schon vor der herdr-Anbindung liefen, zeigen jetzt, dass sie arbeiten – Hollr liest es aus ihrem Fenstertitel.":
    "Fixed: omp sessions that were already running before herdr's hookup now show that they're working too – Hollr reads it from their window title.",
  "Behoben: Sitzungen auf Servern standen immer auf „bereit“, auch während sie arbeiteten – Hollr richtet beim Aktualisieren jetzt die herdr-Anbindung für omp, Claude Code und Codex ein.":
    "Fixed: sessions on servers always showed “ready”, even while working – updating Hollr now sets up herdr's hookup for omp, Claude Code and Codex.",
  "Sandcastle: Läufe als Leiste unter dem Ticket-Board – je Rechner die Tickets in Lauf-Reihenfolge, Karten hineinziehen, umsortieren, „Neuer Lauf“ mit Rechner, Ziel-Branch und Tickets, „Lauf stoppen“.":
    "Sandcastle: runs as a dock under the ticket board – per machine the tickets in run order, drag cards in, reorder, “New run” with machine, target branch and tickets, “Stop run”.",
  "Behoben: Ältere Grills zeigten „Schritt 1/7“, obwohl sie fast fertig waren – Schritte, die die Statusdatei nicht nennt, zählen als erledigt, wenn ein späterer erledigt ist.":
    "Fixed: older grills showed “step 1/7” although they were nearly done – steps the status file doesn't mention count as done when a later one is.",
  "Plugins verbinden sich selbst neu, wenn ihr Dienst auf dem Rechner neu gestartet wurde – kein „Load failed“ mehr, kein Wiederöffnen nötig.":
    "Plugins reconnect by themselves when their service on the machine was restarted – no more “Load failed”, no reopening needed.",
  "Einstellungen › Integrationen: JIRA-Zugang einmal eintragen – Hollr prüft ihn und hinterlegt ihn auf allen gekoppelten Rechnern (nur dort, nie in der App).":
    "Settings › Integrations: enter JIRA access once – Hollr checks it and stores it on every paired machine (only there, never in the app).",
  "Sandcastle-Board: Tickets grillen oder auto-grillen – auf dem Rechner deiner Wahl. Jeder Grill ist eine normale Sitzung in Hollr; das Board zeigt Fortschritt und „wartet auf dich“, auch für von Hand gestartete Grills.":
    "Sandcastle board: grill or auto-grill tickets – on the machine of your choice. Every grill is a normal Hollr session; the board shows progress and “waiting for you”, also for grills started by hand.",
  "Chat-Menü › „Im Board zeigen“ bei Grill-Sitzungen springt zur Karte im Sandcastle-Board.":
    "Chat menu › “Show on board” on grill sessions jumps to the card on the Sandcastle board.",
  "Plugins anpinnen: angepinnte Plugins stehen direkt oben in der Seitenleiste.":
    "Pin plugins: pinned plugins sit right at the top of the sidebar.",
  "Behoben: Das Sandcastle-Board zeigte neue Labels nicht – über die Hollr-Verbindung gestartet, fehlte dem Plugin die GitHub-Anmeldung. „Neu laden“ holt jetzt alles neu.":
    "Fixed: the Sandcastle board didn't show new labels – started over the Hollr connection, the plugin lacked the GitHub login. “Reload” now fetches everything again.",
  "„Plugins“ in der Seitenleiste öffnet direkt das zuletzt genutzte Plugin; der Pfeil zurück führt zur Übersicht.":
    "“Plugins” in the sidebar opens the plugin you used last; the back arrow leads to the overview.",
  "Plugins übernehmen das Farbschema von Hollr samt Hell/Dunkel – auch beim Umschalten, während das Plugin offen ist.":
    "Plugins follow Hollr's colour theme including light/dark – also when you switch while the plugin is open.",
  "Sandcastle-Plugin 2: Schnellfilter (/ – l:label @person s:story #nr), „JIRA-Link“ für das Team, Warteschlange je Rechner, Fortschritt und Einstellungen jedes Laufs, Deploy/Video/Branch an den Karten.":
    "Sandcastle plugin 2: quick filter (/ – l:label @person s:story #nr), “JIRA link” for the team, a queue per machine, progress and settings of every run, deploy/video/branch on the cards.",
  "Neue Ansicht „Läufe“: welche Sandcastle-Läufe auf welchem Rechner laufen – auch von Hand gestartete –, mit den Logs jedes Tickets live.":
    "New view “Runs”: which Sandcastle runs are going on which machine – also ones started by hand – with every ticket's logs live.",
  "Behoben: „Keine Verbindung“ obwohl das Terminal lief – bei vielen offenen Chats und Terminals nahm der Server keine weitere Sitzung an. Hollr öffnet dann eine zweite Verbindung.":
    "Fixed: “No connection” while the terminal kept working – with many open chats and terminals the server refused another session. Hollr now opens a second connection.",
  "Dieselben Rechner auf allen Geräten: wird ein Rechner auf dem iPhone oder einem anderen Mac gekoppelt, koppelt sich Hollr hier selbst damit; Entfernen gilt für alle Geräte.":
    "The same machines on every device: when a machine is paired on the iPhone or another Mac, Hollr pairs with it here by itself; removing applies to all devices.",
  "Prompt-Bausteine und das Diktat-Vokabular sind auf allen Geräten gleich.":
    "Prompt snippets and the dictation vocabulary are the same on every device.",
  "Behoben: Spaces ziehen nahm versteckte Spaces aus der gemerkten Reihenfolge.":
    "Fixed: dragging spaces took hidden spaces out of the remembered order.",
  "Hollr in der Menüleiste: „Zugeklappt wach bleiben“ hält das MacBook auch auf Akku mit geschlossenem Deckel wach – vom iPhone erreichbar. Einmal Admin-Passwort; unter 20 % Akku und beim Beenden von Hollr darf es wieder schlafen.":
    "Hollr in the menu bar: “Stay awake when closed” keeps the MacBook awake with the lid closed, also on battery – reachable from the iPhone. Admin password once; below 20 % battery and when Hollr quits it may sleep again.",
  "„Braucht dich“, gesehene Ergebnisse, „Als ungelesen markieren“, „Meine Sitzungen“ und die Reihenfolge von Spaces, Worktrees und Tabs merkt sich jetzt der Server – Mac und iPhone zeigen dasselbe.":
    "“Needs you”, seen results, “Mark as unread”, “My sessions” and the order of spaces, worktrees and tabs are now kept on the server – Mac and iPhone show the same.",
  "Versteckte Spaces: unten in der Seitenleiste unter „Versteckt“ aufklappen, ohne sie zurückzuholen. Per Ziehen oder Klick zurückholen oder beenden; ein Space, den du auf „Versteckt“ ziehst, verschwindet aus der Liste.":
    "Hidden spaces: expand them at the bottom of the sidebar under “Hidden” without bringing them back. Bring them back or end them by dragging or a click; a space you drag onto “Hidden” leaves the list.",
  "Was versteckt ist, merkt sich jetzt der Server – Mac und iPhone zeigen immer dieselben Spaces.":
    "The server now remembers what is hidden – Mac and iPhone always show the same spaces.",
  "Der Chat bleibt nicht mehr stehen, während das Terminal weiterläuft, und „Arbeitet …“ verschwindet, wenn der Agent wirklich fertig ist (auch nach einem Absturz).":
    "The chat no longer freezes while the terminal keeps going, and “Working …” goes away once the agent is really done (also after a crash).",
  "Terminal: die Übersichtsleiste hängt nicht mehr und kostet weniger Verbindung, Sprung zu Notizen trifft die richtige Stelle, Kopieren über den Rand klappt auch mit Emoji.":
    "Terminal: the overview bar no longer hangs and uses less connection, jumping to notes lands in the right place, copying past the edge works with emoji too.",
  "Behoben: graue „Wird gesendet“-Blasen, die nie verschwanden, Chat oben statt unten nach dem Terminal, „↓ Neu“ ohne Neues, eingefrorene Ansichten nach dem Ruhezustand.":
    "Fixed: grey “sending” bubbles that never went away, the chat at the top instead of the bottom after the terminal, “↓ New” with nothing new, frozen views after sleep.",
  "Sitzungen, deren Verlauf ein abgeschnittenes Emoji enthält, laden im Chat wieder – auf dem iPhone blieb der Chat dann leer.":
    "Sessions whose history contains a cut-off emoji load in the chat again – on the iPhone the chat stayed empty.",
  "Neu: Plugins. Ein Server-Plugin bringt seine eigene Oberfläche mit, Hollr zeigt sie in der Seitenleiste unter „Plugins“. Auf dem Server einschalten mit: hollr plugin link <ordner>":
    "New: plugins. A server plugin brings its own interface; Hollr shows it in the sidebar under “Plugins”. Turn one on on the server with: hollr plugin link <folder>",
  "Erstes Plugin „Sandcastle“: Issue-Board eines lul-workr-Projekts mit Warteschlange zum Ziehen und einer Ansicht für Sandcastle-Läufe.":
    "First plugin “Sandcastle”: an issue board for a lul-workr project with a drag-and-drop queue and a view of Sandcastle runs.",
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
  "Prompt-Bausteine über dem Eingabefeld": "Prompt snippets above the composer",
  "Die Chips („Lass die Tests laufen …“ usw.) ein- oder ausblenden.":
    "Show or hide the chips (“Run the tests …”, etc.) above the input field.",
  Composer: "Composer",
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
