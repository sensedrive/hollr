import SwiftUI

/// What came when (Settings → Neuigkeiten). Newest first; add an entry with every build.
struct ReleaseNote: Identifiable {
    let build: Int
    let date: String
    let items: [(icon: String, text: String)]
    var id: Int { build }
}

enum ReleaseNotes {
    static let all: [ReleaseNote] = [
        ReleaseNote(build: 39, date: "15.10.2026", items: [
            ("apple.terminal", String(localized: "Echtes Terminal: Menü › Terminal zeigt die Session live in Farbe, mit Tastenleiste (esc, tab, ctrl, Pfeile) – zum Hineinzoomen aufziehen")),
            ("text.badge.plus", String(localized: "Prompt-Bausteine über der Tastatur und „@“ schlägt Dateien aus dem Repo vor (Einstellungen › Prompt-Bausteine)")),
            ("paperclip", String(localized: "Anhänge: Foto, Bildschirmfoto, Datei oder Bild aus der Zwischenablage an den Agent – und „Teilen › Hollr“ aus Safari, Mail oder Fotos")),
            ("checkmark.circle", String(localized: "Änderungen prüfen: wischen zum Stagen, Verwerfen oder Kommentieren, dann Commit (oder vom Agent schreiben lassen), Push und PR")),
            ("square.grid.2x2", String(localized: "Widgets für Home- und Sperrbildschirm (Agents, Limits) und Kurzbefehle/Siri: „Frag … in Hollr“, „Live starten“")),
            ("paintbrush", String(localized: "Ruhigerer Chat: Werkzeuge als eine Zeile zusammengefasst, Farbe pro Workspace, Zoom von der Karte in den Chat")),
            ("rectangle.split.2x1", String(localized: "Mac: Agents in der Seitenleiste, zwei Chats nebeneinander (Rechtsklick › Rechts daneben öffnen)")),
        ]),
        ReleaseNote(build: 38, date: "15.10.2026", items: [
            ("tray.full", String(localized: "Neu auf der Startseite: „Braucht dich“ – Fragen von omp mit einem Tipp beantworten, wartenden oder fertigen Agents direkt antworten")),
            ("bell.badge", String(localized: "Antworten direkt aus der Mitteilung: lange drücken für die Antwort-Optionen oder eine eigene Antwort")),
            ("platter.filled.bottom.iphone", String(localized: "Live-Aktivität: arbeitende Agents auf dem Sperrbildschirm und in der Dynamic Island – Schritt, Fortschritt, Laufzeit, orange wenn sie auf dich warten")),
        ]),
        ReleaseNote(build: 37, date: "15.10.2026", items: [
            ("doc.text", String(localized: "Entwürfe gehen nicht mehr verloren: Zen-Modus, Chat-Wechsel oder App-Neustart behalten den getippten Text – pro Chat")),
            ("waveform", String(localized: "Ein Diktat läuft beim Umschalten in den Zen-Modus weiter und landet im richtigen Chat")),
            ("wifi.exclamationmark", String(localized: "Nach Ruhezustand oder Netzwechsel hängt nichts mehr minutenlang – tote Verbindungen werden erkannt und neu aufgebaut")),
            ("phone.connection", String(localized: "Live erkennt Verbindungsabbrüche und zeigt, warum ein Anruf endete")),
            ("mic", String(localized: "Mikrofon-Knopf bleibt nach einem Anruf oder einer Abfrage nicht mehr hängen, kein Doppelstart")),
            ("square.stack.3d.up", String(localized: "Spaces: Chat-Wechsel und „Chat schließen“ funktionieren, Koppeln per Code wartet auf die Netzwerk-Freigabe")),
        ]),
        ReleaseNote(build: 36, date: "15.10.2026", items: [
            ("ladybug", String(localized: "Absturz beim Öffnen mancher Chats behoben (Cursor-Position im Eingabefeld)")),
        ]),
        ReleaseNote(build: 35, date: "14.10.2026", items: [
            ("waveform", String(localized: "Diktat mit Parakeet und Whisper erkennt schon beim Sprechen – nach dem Stopp ist der Text fast sofort da")),
            ("hand.tap", String(localized: "Mikrofon gedrückt halten zum Diktieren, ✕ verwirft die Aufnahme, Diktat landet an der Cursor-Position")),
            ("text.magnifyingglass", String(localized: "Projekt, Tickets und Dateinamen aus dem Chat werden besser erkannt und richtig geschrieben (z. B. TENDR-725)")),
            ("paperplane", String(localized: "„… senden“ am Ende schickt die Nachricht ab")),
            ("scissors", String(localized: "„ähm“ und „äh“ fliegen raus, erfundene Untertitel bei Stille auch")),
            ("phone.arrow.down.left", String(localized: "Anruf, App-Wechsel oder AirPods weg: das Diktat stoppt sauber und behält das Gesagte")),
            ("slider.horizontal.3", String(localized: "Neu in Einstellungen › Sprache: Rauschfilter, immer iPhone-Mikrofon, Feinschliff mit Apple Intelligence (Beta)")),
        ]),
        ReleaseNote(build: 34, date: "14.10.2026", items: [
            ("bolt", String(localized: "Deutlich flüssiger: der Chat lädt nur noch, was sich geändert hat, und reagiert sofort auf Antworten")),
            ("mic", String(localized: "Während des Diktierens pausiert der Chat, damit die Spracherkennung die volle Leistung hat")),
            ("moon.zzz", String(localized: "Ein schlafender Rechner bremst die anderen Server nicht mehr aus")),
        ]),
        ReleaseNote(build: 33, date: "14.10.2026", items: [
            ("folder", String(localized: "Neuer Space: Ordner auf dem Server durchsuchen – Projekte und Git-Repos auf einen Blick")),
        ]),
        ReleaseNote(build: 32, date: "14.10.2026", items: [
            ("questionmark.bubble", String(localized: "Fragen von omp: keine doppelte Terminal-Ansicht mehr über der Frage, dazu „Eigene Antwort“")),
        ]),
        ReleaseNote(build: 31, date: "14.10.2026", items: [
            ("keyboard", String(localized: "Koppeln per Einmalcode: Code vom Rechner eintippen oder einsetzen – ideal von unterwegs über Tailscale")),
        ]),
        ReleaseNote(build: 30, date: "14.10.2026", items: [
            ("globe", String(localized: "Fernzugriff über Tailscale: den Rechner auch von unterwegs erreichen – ohne offene Ports")),
            ("wifi", String(localized: "Verbindungsart pro Server: Lokales Netzwerk oder Tailscale, jederzeit umstellbar – mit Status „verbunden über …“")),
            ("checkmark.shield", String(localized: "Sicherer koppeln: der Rechner fragt nach, bevor ein gescannter Code ein Gerät freischaltet")),
        ]),
        ReleaseNote(build: 29, date: "14.10.2026", items: [
            ("waveform", String(localized: "Live-Sprache jetzt auch mit Macs als Server (einmalig BlackHole installieren, siehe Server-Info)")),
            ("arrow.clockwise", String(localized: "Nutzungslimits laden beim Öffnen frisch und lassen sich jederzeit neu laden")),
        ]),
        ReleaseNote(build: 28, date: "14.10.2026", items: [
            ("clock", String(localized: "Nutzungslimits: Reset auf die Minute genau (z. B. „in 4 Std., 23 Min.“)")),
        ]),
        ReleaseNote(build: 27, date: "14.10.2026", items: [
            ("chart.xyaxis.line", String(localized: "Verlauf & Statistik (Beta): Nutzungslimits über die Zeit, Verbrauch pro Tag und Agent-Zeit pro Maschine")),
            ("checkmark.circle", String(localized: "Nutzungslimits ohne doppelte Einträge")),
        ]),
        ReleaseNote(build: 26, date: "14.10.2026", items: [
            ("bolt.horizontal", String(localized: "Echtzeit: Neue Workspaces, Tabs und Agent-Status erscheinen sofort – ohne ständiges Nachladen")),
        ]),
        ReleaseNote(build: 25, date: "14.10.2026", items: [
            ("server.rack", String(localized: "Server & Geräte: jede Maschine mit eigener Seite – Auslastung, Probleme, Updates auf einen Blick")),
            ("arrow.down.circle", String(localized: "Werkzeuge: alles Fehlende und Veraltete mit einem Tipp installieren")),
            ("laptopcomputer", String(localized: "Macs als Server: Werkzeuge, Server-Info und Ports funktionieren jetzt auch dort")),
        ]),
        ReleaseNote(build: 24, date: "14.10.2026", items: [
            ("terminal", String(localized: "Server einrichten jetzt mit einem einzigen Befehl – ohne Extras")),
        ]),
        ReleaseNote(build: 23, date: "14.10.2026", items: [
            ("lock.open", String(localized: "Hollr ist Open Source (MIT) – github.com/sensedrive/hollr")),
            ("qrcode", String(localized: "Server einrichten mit einem curl-Befehl – kein GitHub-Login mehr nötig")),
            ("desktopcomputer", String(localized: "Desktop-App für Linux und Mac mit Live-Sprache und Git-Ansichten")),
        ]),
        ReleaseNote(build: 21, date: "14.10.2026", items: [
            ("globe", String(localized: "Hollr spricht jetzt Deutsch und Englisch")),
            ("rectangle.dashed", String(localized: "Skeletons statt Lade-Kreisel")),
            ("macbook", String(localized: "Hollr für den Mac (DMG) – koppeln per Link aus hollr pair --link")),
        ]),
        ReleaseNote(build: 20, date: "14.10.2026", items: [
            ("cpu", String(localized: "Modell und Thinking/Effort gleich beim Start einer Sitzung wählen – mit Suche und zuletzt genutzten Modellen")),
            ("arrow.left.arrow.right", String(localized: "Modell schnell wechseln: Statuszeile antippen oder ⋯ → Modell wechseln (omp nur für die Sitzung)")),
        ]),
        ReleaseNote(build: 18, date: "14.10.2026", items: [
            ("shippingbox", String(localized: "Werkzeuge zeigen die Zielversion, „Aktuell“ und ein ein-/ausklappbares Protokoll")),
            ("xmark.bin", String(localized: "Space schließen mit allen Optionen: nur schließen, Worktree entfernen, Worktree und Branch löschen (auch auf origin), Ordner löschen – vorher siehst du offene Änderungen und nicht gepushte Commits")),
        ]),
        ReleaseNote(build: 17, date: "14.10.2026", items: [
            ("gauge.with.dots.needle.67percent", String(localized: "Server-Info: Auslastung, Prozesse und ob der Server korrekt eingerichtet ist")),
            ("faceid", String(localized: "Optional mit Face ID sperren")),
            ("sparkles", "Neuigkeiten in den Einstellungen"),
            ("paintpalette", String(localized: "Designs: Dracula, Nord, Solarized, Gruvbox, Catppuccin, GitHub und mehr – hell, dunkel oder automatisch")),
            ("doc.on.doc", String(localized: "Server koppeln: kopierbare Befehle für Linux und macOS")),
        ]),
        ReleaseNote(build: 16, date: "14.10.2026", items: [
            ("waveform", String(localized: "Live klappt jetzt schon beim ersten Anruf")),
            ("speaker.slash", String(localized: "Ton aus: Antwort stummschalten, ohne aufzulegen")),
            ("mic.slash", String(localized: "Mikro aus lässt die Antwort weiterlaufen")),
            ("arrow.left.and.right", String(localized: "Verlauf lässt sich seitlich scrollen")),
        ]),
        ReleaseNote(build: 15, date: "14.10.2026", items: [
            ("arrow.triangle.branch", String(localized: "Git: Dateien, Änderungen mit Diff, Verlauf-Graph, Branches mit PR-Status")),
            ("shippingbox", String(localized: "herdr, omp, Claude Code, Codex und Hollr direkt aus der App installieren und aktualisieren")),
            ("key", String(localized: "Push-Schlüssel einmal in der App importieren – alle Server werden automatisch eingerichtet")),
        ]),
        ReleaseNote(build: 14, date: "14.10.2026", items: [
            ("bell.badge", String(localized: "Push-Mitteilungen, wenn ein Agent wartet, fertig ist oder einen Fehler hat")),
            ("terminal", String(localized: "Terminals starten – auch ohne Projekt im Home-Verzeichnis")),
            ("square.grid.2x2", String(localized: "Übersicht zeigt deine Sitzungen, gruppiert nach Maschine")),
        ]),
        ReleaseNote(build: 13, date: "14.10.2026", items: [
            ("globe", String(localized: "Browser zeigt auch localhost-Seiten des Servers – über SSH, ohne Zusatzdienst")),
        ]),
        ReleaseNote(build: 12, date: "14.10.2026", items: [
            ("safari", String(localized: "Eingebauter Browser; Links fragen: Hollr-Browser oder Safari")),
        ]),
        ReleaseNote(build: 11, date: "13.10.2026", items: [
            ("text.alignleft", String(localized: "Verlauf wie omps Terminal – ruhiger, kompakter")),
            ("rectangle.expand.vertical", String(localized: "Zen-Modus: nur Chat und durchsichtige Eingabe")),
        ]),
        ReleaseNote(build: 10, date: "13.10.2026", items: [
            ("keyboard.chevron.compact.down", String(localized: "Tastatur schließen, schließt nach dem Senden von selbst")),
            ("textformat.size", String(localized: "Ganze App skalieren – auch per Zwei-Finger-Geste")),
        ]),
        ReleaseNote(build: 9, date: "13.10.2026", items: [
            ("square.stack.3d.up", String(localized: "Spaces: Repos und Worktrees, Git-Verlauf und Dateien; Spaces anlegen und löschen")),
            ("chart.bar", String(localized: "Nutzungslimits von Claude und ChatGPT")),
        ]),
        ReleaseNote(build: 1, date: "Oktober 2026", items: [
            ("qrcode", String(localized: "Server per QR-Code koppeln – nur SSH, kein Zusatzdienst")),
            ("waveform.circle", String(localized: "omp /live vom iPhone: echtes Gespräch mit deinen Agents auf dem Server")),
            ("mic", String(localized: "Lokale Spracheingabe mit Parakeet, Whisper und Apple – mehrsprachig, mit Fachwörtern")),
            ("bubble.left.and.text.bubble.right", String(localized: "omp, Claude Code und Codex öffnen, lesen, schreiben und schließen")),
        ]),
    ]

    static var currentBuild: Int {
        Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "") ?? 0
    }

    private static let seenKey = "releaseNotes.seenBuild"
    static var hasUnseen: Bool { UserDefaults.standard.integer(forKey: seenKey) < (all.first?.build ?? 0) }
    static func markSeen() { UserDefaults.standard.set(all.first?.build ?? 0, forKey: seenKey) }
}

struct ReleaseNotesView: View {
    var body: some View {
        List {
            Group {
            ForEach(ReleaseNotes.all) { note in
                Section {
                    ForEach(Array(note.items.enumerated()), id: \.offset) { _, item in
                        Label {
                            Text(item.text)
                        } icon: {
                            Image(systemName: item.icon).foregroundStyle(Theme.accent)
                        }
                    }
                } header: {
                    HStack {
                        Text(note.build == 1 ? "Anfang" : "Build \(note.build)")
                        if note.build == ReleaseNotes.currentBuild {
                            Text("installiert").font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Theme.accent.opacity(0.25), in: Capsule())
                        }
                        Spacer()
                        Text(note.date)
                    }
                }
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .navigationTitle("Neuigkeiten")
        .onAppear { ReleaseNotes.markSeen() }
    }
}
