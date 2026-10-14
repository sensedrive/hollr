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
