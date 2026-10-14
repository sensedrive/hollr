import Foundation
import Observation

/// A paired herdr server.
struct Server: Codable, Identifiable, Hashable {
    var id: UUID = UUID()
    var label: String
    var user: String
    var addresses: [String]
    var port: Int
    var hostFingerprint: String
    /// Device id assigned by the server (for `hollr revoke`)
    var deviceId: String
    var pairedAt: Date = Date()

    static let placeholder = Server(label: "", user: "", addresses: [], port: 22, hostFingerprint: "", deviceId: "")

    var displayAddress: String { "\(user)@\(addresses.first ?? "?")" }
}

/// herdr structure as reported by `hollr gate tree`: workspaces → tabs → panes.
struct Workspace: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let number: Int
    let focused: Bool
    let status: String
    let tabs: [Tab]
}

struct Tab: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let number: Int
    let focused: Bool
    let panes: [Pane]
}

struct Pane: Codable, Identifiable, Hashable {
    let pane: String
    /// omp, claude, codex, … – nil for a plain shell
    let agent: String?
    let status: String
    let title: String
    let cwd: String
    let focused: Bool
    /// omp panes support /live
    let live: Bool

    var id: String { pane }
    var folder: String { cwd.split(separator: "/").last.map(String.init) ?? cwd }
    var agentName: String {
        switch agent {
        case "omp": return "omp"
        case "claude": return "Claude"
        case "codex": return "Codex"
        case nil: return "Shell"
        case let other?: return other
        }
    }
}

/// One agent pane on one server, with the herdr names around it (like a row in herdr's sidebar).
struct AgentRef: Hashable, Identifiable {
    let server: Server
    let workspace: String
    let workspaceNumber: Int
    let tab: String
    let tabNumber: Int
    let pane: Pane

    var id: String { "\(server.id.uuidString)|\(pane.pane)" }

    /// herdr tab names like "1" carry no meaning – then the workspace name is the better title.
    var place: String {
        let t = tab.trimmingCharacters(in: .whitespaces)
        return t.isEmpty || Int(t) != nil ? workspace : "\(workspace) · \(t)"
    }

    var title: String {
        let t = tab.trimmingCharacters(in: .whitespaces)
        return t.isEmpty || Int(t) != nil ? workspace : t
    }

    /// Heeler-style ordering: needs-you first, then busy, then the rest.
    var statusRank: Int {
        switch pane.status {
        case "blocked": return 0
        case "done": return 1
        case "working": return 2
        case "idle": return 3
        default: return pane.agent == nil ? 5 : 4
        }
    }
}

@MainActor
@Observable
final class ServerStore {
    private(set) var servers: [Server] = []
    private let url: URL

    init(directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        url = directory.appendingPathComponent("servers.json")
        if let data = try? Data(contentsOf: url),
           let saved = try? JSONDecoder().decode([Server].self, from: data) {
            servers = saved
        }
    }

    func add(_ server: Server) {
        servers.removeAll { $0.hostFingerprint == server.hostFingerprint && $0.user == server.user }
        servers.append(server)
        save()
    }

    func remove(_ server: Server) {
        servers.removeAll { $0.id == server.id }
        save()
    }

    func rename(_ server: Server, to label: String) {
        guard let i = servers.firstIndex(where: { $0.id == server.id }) else { return }
        servers[i].label = label
        save()
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(servers) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
