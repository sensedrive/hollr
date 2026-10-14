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
    /// servers whose live change feed is connected (then polling can slow down)
    private(set) var live: Set<UUID> = []
    /// bumped whenever a feed reports a change – views that load on their own can react
    private(set) var changeCount = 0
    private var feeds: [UUID: Task<Void, Never>] = [:]

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

    /// servers that just failed: tried again after a pause instead of on every refresh
    private var retryAfter: [UUID: Date] = [:]

    func refresh(_ servers: [Server], force: Bool = false) async {
        // an unreachable machine (asleep, off the network) would hold every refresh for its timeout
        let due = servers.filter { force || (retryAfter[$0.id] ?? .distantPast) <= .now }
        await withTaskGroup(of: (UUID, Result<[Workspace], Error>).self) { group in
            for server in due {
                group.addTask { (server.id, await Result(asyncCatching: { try await HollrClient.tree(server) })) }
            }
            for await (id, result) in group {
                switch result {
                case .success(let tree):
                    trees[id] = tree
                    errors[id] = nil
                    retryAfter[id] = nil
                case .failure(let error):
                    errors[id] = error.localizedDescription
                    retryAfter[id] = .now.addingTimeInterval(30)
                    if let server = servers.first(where: { $0.id == id }) { await SSHPool.shared.invalidate(server) }
                }
                loaded = true // show what we have, don't wait for the slowest machine
            }
        }
        let ids = Set(servers.map(\.id))
        trees = trees.filter { ids.contains($0.key) }
        loaded = true
    }

    /// One server's tree, without touching the others.
    func refresh(server: Server) async {
        do {
            trees[server.id] = try await HollrClient.tree(server)
            errors[server.id] = nil
        } catch {
            errors[server.id] = error.localizedDescription
        }
    }

    // MARK: live change feed (`hollr gate events`)

    /// Keeps one feed per server while the app is active; changes in herdr show up right away.
    func startFeeds(_ servers: [Server]) {
        for server in servers where feeds[server.id] == nil {
            feeds[server.id] = Task { [weak self] in await self?.runFeed(server) }
        }
        for (id, task) in feeds where !servers.contains(where: { $0.id == id }) {
            task.cancel()
            feeds[id] = nil
            live.remove(id)
        }
    }

    func stopFeeds() {
        feeds.values.forEach { $0.cancel() }
        feeds = [:]
        live = []
    }

    private func runFeed(_ server: Server) async {
        var backoff = 2.0
        while !Task.isCancelled {
            var unsupported = false
            do {
                let client = try await SSHPool.shared.client(for: server)
                try await client.withExec("events") { inbound, _ in
                    var buffer = Data()
                    for try await output in inbound {
                        guard case .stdout(let bytes) = output else { continue }
                        buffer.append(contentsOf: bytes.readableBytesView)
                        while let newline = buffer.firstIndex(of: 0x0a) {
                            let line = buffer[buffer.startIndex..<newline]
                            buffer.removeSubrange(buffer.startIndex...newline)
                            guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                            if obj["error"] != nil, obj["t"] == nil { unsupported = true }  // older server
                            switch obj["t"] as? String {
                            case "ready":
                                live.insert(server.id)
                                backoff = 2
                            case "changed":
                                changeCount += 1
                                await refresh(server: server)
                                if obj["spaces"] as? Bool == true { await refreshSpaces([server]) }
                            default:
                                break
                            }
                        }
                    }
                }
            } catch {}
            live.remove(server.id)
            if Task.isCancelled { break }
            // an older server without the feed: just keep polling, look again in a few minutes
            try? await Task.sleep(for: .seconds(unsupported ? 300 : backoff))
            backoff = min(backoff * 2, 30)
        }
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
