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
    /// lan / tailscale / auto – nil for servers paired before connection types existed
    var network: NetworkMode?
    /// ms – when this record last changed (paired, renamed, new addresses): the newest version of a machine wins
    /// across the user's apps (MachinesSync). Records from before have none; ServerStore sets 1 once.
    var updatedAt: Double?

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

extension Array where Element == Workspace {
    /// Each workspace, tab and pane once (first wins). herdr shouldn't repeat one, but a List that gets the same id
    /// twice crashes the app (UICollectionView "invalid number of items") – so the lists never see it.
    var uniqued: [Workspace] {
        var workspaces = Set<String>()
        var tabs = Set<String>()
        var panes = Set<String>()
        var clean = true
        for ws in self {
            clean = clean && workspaces.insert(ws.id).inserted
            for tab in ws.tabs {
                clean = clean && tabs.insert(tab.id).inserted
                for pane in tab.panes { clean = clean && panes.insert(pane.pane).inserted }
            }
        }
        guard !clean else { return self }
        workspaces = []
        tabs = []
        panes = []
        return compactMap { ws -> Workspace? in
            guard workspaces.insert(ws.id).inserted else { return nil }
            let kept: [Tab] = ws.tabs.compactMap { tab -> Tab? in
                guard tabs.insert(tab.id).inserted else { return nil }
                let own: [Pane] = tab.panes.filter { panes.insert($0.pane).inserted }
                return Tab(id: tab.id, label: tab.label, number: tab.number, focused: tab.focused, panes: own)
            }
            return Workspace(id: ws.id, label: ws.label, number: ws.number, focused: ws.focused, status: ws.status, tabs: kept)
        }
    }
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
    /// server time (ms) the pane entered its current status – seen / dismissed results are keyed with it, the same
    /// on every device (SharedState). Older servers don't send it: then HerdrStore stamps it locally.
    var since: Double? = nil

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
    /// herdr tab id (the dragged tab order is kept by it)
    var tabId: String = ""

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
    /// servers removed here, kept 90 days so the removal reaches the user's other apps (MachinesSync)
    private(set) var tombstones: [Machine] = []
    /// any change by the user or the sync – the other apps should learn it soon (MachinesSync.poke)
    @ObservationIgnored var onChange: (() -> Void)?
    private let url: URL
    private let tombstonesURL: URL
    /// debug screenshot demo: made-up servers in memory only, never saved
    private var demo = false

    private static let tombstoneDays = 90.0

    static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    init(directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        url = directory.appendingPathComponent("servers.json")
        tombstonesURL = directory.appendingPathComponent("servers-removed.json")
        #if DEBUG
        if DemoMode.isOn {
            servers = DemoMode.servers
            demo = true
            return
        }
        #endif
        if let data = try? Data(contentsOf: url),
           let saved = try? JSONDecoder().decode([Server].self, from: data) {
            servers = saved
        }
        // paired before machines were shared: older than anything another app did (a removal there wins)
        if servers.contains(where: { $0.updatedAt == nil }) {
            servers = servers.map { server in
                var server = server
                if server.updatedAt == nil { server.updatedAt = 1 }
                return server
            }
            save()
        }
        if let data = try? Data(contentsOf: tombstonesURL),
           let saved = try? JSONDecoder().decode([Machine].self, from: data) {
            let oldest = Self.nowMs - Self.tombstoneDays * 86_400_000
            tombstones = saved.filter { $0.updatedAt > oldest }
        }
    }

    /// Paired (by hand, or by the sync – which brings the machine's own `updatedAt`).
    func add(_ server: Server) {
        var server = server
        if server.updatedAt == nil { server.updatedAt = Self.nowMs }
        // paired again: the old entry's pooled connection (and its tunnels) must not live on
        for old in servers where old.hostFingerprint == server.hostFingerprint && old.user == server.user {
            Task { await SSHPool.shared.invalidate(old) }
        }
        servers.removeAll { $0.hostFingerprint == server.hostFingerprint && $0.user == server.user }
        servers.append(server)
        tombstones.removeAll { $0.fp == server.hostFingerprint }
        save()
        onChange?()
    }

    /// Removed here – and, through the tombstone, in the user's other apps. `at`: when (the sync passes the time of
    /// a removal it learned from another app).
    func remove(_ server: Server, at: Double? = nil) {
        servers.removeAll { $0.id == server.id }
        var gone = Machine(server: server)
        gone.removed = true
        gone.updatedAt = at ?? Self.nowMs
        tombstones.removeAll { $0.fp == server.hostFingerprint }
        tombstones.append(gone)
        save()
        onChange?()
        Task { await SSHPool.shared.invalidate(server) }
    }

    /// Connection type changed (addresses re-ordered or extended – same server, same key).
    func setNetwork(_ server: Server, mode: NetworkMode, addresses: [String]) {
        guard let i = servers.firstIndex(where: { $0.id == server.id }), !addresses.isEmpty else { return }
        servers[i].network = mode
        if servers[i].addresses != addresses { servers[i].updatedAt = Self.nowMs }
        servers[i].addresses = addresses
        save()
        onChange?()
    }

    func rename(_ server: Server, to label: String) {
        guard let i = servers.firstIndex(where: { $0.id == server.id }), servers[i].label != label else { return }
        servers[i].label = label
        servers[i].updatedAt = Self.nowMs
        save()
        onChange?()
    }

    private func save() {
        guard !demo else { return }
        if let data = try? JSONEncoder().encode(servers) {
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        if let data = try? JSONEncoder().encode(tombstones) {
            try? data.write(to: tombstonesURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
}
