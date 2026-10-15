import Foundation
import Observation

/// Unsent text of one chat's composer. Lives outside the view, so zen mode, a new layout,
/// switching chats or a restart of the app don't throw it away.
@MainActor
@Observable
final class Draft {
    let key: String
    var text: String { didSet { if text != oldValue { store?.changed(self) } } }
    /// cursor position in `text` (characters, nil = end)
    var cursor: Int?
    /// dictation running for this chat: the text around the cursor when it started
    var beforeDictation = ""
    var afterDictation = ""
    var updatedAt: Date
    fileprivate weak var store: DraftStore?

    fileprivate init(key: String, text: String, updatedAt: Date = .now) {
        self.key = key
        self.text = text
        self.updatedAt = updatedAt
    }

    /// After a successful send.
    func clear() {
        text = ""
        cursor = nil
        beforeDictation = ""
        afterDictation = ""
    }
}

/// All drafts, saved to Application Support/drafts.json shortly after every change.
@MainActor
@Observable
final class DraftStore {
    /// Drafts not touched for this long are dropped (herdr reuses pane ids for new chats).
    static let maxAge: TimeInterval = 14 * 86_400

    @ObservationIgnored private var drafts: [String: Draft] = [:]
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private let url: URL?

    /// `url: nil` keeps drafts in memory only (tests, previews).
    init(url: URL? = DraftStore.defaultURL, now: Date = .now) {
        self.url = url
        guard let url, let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode([String: Saved].self, from: data) else { return }
        for (key, entry) in saved where !entry.text.isEmpty && now.timeIntervalSince(entry.at) < Self.maxAge {
            let draft = Draft(key: key, text: entry.text, updatedAt: entry.at)
            draft.store = self
            drafts[key] = draft
        }
    }

    nonisolated static var defaultURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("drafts.json")
    }

    /// One draft per server, pane and workspace – a pane id that herdr hands out again for a chat
    /// in another workspace doesn't inherit the text.
    static func key(for ref: AgentRef) -> String {
        "\(ref.server.id.uuidString)|\(ref.pane.pane)|\(ref.workspace)"
    }

    func draft(for ref: AgentRef) -> Draft { draft(key: Self.key(for: ref)) }

    func draft(key: String) -> Draft {
        if let d = drafts[key] { return d }
        let d = Draft(key: key, text: "")
        d.store = self
        drafts[key] = d
        return d
    }

    /// Text of a chat's draft without creating one (for list badges).
    func text(for ref: AgentRef) -> String { drafts[Self.key(for: ref)]?.text ?? "" }

    fileprivate func changed(_ draft: Draft) {
        draft.updatedAt = .now
        scheduleSave()
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            self?.save()
        }
    }

    /// Writes right away (app goes to the background).
    func save() {
        saveTask?.cancel()
        guard let url else { return }
        let entries = drafts.compactMapValues { d -> Saved? in d.text.isEmpty ? nil : Saved(text: d.text, at: d.updatedAt) }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(entries).write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            HollrLog.error("drafts save: \(error)")
        }
    }

    private struct Saved: Codable {
        let text: String
        let at: Date
    }
}
