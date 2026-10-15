import SwiftUI

/// Saved prompts ("Mach einen PR", "Tests laufen lassen …") – chips above the keyboard, edited in Settings.
@MainActor
@Observable
final class PromptSnippets {
    static let defaults = [
        String(localized: "Lass die Tests laufen und behebe, was rot ist."),
        String(localized: "Fasse kurz zusammen, was du gemacht hast."),
        String(localized: "Committe mit einer sinnvollen Nachricht und öffne einen PR."),
        String(localized: "Erkläre mir den Plan, bevor du anfängst."),
        String(localized: "Mach weiter."),
    ]

    var items: [String] {
        didSet { UserDefaults.standard.set(items, forKey: "prompts.snippets") }
    }

    init() {
        items = UserDefaults.standard.stringArray(forKey: "prompts.snippets") ?? Self.defaults
    }

    /// Chip title: the first words.
    static func title(_ prompt: String) -> String {
        let words = prompt.split(separator: " ")
        return words.count > 4 ? words.prefix(4).joined(separator: " ") + " …" : prompt
    }
}

/// "@" right before the cursor: the fragment typed after it (pure, tested).
enum Mention {
    static func find(in text: String, cursor: Int?) -> (range: Range<String.Index>, query: String)? {
        let end = cursor.map { text.index(text.startIndex, offsetBy: min(max($0, 0), text.count)) } ?? text.endIndex
        let head = text[..<end]
        guard let at = head.lastIndex(of: "@") else { return nil }
        // "@" starts a word (not an e-mail address) and nothing but path characters follow
        if at > head.startIndex {
            let before = head[head.index(before: at)]
            guard before.isWhitespace || before == "(" else { return nil }
        }
        let query = String(head[head.index(after: at)...])
        guard query.count <= 80, query.allSatisfy({ $0.isLetter || $0.isNumber || "._-/".contains($0) }) else { return nil }
        return (at..<end, query)
    }

    /// Replaces "@frag" with "@path " and returns the new text and cursor.
    static func insert(_ path: String, into text: String, cursor: Int?) -> (text: String, cursor: Int)? {
        guard let m = find(in: text, cursor: cursor) else { return nil }
        var out = text
        let replacement = "@\(path) "
        let start = text.distance(from: text.startIndex, to: m.range.lowerBound)
        out.replaceSubrange(m.range, with: replacement)
        return (out, start + replacement.count)
    }
}

struct SnippetChips: View {
    @Environment(PromptSnippets.self) private var snippets
    let pick: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(snippets.items, id: \.self) { prompt in
                    Button { pick(prompt) } label: {
                        Text(PromptSnippets.title(prompt))
                            .font(.footnote)
                            .lineLimit(1)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Theme.fg.opacity(0.08), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(prompt)
                }
            }
        }
        .scrollClipDisabled()
    }
}

/// Repo files matching what was typed after "@" (server: `fs files`, tracked + untracked).
struct MentionSuggestions: View {
    let ref: AgentRef
    let query: String
    let pick: (String) -> Void
    @State private var files: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(files.prefix(5), id: \.self) { file in
                Button { pick(file) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "doc.text").font(.caption).foregroundStyle(.secondary)
                        Text((file as NSString).lastPathComponent).font(.subheadline.weight(.medium))
                        Text((file as NSString).deletingLastPathComponent).font(.caption).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.head)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 7)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .task(id: query) {
            try? await Task.sleep(for: .milliseconds(180)) // typing
            guard !Task.isCancelled else { return }
            struct R: Decodable { let files: [String] }
            let ws = ref.pane.pane.split(separator: ":").first.map(String.init) ?? ""
            if let r = try? await HollrClient.fs(ref.server, ["op": "files", "ws": ws, "query": query, "limit": 8], as: R.self) {
                files = r.files
            }
        }
    }
}

/// Settings → Prompt-Bausteine
struct SnippetSettingsView: View {
    @Environment(PromptSnippets.self) private var snippets
    @State private var newPrompt = ""

    var body: some View {
        @Bindable var snippets = snippets
        List {
            Section {
                // by position: keyed by text, every keystroke would rebuild the row and drop the focus
                ForEach(snippets.items.indices, id: \.self) { i in
                    TextField("Prompt", text: Binding(
                        get: { i < snippets.items.count ? snippets.items[i] : "" },
                        set: { if i < snippets.items.count { snippets.items[i] = $0 } }
                    ), axis: .vertical)
                }
                .onDelete { snippets.items.remove(atOffsets: $0) }
                .onMove { snippets.items.move(fromOffsets: $0, toOffset: $1) }
                HStack {
                    TextField("Neuer Baustein …", text: $newPrompt, axis: .vertical)
                    Button("Hinzufügen") {
                        let p = newPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !p.isEmpty else { return }
                        snippets.items.append(p)
                        newPrompt = ""
                    }
                    .disabled(newPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } footer: {
                Text("Erscheinen beim Schreiben über der Tastatur – ein Tipp fügt den Text ein. Tipp: „@“ im Eingabefeld schlägt Dateien aus dem Repo vor.")
            }
            Section {
                Button("Standardbausteine wiederherstellen") { snippets.items = PromptSnippets.defaults }
            }
        }
        .navigationTitle("Prompt-Bausteine")
        .toolbar { EditButton() }
        .themedPage()
    }
}
