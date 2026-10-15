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
};
