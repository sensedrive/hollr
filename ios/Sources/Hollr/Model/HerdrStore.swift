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

    /// when each server's spaces (with their git state) were last loaded
    private var spacesAt: [UUID: Date] = [:]
    private var spacesSoon: Set<UUID> = []
    /// per server: newest spaces request – a pull right after a fetch sends two quick changes; the older
    /// answer arriving last must not bring back the old ↓N
    private var spacesSeq: [UUID: Int] = [:]

    func refreshSpaces(_ servers: [Server]) async {
        for server in servers {
            let seq = (spacesSeq[server.id] ?? 0) + 1
            spacesSeq[server.id] = seq
            if let list = try? await HollrClient.spaces(server), spacesSeq[server.id] == seq {
                if spaces[server.id] != list { spaces[server.id] = list }
                spacesAt[server.id] = Date()
            }
        }
    }

    /// „Verstecken“ / „Zurückholen“: the list changes right away, the server's answer and a reload confirm it; on an
    /// error the list goes back and the error is thrown for the view to show. Other devices learn it from the feed.
    func setHidden(_ server: Server, ws: String, hidden: Bool) async throws {
        let before = Set(HiddenSpaces.hidden(spaces[server.id] ?? []).map(\.id))
        var next = before
        if hidden { next.insert(ws) } else { next.remove(ws) }
        markHidden(server.id, next)
        // a reload that started before the change must not bring the old state back
        spacesSeq[server.id, default: 0] += 1
        do {
            markHidden(server.id, Set(try await HollrClient.setHidden(server, ws: ws, hidden: hidden)))
        } catch {
            markHidden(server.id, before)
            throw error
        }
        await refreshSpaces([server])
    }

    private func markHidden(_ id: UUID, _ ids: Set<String>) {
        guard let list = spaces[id] else { return }
        spaces[id] = HiddenSpaces.marking(list, hidden: ids)
    }

    /// the session's space is hidden and it doesn't wait for you: off the overview, the inbox and the switcher
    func hides(_ ref: AgentRef) -> Bool { HiddenSpaces.hides(ref, in: spaces[ref.server.id]) }

    /// hidden workspace ids per server (a view's trigger to filter again)
    var hiddenIds: [UUID: Set<String>] { spaces.mapValues { Set(HiddenSpaces.hidden($0).map(\.id)) } }

    /// Session activity (status, title, folder) may come with a commit or checkout the server's git watch
    /// already reported (`spaces: true`) – or, on servers before that watch, didn't: reload the spaces, at
    /// most every 5 s.
    private func refreshSpacesSoon(_ server: Server) {
        guard !spacesSoon.contains(server.id) else { return }
        spacesSoon.insert(server.id)
        let wait = max(0, 5 - Date().timeIntervalSince(spacesAt[server.id] ?? .distantPast))
        Task {
            try? await Task.sleep(for: .seconds(wait))
            spacesSoon.remove(server.id)
            await refreshSpaces([server])
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

    /// per server: only the newest tree request may write its answer (an older, slower one would
    /// bring back a pane that was just closed)
    private var treeGeneration: [UUID: Int] = [:]

    private func nextGeneration(_ id: UUID) -> Int {
        let n = (treeGeneration[id] ?? 0) + 1
        treeGeneration[id] = n
        return n
    }

    func refresh(_ servers: [Server], force: Bool = false) async {
        // an unreachable machine (asleep, off the network) would hold every refresh for its timeout
        let due = servers.filter { force || (retryAfter[$0.id] ?? .distantPast) <= .now }
        await withTaskGroup(of: (UUID, Result<[Workspace], Error>).self) { group in
            var generations: [UUID: Int] = [:]
            for server in due {
                generations[server.id] = nextGeneration(server.id)
                group.addTask { (server.id, await Result(asyncCatching: { try await HollrClient.tree(server) })) }
            }
            for await (id, result) in group {
                guard generations[id] == treeGeneration[id] else { continue } // a newer request is under way
                switch result {
                case .success(let tree):
                    setTree(id, tree)
                    setError(id, nil)
                    retryAfter[id] = nil
                    // connected: the shared doc comes along (the feed's `ready` loads it too; an older server
                    // without a feed gets it here, at most once per refresh until it arrives)
                    if shared[id] == nil, let server = servers.first(where: { $0.id == id }) {
                        Task { await loadShared(server) }
                    }
                case .failure(let error):
                    setError(id, error.localizedDescription)
                    retryAfter[id] = .now.addingTimeInterval(30)
                    // only a broken connection is worth reconnecting – not an error answer from herdr
                    if HollrError.isTransport(error), let server = servers.first(where: { $0.id == id }) {
                        await SSHPool.shared.invalidate(server)
                    }
                }
                if !loaded { loaded = true } // show what we have, don't wait for the slowest machine
            }
        }
        let ids = Set(servers.map(\.id))
        if trees.keys.contains(where: { !ids.contains($0) }) { trees = trees.filter { ids.contains($0.key) } }
        if shared.keys.contains(where: { !ids.contains($0) }) { shared = shared.filter { ids.contains($0.key) } }
        if !loaded { loaded = true }
    }

    // Every assignment to an observed property makes the lists diff again – even with the same value. Unchanged
    // trees and errors are left alone, so a refresh that finds nothing new doesn't touch the lists.
    private func setTree(_ id: UUID, _ raw: [Workspace]) {
        let tree = stamped(raw, server: id)
        if trees[id] != tree { trees[id] = tree }
    }

    private func setError(_ id: UUID, _ message: String?) {
        if errors[id] != message { errors[id] = message }
    }

    /// One server's tree, without touching the others.
    func refresh(server: Server) async {
        let gen = nextGeneration(server.id)
        do {
            let tree = try await HollrClient.tree(server)
            guard gen == treeGeneration[server.id] else { return }
            setTree(server.id, tree)
            setError(server.id, nil)
            retryAfter[server.id] = nil
        } catch {
            guard gen == treeGeneration[server.id] else { return }
            setError(server.id, error.localizedDescription)
        }
    }

    /// Servers before `since` (it came with `shared`): when this app first saw each pane in its status, so seen and
    /// dismissed results still work there (in memory). Per server, only panes of the newest tree are kept.
    @ObservationIgnored private var localSince: [UUID: [String: (status: String, since: Double)]] = [:]

    /// The tree as the lists use it: each workspace, tab and pane once (a List repeating an id crashes), and – on
    /// servers before `since` – every pane stamped.
    private func stamped(_ raw: [Workspace], server: UUID) -> [Workspace] {
        let tree = raw.uniqued
        let missing = tree.contains { ws in ws.tabs.contains { tab in tab.panes.contains { $0.since == nil } } }
        guard missing else { return tree }
        let now = Date().timeIntervalSince1970 * 1000
        let known = localSince[server] ?? [:]
        var next: [String: (status: String, since: Double)] = [:]
        func stamp(_ pane: Pane) -> Pane {
            var pane = pane
            if let was = known[pane.pane], was.status == pane.status { pane.since = was.since } else { pane.since = now }
            next[pane.pane] = (status: pane.status, since: pane.since ?? now)
            return pane
        }
        let result: [Workspace] = tree.map { ws in
            let tabs: [Tab] = ws.tabs.map { tab in
                Tab(id: tab.id, label: tab.label, number: tab.number, focused: tab.focused, panes: tab.panes.map(stamp))
            }
            return Workspace(id: ws.id, label: ws.label, number: ws.number, focused: ws.focused, status: ws.status, tabs: tabs)
        }
        localSince[server] = next
        return result
    }

    // MARK: shared with the other apps (`hollr gate shared`)

    /// Per server: what the desktop app and this app share (SharedState); nil until loaded. A server before
    /// `shared` gets a doc in memory only, for this run.
    private(set) var shared: [UUID: SharedState] = [:]
    /// servers that answered `not_allowed`: changes stay in memory, nothing is asked again
    private var sharedInMemory: Set<UUID> = []
    /// per server: bumped by every load and change – an answer that started before a newer one is stale
    private var sharedSeq: [UUID: Int] = [:]
    /// paired servers (for dropping the local "Meine Sitzungen" of servers no longer paired)
    private var paired: Set<UUID> = []

    private func nextSharedSeq(_ id: UUID) -> Int {
        let n = (sharedSeq[id] ?? 0) + 1
        sharedSeq[id] = n
        return n
    }

    /// Loads the doc: on (re)connecting and when the feed says another device changed it.
    func loadShared(_ server: Server) async {
        guard !sharedInMemory.contains(server.id) else { return }
        let seq = nextSharedSeq(server.id)
        do {
            let doc = try await HollrClient.shared(server)
            guard sharedSeq[server.id] == seq else { return }
            if shared[server.id] != doc { shared[server.id] = doc }
            await migrateMySessions(server, doc)
        } catch HollrError.server("not_allowed") {
            sharedInMemory.insert(server.id)
            // what this phone listed itself still shows there
            if shared[server.id] == nil { shared[server.id] = SharedState(mySessions: MySessions.legacy(for: server.id)) }
        } catch {
            HollrLog.error("shared \(server.label): \(error.localizedDescription)")
        }
    }

    /// Once per server: "Meine Sitzungen" this phone kept itself go to the server (unless it has a list already),
    /// then the local list of that server is deleted.
    private func migrateMySessions(_ server: Server, _ doc: SharedState) async {
        let local = MySessions.legacy(for: server.id)
        guard !local.isEmpty else { return }
        if doc.mySessions.isEmpty {
            do {
                try await patchShared(server, [.mySessions(Array(local.prefix(MySessions.max)))])
            } catch {
                return // tried again on the next load
            }
        }
        MySessions.forgetLegacy(of: server.id, paired: paired)
    }

    /// Changes the doc right away; the server's answer confirms it. On an error it goes back and the error is
    /// thrown. Nothing is sent when nothing changes – views may call this on every appearance.
    func patchShared(_ server: Server, _ changes: [SharedChange]) async throws {
        let before = shared[server.id] ?? SharedState()
        let next = before.applying(changes)
        guard next != before else { return }
        shared[server.id] = next
        let seq = nextSharedSeq(server.id)
        guard !sharedInMemory.contains(server.id) else { return }
        do {
            let answer = try await HollrClient.patchShared(server, changes)
            if sharedSeq[server.id] == seq, shared[server.id] != answer { shared[server.id] = answer }
        } catch HollrError.server("not_allowed") {
            sharedInMemory.insert(server.id) // an older server: the change stays in memory
        } catch {
            // a newer change went out meanwhile: the server's doc says what holds
            if sharedSeq[server.id] == seq { shared[server.id] = before } else { await loadShared(server) }
            throw error
        }
    }

    /// the doc, loaded first when it isn't yet (a whole-list change needs the current list)
    private func currentShared(_ server: Server) async -> SharedState? {
        if shared[server.id] == nil { await loadShared(server) }
        return shared[server.id]
    }

    /// The status a session's dot and the lists show (seen results quiet, ones marked unread as new).
    func shownStatus(_ ref: AgentRef) -> String {
        shared[ref.server.id]?.shownStatus(ref.pane) ?? ref.pane.status
    }

    func isUnread(_ ref: AgentRef) -> Bool { shared[ref.server.id]?.isUnread(ref.pane.pane) == true }

    /// in "Meine Sitzungen"
    func isMine(_ ref: AgentRef) -> Bool { shared[ref.server.id]?.mySessions.contains(ref.pane.pane) == true }

    /// The session is on screen: its result counts as seen, an unread mark is used up, and it moves to the front of
    /// "Meine Sitzungen" – one change. Nothing done by hand: a failure is only logged.
    func opened(_ ref: AgentRef) async {
        guard let doc = await currentShared(ref.server) else { return }
        let pane = ref.pane.pane
        var changes: [SharedChange] = [.unread(pane, false), .mySessions(MySessions.touching(doc.mySessions, pane))]
        if let since = ref.pane.since, ref.pane.status == "done" || ref.pane.status == "blocked" {
            changes.append(.seen(pane, since))
        }
        do { try await patchShared(ref.server, changes) } catch { HollrLog.error("shared opened: \(error.localizedDescription)") }
    }

    /// An open session turned done (or waits): what it shows now is seen – unless it was marked unread meanwhile.
    func seeing(_ ref: AgentRef) async {
        guard let since = ref.pane.since, ref.pane.status == "done" || ref.pane.status == "blocked", !isUnread(ref) else { return }
        do { try await patchShared(ref.server, [.seen(ref.pane.pane, since)]) } catch { HollrLog.error("shared seen: \(error.localizedDescription)") }
    }

    /// A new session: first in "Meine Sitzungen" right away (before its chat is on screen).
    func started(_ server: Server, pane: String) async {
        guard let doc = await currentShared(server) else { return }
        do { try await patchShared(server, [.mySessions(MySessions.touching(doc.mySessions, pane))]) } catch {
            HollrLog.error("shared started: \(error.localizedDescription)")
        }
    }

    /// „Als ungelesen markieren“: shows as a new result (dot, card) on every device until opened.
    func markUnread(_ refs: [AgentRef]) async throws {
        let byServer = Dictionary(grouping: refs) { $0.server.id }
        for (_, list) in byServer {
            guard let server = list.first?.server else { continue }
            try await patchShared(server, list.map { .unread($0.pane.pane, true) })
        }
    }

    /// The card's „Gesehen“: hidden until the pane's next status; an unread mark goes with it.
    func dismiss(_ entry: InboxEntry) async throws {
        let pane = entry.ref.pane.pane
        var changes: [SharedChange] = [.unread(pane, false)]
        if let since = entry.ref.pane.since { changes.append(.dismissed(pane, since)) }
        try await patchShared(entry.ref.server, changes)
    }

    /// „Aus der Übersicht nehmen“
    func removeMine(_ ref: AgentRef) async throws {
        guard let doc = await currentShared(ref.server) else { return }
        try await patchShared(ref.server, [.mySessions(doc.mySessions.filter { $0 != ref.pane.pane })])
    }

    /// the space's tab ids in their dragged order
    func tabOrder(_ server: Server, ws: String) -> [String]? { shared[server.id]?.tabOrder[ws] }

    // MARK: live change feed (`hollr gate events`)

    /// a feed connected, or a server's machines doc changed (another app paired or removed one): MachinesSync
    @ObservationIgnored var onMachinesChanged: (() -> Void)?

    /// Keeps one feed per server while the app is active; changes in herdr show up right away.
    func startFeeds(_ servers: [Server]) {
        paired = Set(servers.map(\.id))
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
            // the server pings every 20 s: silence means the connection died without anyone noticing
            // (Mac asleep, Wi-Fi → mobile) – drop it so the feed and every other command reconnect
            let lastLine = Clock()
            let watchdog = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(15))
                    if Task.isCancelled { return }
                    if lastLine.age > 50 {
                        HollrLog.error("events \(server.label): no ping for \(Int(lastLine.age))s – reconnecting")
                        await SSHPool.shared.invalidate(server)
                        return
                    }
                }
            }
            defer { watchdog.cancel() }
            do {
                let client = try await SSHPool.shared.client(for: server)
                lastLine.touch() // the clock starts once connected – connecting can take a while
                try await client.withExec("events") { inbound, _ in
                    var buffer = Data()
                    for try await output in inbound {
                        guard case .stdout(let bytes) = output else { continue }
                        lastLine.touch()
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
                                // (re)connected: another device may have changed what both share meanwhile
                                await loadShared(server)
                                onMachinesChanged?()
                            case "changed":
                                changeCount += 1
                                await refresh(server: server)
                                if obj["spaces"] as? Bool == true { await refreshSpaces([server]) } else { refreshSpacesSoon(server) }
                                if obj["shared"] as? Bool == true { await loadShared(server) }
                                if obj["machines"] as? Bool == true { onMachinesChanged?() }
                            default:
                                break
                            }
                        }
                    }
                }
            } catch {}
            live.remove(server.id)
            if Task.isCancelled { break }
            // an older server without the feed: just keep polling, look again in a few minutes.
            // A network change (Tailscale back, Wi-Fi ↔ mobile) ends the wait – reconnecting is worth it now.
            let network = NetworkWatch.shared.generation
            await NetworkWatch.shared.pause(unsupported ? 300 : backoff)
            backoff = NetworkWatch.shared.generation != network ? 2 : min(backoff * 2, 30)
        }
    }

    func agents(on server: Server) -> [AgentRef] {
        (trees[server.id] ?? []).flatMap { ws in
            ws.tabs.flatMap { tab in
                tab.panes.map {
                    AgentRef(server: server, workspace: ws.label, workspaceNumber: ws.number,
                             tab: tab.label, tabNumber: tab.number, pane: $0, tabId: tab.id)
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

/// Time since the last touch, readable from any task.
final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var last = Date()
    private var touched = false
    func touch() { lock.withLock { last = Date(); touched = true } }
    var age: TimeInterval { lock.withLock { Date().timeIntervalSince(last) } }
    /// touched at least once since it was made
    var any: Bool { lock.withLock { touched } }
}
