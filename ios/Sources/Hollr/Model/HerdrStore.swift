import Foundation
import Observation

/// Live view of herdr on all paired servers (refreshed while the app is in the foreground).
@MainActor
@Observable
final class HerdrStore {
    private(set) var trees: [UUID: [Workspace]] = [:]
    private(set) var errors: [UUID: String] = [:]
    private(set) var loaded = false
    private(set) var spaces: [UUID: [Space]] = [:]
    private(set) var usage: [UUID: [UsageLimit]] = [:]
    private(set) var capacity: [UUID: [UsageCapacity]] = [:]
    private var usageFetchedAt: [UUID: Date] = [:]

    func refreshSpaces(_ servers: [Server]) async {
        for server in servers {
            if let list = try? await HollrClient.spaces(server) { spaces[server.id] = list }
        }
    }

    func refreshUsage(_ servers: [Server], force: Bool = false) async {
        for server in servers {
            if !force, let at = usageFetchedAt[server.id], Date().timeIntervalSince(at) < 110 { continue }
            if let result = try? await HollrClient.usage(server, refresh: force) {
                usage[server.id] = result.limits
                capacity[server.id] = result.capacity
                usageFetchedAt[server.id] = Date()
            }
        }
    }

    /// Agents that are doing something right now (or need you) – for the dashboard.
    func activeAgents(_ servers: [Server], live: Set<String>) -> [AgentRef] {
        allAgents(servers).filter { $0.pane.status == "working" || $0.pane.status == "blocked" || live.contains($0.id) }
    }

    func refresh(_ servers: [Server]) async {
        await withTaskGroup(of: (UUID, Result<[Workspace], Error>).self) { group in
            for server in servers {
                group.addTask { (server.id, await Result(asyncCatching: { try await HollrClient.tree(server) })) }
            }
            for await (id, result) in group {
                switch result {
                case .success(let tree):
                    trees[id] = tree
                    errors[id] = nil
                case .failure(let error):
                    errors[id] = error.localizedDescription
                    if let server = servers.first(where: { $0.id == id }) { await SSHPool.shared.invalidate(server) }
                }
            }
        }
        let ids = Set(servers.map(\.id))
        trees = trees.filter { ids.contains($0.key) }
        loaded = true
    }

    func agents(on server: Server) -> [AgentRef] {
        (trees[server.id] ?? []).flatMap { ws in
            ws.tabs.flatMap { tab in
                tab.panes.map {
                    AgentRef(server: server, workspace: ws.label, workspaceNumber: ws.number,
                             tab: tab.label, tabNumber: tab.number, pane: $0)
                }
            }
        }
    }

    /// All agents of all servers, sorted like Heeler (blocked → done → working → idle).
    func allAgents(_ servers: [Server], includeShells: Bool = false) -> [AgentRef] {
        servers.flatMap { agents(on: $0) }
            .filter { includeShells || $0.pane.agent != nil }
            .sorted {
                ($0.statusRank, $0.server.label, $0.workspaceNumber, $0.tabNumber, $0.pane.pane)
                    < ($1.statusRank, $1.server.label, $1.workspaceNumber, $1.tabNumber, $1.pane.pane)
            }
    }

    func ref(id: String, servers: [Server]) -> AgentRef? {
        allAgents(servers, includeShells: true).first { $0.id == id }
    }
}

extension Result where Failure == Error {
    init(asyncCatching body: () async throws -> Success) async {
        do { self = .success(try await body()) } catch { self = .failure(error) }
    }
}
