import Foundation
import Observation

/// One of the user's machines as all their Hollr apps know it (`hollr gate machines`, replicated on every server):
/// keyed by host key fingerprint, the newest `updatedAt` wins – a removal (`removed`) spreads like a pairing.
struct Machine: Codable, Equatable {
    var fp: String
    var label: String
    var addresses: [String]
    var port: Int
    var user: String
    /// ms
    var updatedAt: Double
    var removed: Bool?

    var isRemoved: Bool { removed == true }
}

extension Machine {
    init(server: Server) {
        self.init(fp: server.hostFingerprint, label: server.label, addresses: server.addresses, port: server.port,
                  user: server.user, updatedAt: server.updatedAt ?? 1, removed: nil)
    }
}

/// Another app installation lacks machine `fp` and asks an app paired with it for an invite.
struct PairRequest: Codable, Equatable {
    let fp: String
    let install: String
    let name: String
    let at: Double
}

/// A one-time pairing link for installation `install` (taken once, 10 minutes).
struct Invite: Codable, Equatable {
    let fp: String
    let install: String
    let url: String
    let expires: Double
}

/// A setting that belongs to the user, not to a device; the newest wins.
struct Pref<Value: Codable & Equatable>: Codable, Equatable {
    var value: Value
    /// ms; 1 = never edited (whatever a server already has wins)
    var updatedAt: Double
}

/// The composer's prompt snippets and the dictation vocabulary, the same in every app of the user.
struct Prefs: Codable, Equatable {
    var snippets: Pref<[String]>?
    var vocabulary: Pref<String>?
}

/// What `gate machines` answers.
struct MachinesDoc: Decodable {
    var machines: [Machine] = []
    var requests: [PairRequest] = []
    var prefs: Prefs?
    /// `take` only: the invites for this installation
    var taken: [Invite]?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machines = try c.decodeIfPresent([Machine].self, forKey: .machines) ?? []
        requests = try c.decodeIfPresent([PairRequest].self, forKey: .requests) ?? []
        prefs = try c.decodeIfPresent(Prefs.self, forKey: .prefs)
        taken = try c.decodeIfPresent([Invite].self, forKey: .taken)
    }

    private enum CodingKeys: String, CodingKey { case machines, requests, prefs, taken }
}

/// The sync's decisions (pure, tested).
enum Machines {
    /// asking again for the same machine: at most this often
    static let requestEvery: TimeInterval = 120

    /// Newest entry per machine; equal times keep the one seen first (like the server).
    static func union(_ lists: [[Machine]]) -> [Machine] {
        var byFp: [String: Machine] = [:]
        var order: [String] = []
        for machine in lists.joined() {
            if let have = byFp[machine.fp] {
                if machine.updatedAt > have.updatedAt { byFp[machine.fp] = machine }
            } else {
                byFp[machine.fp] = machine
                order.append(machine.fp)
            }
        }
        return order.compactMap { byFp[$0] }
    }

    /// Paired here but removed on another device after this record last changed.
    static func toRemove(_ union: [Machine], servers: [Server]) -> [(server: Server, at: Double)] {
        servers.compactMap { server in
            guard let entry = union.first(where: { $0.fp == server.hostFingerprint }), entry.isRemoved,
                  entry.updatedAt > (server.updatedAt ?? 1) else { return nil }
            return (server: server, at: entry.updatedAt)
        }
    }

    /// Machines another app has that this one lacks (and didn't remove more recently).
    static func missing(_ union: [Machine], servers: [Server], tombstones: [Machine]) -> [Machine] {
        let paired = Set(servers.map(\.hostFingerprint))
        return union.filter { entry in
            guard !entry.isRemoved, !paired.contains(entry.fp) else { return false }
            return !tombstones.contains { $0.fp == entry.fp && $0.updatedAt >= entry.updatedAt }
        }
    }

    static func answerKey(_ request: PairRequest) -> String { "\(request.fp)|\(request.install)|\(Int64(request.at))" }

    /// Other installations asking for a machine this app is paired with – each once.
    static func toAnswer(_ requests: [PairRequest], install: String, paired: Set<String>, done: Set<String>) -> [PairRequest] {
        requests.filter { $0.install != install && paired.contains($0.fp) && !done.contains(answerKey($0)) }
    }

    static func requestDue(_ last: Date?, now: Date) -> Bool {
        guard let last else { return true }
        return now.timeIntervalSince(last) >= requestEvery
    }

    /// Does the server lack something this app has (a machine entry or a setting at least as new)? Otherwise a
    /// plain `get` does: a merge rewrites the server's doc, which tells every app to sync again.
    static func needsMerge(_ local: [Machine], prefs: Prefs, server doc: MachinesDoc?) -> Bool {
        guard let doc else { return true }
        let has = Dictionary(doc.machines.map { ($0.fp, $0.updatedAt) }, uniquingKeysWith: max)
        if local.contains(where: { (has[$0.fp] ?? -1) < $0.updatedAt }) { return true }
        if let s = prefs.snippets, (doc.prefs?.snippets?.updatedAt ?? -1) < s.updatedAt { return true }
        if let v = prefs.vocabulary, (doc.prefs?.vocabulary?.updatedAt ?? -1) < v.updatedAt { return true }
        return false
    }

    /// The servers' version replaces the local one when it is newer – or when the local one was never edited
    /// (whatever is already on a server wins over this app's untouched default).
    static func adopts<Value>(local: Pref<Value>, remote: Pref<Value>?) -> Pref<Value>? {
        guard let remote, remote.value != local.value else { return nil }
        return remote.updatedAt > local.updatedAt || local.updatedAt <= 1 ? remote : nil
    }

    /// newest per setting over all servers
    static func union(prefs: [Prefs]) -> Prefs {
        var out = Prefs()
        for p in prefs {
            if let s = p.snippets, s.updatedAt > (out.snippets?.updatedAt ?? -1) { out.snippets = s }
            if let v = p.vocabulary, v.updatedAt > (out.vocabulary?.updatedAt ?? -1) { out.vocabulary = v }
        }
        return out
    }
}

/// Keeps this app paired with the same machines as the user's other Hollr apps (and their snippets and vocabulary
/// the same): at start, when a feed connects, when a server says the doc changed, after a change here and every
/// 5 minutes. A machine only another app knows is paired silently with an invite that app leaves on a server both
/// reach – no dialogs; problems show only in the greyed row in Settings and in the log.
@MainActor
@Observable
final class MachinesSync {
    /// machines another app has that this one lacks (greyed in Settings › Server)
    private(set) var missing: [Machine] = []
    /// being paired: an invite was taken or a request is open on a server
    private(set) var pending: Set<String> = []
    /// fp → why the last silent pairing failed
    private(set) var failures: [String: String] = [:]

    @ObservationIgnored private var store: ServerStore?
    @ObservationIgnored private var herdr: HerdrStore?
    @ObservationIgnored private var snippets: PromptSnippets?
    @ObservationIgnored private var dictation: DictationSettings?
    @ObservationIgnored private var pokes: AsyncStream<Void>.Continuation?
    @ObservationIgnored private var soon: Task<Void, Never>?
    @ObservationIgnored private var lastRequest: [String: Date] = [:]
    /// requests answered this run (Machines.answerKey)
    @ObservationIgnored private var answered = Set<String>()
    @ObservationIgnored private var pairing = Set<String>()
    /// per server: its last answer (whether it still lacks something from here)
    @ObservationIgnored private var known: [UUID: MachinesDoc] = [:]

    /// this app installation (made once, kept on the device)
    static var installId: String {
        let key = "machines.install"
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    func start(store: ServerStore, herdr: HerdrStore, snippets: PromptSnippets, dictation: DictationSettings) {
        guard pokes == nil else { return }
        self.store = store
        self.herdr = herdr
        self.snippets = snippets
        self.dictation = dictation
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        pokes = continuation
        store.onChange = { [weak self] in self?.poke() }
        herdr.onMachinesChanged = { [weak self] in self?.poke() }
        snippets.onEdit = { [weak self] in self?.pokeSoon() }
        dictation.onVocabularyEdit = { [weak self] in self?.pokeSoon() }
        // one sync at a time; pokes while one runs make one more afterwards
        Task { [weak self] in
            for await _ in stream { await self?.sync() }
        }
        Task { [weak self] in
            while !Task.isCancelled {
                self?.poke()
                try? await Task.sleep(for: .seconds(300))
            }
        }
    }

    func poke() { pokes?.yield() }

    /// typing in Settings: once it rests for a moment
    private func pokeSoon() {
        soon?.cancel()
        soon = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { self?.poke() }
        }
    }

    private func sync() async {
        guard let store else { return }
        // a server that just failed would hold the sync for its timeout
        let reachable = store.servers.filter { herdr?.errors[$0.id] == nil }
        guard !reachable.isEmpty else { return }
        let local = store.servers.map(Machine.init(server:)) + store.tombstones
        let prefs = localPrefs()
        var merge: [String: Any] = ["op": "merge", "machines": Self.jsonObject(local) ?? []]
        if let p = Self.jsonObject(prefs) { merge["prefs"] = p }
        // a merge rewrites the doc and makes every app sync again: only where something from here is missing
        let behind = reachable.filter { Machines.needsMerge(local, prefs: prefs, server: known[$0.id]) }
        let current = reachable.filter { server in !behind.contains { $0.id == server.id } }
        let docs = await call(behind, merge) + call(current, ["op": "get"])
        for (server, doc) in docs { known[server.id] = doc }
        Diagnostics.shared.note("machines: merge \(behind.count) get \(current.count) answered \(docs.count) of \(reachable.count)")
        guard !docs.isEmpty else { return }

        adoptPrefs(Machines.union(prefs: docs.compactMap(\.doc.prefs)))
        let union = Machines.union([local] + docs.map(\.doc.machines))
        let gone = Machines.toRemove(union, servers: store.servers)
        for entry in gone {
            HollrLog.info("machines: \(entry.server.label) was removed on another device")
            store.remove(entry.server, at: entry.at)
        }
        let live = docs.filter { doc in store.servers.contains { $0.id == doc.server.id } }
        let lacking = Machines.missing(union, servers: store.servers, tombstones: store.tombstones)
        Diagnostics.shared.note("machines: union \(union.count) remove \(gone.count) missing \(lacking.count)")
        await pairMissing(lacking, docs: live)
        await answerRequests(live)
    }

    // MARK: missing machines

    private func pairMissing(_ lacking: [Machine], docs: [(server: Server, doc: MachinesDoc)]) async {
        show(missing: lacking)
        let fps = Set(lacking.map(\.fp))
        let stillFailing = failures.filter { fps.contains($0.key) }
        if stillFailing != failures { failures = stillFailing }
        guard !lacking.isEmpty else {
            show(pending: [])
            return
        }
        let install = Self.installId
        let servers = docs.map(\.server)
        // still open from an earlier round (or before a restart)
        let open = docs.flatMap(\.doc.requests).filter { $0.install == install }.map(\.fp)
        var next = fps.intersection(Set(open).union(pairing))
        let taken: [Invite] = await call(servers, ["op": "take", "install": install]).flatMap { $0.doc.taken ?? [] }
        Diagnostics.shared.note("machines: \(lacking.count) missing, \(taken.count) invites")
        for machine in lacking {
            if let invite = taken.first(where: { $0.fp == machine.fp }) {
                next.insert(machine.fp)
                show(pending: next)
                await pairSilently(machine, link: invite.url)
                next.remove(machine.fp) // paired, or failed: then the row says why
                continue
            }
            guard Machines.requestDue(lastRequest[machine.fp], now: .now) else { continue }
            lastRequest[machine.fp] = .now
            let body: [String: Any] = ["op": "request", "fp": machine.fp, "install": install, "name": DeviceKey.defaultDeviceName]
            let asked = await call(servers, body).count
            Diagnostics.shared.note("machines: requested \(machine.label) on \(asked) servers")
            if asked > 0 { next.insert(machine.fp) }
        }
        let paired = Set(store?.servers.map(\.hostFingerprint) ?? [])
        show(missing: lacking.filter { !paired.contains($0.fp) })
        show(pending: next.subtracting(paired))
    }

    // only real changes: every assignment makes the server list diff again
    private func show(missing next: [Machine]) {
        if missing != next { missing = next }
    }

    private func show(pending next: Set<String>) {
        if pending != next { pending = next }
    }

    /// Pairs like a scanned link – without any UI. The record keeps the machine's label and time.
    private func pairSilently(_ machine: Machine, link: String) async {
        guard let store, !pairing.contains(machine.fp) else { return }
        pairing.insert(machine.fp)
        defer { pairing.remove(machine.fp) }
        do {
            var server = try await HollrClient.pair(link: link, deviceName: DeviceKey.defaultDeviceName)
            server.label = machine.label
            server.updatedAt = machine.updatedAt
            store.add(server)
            failures[machine.fp] = nil
            HollrLog.info("machines: paired \(machine.label) from another device")
        } catch {
            failures[machine.fp] = error.localizedDescription
            HollrLog.error("machines: pairing \(machine.label) failed: \(error.localizedDescription)")
        }
    }

    // MARK: answering other apps

    /// Another installation lacks a machine paired here: ask that machine for a one-time link and leave it as an
    /// invite on the server where the request was seen.
    private func answerRequests(_ docs: [(server: Server, doc: MachinesDoc)]) async {
        guard let store else { return }
        let install = Self.installId
        let paired = Set(store.servers.map(\.hostFingerprint))
        // the asking app asks on every server it reaches: one invite per machine and app is enough
        var invited = Set<String>()
        for (seenOn, doc) in docs {
            for request in Machines.toAnswer(doc.requests, install: install, paired: paired, done: answered) {
                answered.insert(Machines.answerKey(request))
                guard invited.insert("\(request.fp)|\(request.install)").inserted,
                      let target = store.servers.first(where: { $0.hostFingerprint == request.fp }) else { continue }
                do {
                    let url = try await HollrClient.pairLink(target)
                    let body: [String: Any] = ["op": "invite", "fp": request.fp, "install": request.install, "url": url]
                    _ = try await HollrClient.machines(seenOn, body)
                    HollrLog.info("machines: invited \(request.name) to \(target.label)")
                } catch {
                    HollrLog.error("machines: invite for \(target.label) failed: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: snippets and vocabulary

    private func localPrefs() -> Prefs {
        var prefs = Prefs()
        if let snippets { prefs.snippets = Pref(value: snippets.items, updatedAt: snippets.updatedAt) }
        if let dictation { prefs.vocabulary = Pref(value: dictation.vocabularyText, updatedAt: dictation.vocabularyUpdatedAt) }
        return prefs
    }

    private func adoptPrefs(_ remote: Prefs) {
        let local = localPrefs()
        if let snippets, let mine = local.snippets, let theirs = Machines.adopts(local: mine, remote: remote.snippets) {
            snippets.adopt(theirs.value, updatedAt: theirs.updatedAt)
        }
        if let dictation, let mine = local.vocabulary, let theirs = Machines.adopts(local: mine, remote: remote.vocabulary) {
            dictation.adoptVocabulary(theirs.value, updatedAt: theirs.updatedAt)
        }
    }

    // MARK: calls

    /// One `machines` call on each server at once; servers that fail or are too old (`not_allowed`) are left out.
    private func call(_ servers: [Server], _ body: [String: Any]) async -> [(server: Server, doc: MachinesDoc)] {
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return [] }
        return await withTaskGroup(of: (Server, MachinesDoc?).self) { group in
            for server in servers {
                group.addTask {
                    let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
                    return (server, try? await HollrClient.machines(server, request))
                }
            }
            var out: [(server: Server, doc: MachinesDoc)] = []
            for await (server, doc) in group {
                if let doc { out.append((server: server, doc: doc)) }
            }
            return out
        }
    }

    private static func jsonObject<T: Encodable>(_ value: T) -> Any? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }
}
