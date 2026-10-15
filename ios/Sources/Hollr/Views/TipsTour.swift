import SwiftUI

/// "Neu in Hollr": after an update, swipe through what's new and where it hides (long-press,
/// swipe, right-click …). Again any time under Settings › Tipps & Tricks.
struct Tip: Identifiable {
    let id: String
    let icon: String
    let title: String
    let text: String
    /// first build that has it – the tour after an update starts with the new ones
    let since: Int
}

enum Tips {
    /// raise when the tour has new pages: it shows once more after the update
    static let version = 41

    static let all: [Tip] = [
        Tip(id: "inbox", icon: "tray.full", title: String(localized: "Braucht dich"),
            text: String(localized: "Oben auf der Startseite: Fragen von omp mit einem Tipp beantworten, wartenden oder fertigen Agents direkt antworten."), since: 38),
        Tip(id: "notify", icon: "bell.badge", title: String(localized: "Aus der Mitteilung antworten"),
            text: String(localized: "Mitteilung lange drücken: ein Knopf pro Antwort-Option oder eine eigene Antwort – ohne die App zu öffnen."), since: 38),
        Tip(id: "activity", icon: "platter.filled.bottom.iphone", title: String(localized: "Live-Aktivität"),
            text: String(localized: "Arbeitet ein Agent länger, steht er auf dem Sperrbildschirm und in der Dynamic Island – orange, wenn er auf dich wartet."), since: 38),
        Tip(id: "terminal", icon: "apple.terminal", title: String(localized: "Terminal"),
            text: String(localized: "Chat-Menü › Terminal: „Session“ zeigt das Terminal am Rechner, „Eigene Shell“ ein eigenes im selben Ordner – passend zum iPhone. iPhone quer: Terminal oder Änderungen neben dem Chat."), since: 41),
        Tip(id: "snippets", icon: "text.badge.plus", title: String(localized: "Bausteine und @"),
            text: String(localized: "Beim Schreiben erscheinen deine Prompt-Bausteine über der Tastatur. „@“ schlägt Dateien aus dem Repo vor."), since: 39),
        Tip(id: "attach", icon: "paperclip", title: String(localized: "Anhänge und Teilen"),
            text: String(localized: "Büroklammer im Eingabefeld für Fotos und Dateien. Aus Safari, Mail oder Fotos: Teilen › Hollr."), since: 39),
        Tip(id: "review", icon: "checkmark.circle", title: String(localized: "Änderungen prüfen"),
            text: String(localized: "Git › Änderungen: nach rechts wischen zum Stagen, nach links zum Verwerfen oder Kommentieren. Unten: Commit, Push, PR."), since: 39),
        Tip(id: "widgets", icon: "square.grid.2x2", title: String(localized: "Widgets und Siri"),
            text: String(localized: "Widgets „Agents“ und „Limits“ für Home- und Sperrbildschirm. „Frag … in Hollr“ und „Live starten“ auch auf der Action-Taste."), since: 39),
        Tip(id: "setup", icon: "checklist", title: String(localized: "Einrichtung prüfen"),
            text: String(localized: "Einstellungen › Server & Geräte › Server: was noch fehlt, mit „Installieren“, „Neu starten“ oder „Push einrichten“."), since: 40),
        Tip(id: "dictate", icon: "mic", title: String(localized: "Diktieren"),
            text: String(localized: "Mikrofon antippen startet und beendet – oder gedrückt halten und sprechen. „… senden“ am Ende schickt ab."), since: 35),
        Tip(id: "zen", icon: "arrow.up.left.and.arrow.down.right", title: String(localized: "Zen-Modus"),
            text: String(localized: "Nur Verlauf und Eingabe – dein Entwurf bleibt beim Umschalten erhalten."), since: 36),
        Tip(id: "mac", icon: "rectangle.split.2x1", title: String(localized: "Auf dem Mac"),
            text: String(localized: "Agents in der Seitenleiste; Rechtsklick › „Rechts daneben öffnen“ zeigt zwei Chats nebeneinander."), since: 39),
    ]

    private static let seenKey = "tour.seenVersion"

    /// Tips for the tour after an update (new ones first), or nil when there is nothing to show.
    static func pending() -> [Tip]? {
        let seen = UserDefaults.standard.integer(forKey: seenKey)
        guard seen < version else { return nil }
        let fresh = all.filter { $0.since > seen }
        return seen == 0 ? all : fresh + all.filter { $0.since <= seen }
    }

    static func markSeen() { UserDefaults.standard.set(version, forKey: seenKey) }
}

struct TipsTour: View {
    let tips: [Tip]
    var onDone: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @State private var page = 0

    var body: some View {
        VStack(spacing: 18) {
            HStack {
                Text("Neu und praktisch").font(.headline)
                Spacer()
                Button("Fertig") { close() }.bold()
            }
            .padding(.horizontal, 20).padding(.top, 18)
            TabView(selection: $page) {
                ForEach(Array(tips.enumerated()), id: \.element.id) { index, tip in
                    VStack(spacing: 18) {
                        Spacer(minLength: 0)
                        Image(systemName: tip.icon)
                            .font(.system(size: 54, weight: .semibold))
                            .foregroundStyle(Theme.accent)
                            .frame(width: 110, height: 110)
                            .background(Theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 30, style: .continuous))
                        Text(tip.title).font(.title2.bold()).multilineTextAlignment(.center)
                        Text(tip.text).font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            .padding(.horizontal, 28)
                        Spacer(minLength: 0)
                    }
                    .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .always))
            Button {
                if page < tips.count - 1 { withAnimation { page += 1 } } else { close() }
            } label: {
                Text(page < tips.count - 1 ? String(localized: "Weiter") : String(localized: "Los geht’s"))
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 20).padding(.bottom, 20)
        }
        .themedPage()
    }

    private func close() {
        Tips.markSeen()
        onDone()
        dismiss()
    }
}
