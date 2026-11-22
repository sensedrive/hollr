import Foundation

/// The sessions you opened or started in Hollr (not everything herdr runs), shown on the dashboard. Kept on each
/// server (`SharedState.mySessions`, panes newest first) so the desktop app shows the same; the server forgets
/// panes that are gone.
enum MySessions {
    /// longest list sent to the server
    static let max = 60

    /// the list with `pane` in front
    static func touching(_ panes: [String], _ pane: String) -> [String] {
        guard panes.first != pane else { return panes }
        return Array(([pane] + panes.filter { $0 != pane }).prefix(max))
    }

    // MARK: the list this phone kept itself before it moved to the servers

    /// "serverUUID|pane", most recently used first
    private static let legacyKey = "mySessions"

    private static var legacyIds: [String] { UserDefaults.standard.stringArray(forKey: legacyKey) ?? [] }

    /// the panes this phone listed for `server`
    static func legacy(for server: UUID) -> [String] {
        let prefix = "\(server.uuidString)|"
        return legacyIds.filter { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) }
    }

    /// Migration done for `server`: its entries go, and those of servers no longer paired (when `paired` is known);
    /// the key goes with the last entry.
    static func forgetLegacy(of server: UUID, paired: Set<UUID>) {
        let ids = legacyIds
        guard !ids.isEmpty else { return }
        let rest = ids.filter { id in
            guard let owner = id.split(separator: "|").first.flatMap({ UUID(uuidString: String($0)) }) else { return false }
            return owner != server && (paired.isEmpty || paired.contains(owner))
        }
        guard rest.count != ids.count else { return }
        if rest.isEmpty {
            UserDefaults.standard.removeObject(forKey: legacyKey)
        } else {
            UserDefaults.standard.set(rest, forKey: legacyKey)
        }
    }
}
