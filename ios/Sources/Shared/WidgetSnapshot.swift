import Foundation

/// What the widgets and Siri know: the app writes it whenever herdr or the usage limits change
/// (shared keychain – the widgets can't open SSH connections themselves).
struct WidgetSnapshot: Codable, Equatable {
    struct Agent: Codable, Equatable, Identifiable, Hashable {
        /// "<server uuid>|<pane>" – same as AgentRef.id
        var id: String
        var fp: String
        var pane: String
        var server: String
        var title: String
        var agent: String
        /// herdr: working | blocked | idle | done
        var status: String
    }

    struct Limit: Codable, Equatable, Identifiable, Hashable {
        var provider: String
        var window: String
        /// 0…1
        var used: Double
        var resetsAt: Double?
        var id: String { "\(provider)|\(window)" }
    }

    var agents: [Agent] = []
    var limits: [Limit] = []
    var updated: Date = .distantPast

    static func load() -> WidgetSnapshot {
        guard let data = SharedKeychain.load("widget-snapshot"),
              let snap = try? JSONDecoder().decode(WidgetSnapshot.self, from: data) else { return WidgetSnapshot() }
        return snap
    }

    /// true when something changed (then the widgets are reloaded)
    @discardableResult
    func save() -> Bool {
        var old = Self.load()
        old.updated = updated
        guard old != self, let data = try? JSONEncoder().encode(self) else { return false }
        return SharedKeychain.save("widget-snapshot", data)
    }

    /// Ordered for display: waiting first, then working, then the rest.
    var ranked: [Agent] {
        let rank = ["blocked": 0, "working": 1, "done": 2]
        return agents.sorted { (rank[$0.status] ?? 3, $0.title) < (rank[$1.status] ?? 3, $1.title) }
    }

    var waiting: Int { agents.filter { $0.status == "blocked" }.count }
    var working: Int { agents.filter { $0.status == "working" }.count }
}
