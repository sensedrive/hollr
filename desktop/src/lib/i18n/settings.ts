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
  "Im Chat: {mod}K Eingabe, {mod}⇧G Git & Dateien, {mod}⇧B Browser, {mod}⇧I Info, {mod}⇧M Modell, {mod}. bricht ab.": "In a chat: {mod}K input, {mod}⇧G Git & files, {mod}⇧B browser, {mod}⇧I info, {mod}⇧M model, {mod}. interrupts.",
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
  Passwort: "Password",
  "Hollr zu entsperren": "unlock Hollr",
  "die Sperre einzuschalten": "turn on the lock",
  "die Sperre auszuschalten": "turn off the lock",
  "Live-Sprache": "Live voice",
  "Kopfhörer: Mikrofon immer an": "Headphones: microphone always on",
  "Ohne Kopfhörer schaltet Hollr das Mikrofon stumm, solange omp spricht (sonst hört omp sich selbst) – nur deutlich lauteres Reinreden kommt durch. Mit Kopfhörern kannst du jederzeit unterbrechen. Gilt sofort, auch mitten im Gespräch.":
    "Without headphones Hollr mutes the microphone while omp speaks (otherwise omp hears itself) – only clearly louder talking gets through. With headphones you can interrupt any time. Applies at once, even mid-call.",
};
