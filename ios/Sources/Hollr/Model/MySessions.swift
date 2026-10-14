import Foundation
import Observation

/// The sessions you opened or started in Hollr (not everything herdr runs).
/// Shown on the dashboard, grouped by machine; stored on the phone.
@Observable
final class MySessions {
    private static let key = "mySessions"
    /// "serverUUID|pane", most recently used first
    private(set) var ids: [String]

    init() {
        ids = UserDefaults.standard.stringArray(forKey: Self.key) ?? []
    }

    func touch(_ id: String) {
        guard ids.first != id else { return }
        ids.removeAll { $0 == id }
        ids.insert(id, at: 0)
        save()
    }

    func remove(_ id: String) {
        ids.removeAll { $0 == id }
        save()
    }

    /// Drops sessions whose pane is gone on a server we just loaded successfully.
    func prune(alive: Set<String>, loadedServers: Set<UUID>) {
        let before = ids.count
        ids.removeAll { id in
            guard let server = id.split(separator: "|").first.flatMap({ UUID(uuidString: String($0)) }) else { return true }
            return loadedServers.contains(server) && !alive.contains(id)
        }
        if ids.count != before { save() }
    }

    private func save() {
        UserDefaults.standard.set(ids, forKey: Self.key)
    }
}
