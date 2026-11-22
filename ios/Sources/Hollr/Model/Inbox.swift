import Foundation
import Observation

/// "Braucht dich": agents that wait for you (a question, a confirmation) or just finished,
/// across all servers – answered right on the home screen.
struct InboxEntry: Identifiable, Equatable {
    enum Kind: Equatable { case ask, waiting, done, error }

    let ref: AgentRef
    var kind: Kind
    /// question, or the agent's last words
    var text: String
    var options: [String]
    /// identifies this turn (dismissing hides it until something new happens)
    var turn: String
    /// index of omp's recommended option
    var recommended: Int? = nil

    var id: String { ref.id }

    /// `pane@since`: one card per status of a pane, the same on every device (dismissed / seen in SharedState)
    var key: String { Self.key(ref) }

    static func key(_ ref: AgentRef) -> String { "\(ref.pane.pane)@\(ref.pane.since.map { String(Int64($0)) } ?? "")" }

    static func == (a: InboxEntry, b: InboxEntry) -> Bool {
        a.key == b.key && a.ref.server.id == b.ref.server.id && a.kind == b.kind && a.text == b.text
            && a.options == b.options && a.turn == b.turn
    }

    /// Timeline → entry (pure, tested). nil = nothing for you here. `status`: what the inbox treats the pane as
    /// (SharedState.inboxStatus – a session marked unread counts as done).
    static func make(ref: AgentRef, timeline: Timeline?, status: String? = nil) -> InboxEntry? {
        let status = status ?? ref.pane.status
        guard status == "blocked" || status == "done" else { return nil }
        let items = timeline?.visibleItems ?? []
        if status == "blocked" {
            for item in items.reversed() {
                if case let .ask(id, questions, _, true) = item, let first = questions.first {
                    // several questions (or multi-select) need the chat: no one-tap options here
                    return InboxEntry(ref: ref, kind: .ask, text: plain(first.question),
                                      options: questions.answeredByTap ? first.options : [], turn: id,
                                      recommended: first.recommended)
                }
            }
            let last = items.last.map(\.id) ?? "blocked"
            return InboxEntry(ref: ref, kind: .waiting, text: lastText(items) ?? "", options: [], turn: last)
        }
        // done: did the turn end with an error?
        for item in items.reversed() {
            if case let .end(id, _, status, error) = item {
                if status == "error" {
                    return InboxEntry(ref: ref, kind: .error, text: plain(error ?? ""), options: [], turn: id)
                }
                break
            }
        }
        let turn = items.last.map(\.id) ?? "done"
        return InboxEntry(ref: ref, kind: .done, text: lastText(items) ?? "", options: [], turn: turn)
    }

    private static func lastText(_ items: [TimelineItem]) -> String? {
        for item in items.reversed() {
            if case let .text(_, text) = item { return plain(text) }
        }
        return nil
    }

    static func plain(_ text: String, max: Int = 220) -> String {
        var s = text.replacingOccurrences(of: #"[*_`#>]+"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return s.count > max ? String(s.prefix(max - 1)) + "…" : s
    }
}

@MainActor
@Observable
final class Inbox {
    private(set) var entries: [InboxEntry] = []
    /// answered here (entry keys): hidden until the pane's next status – only this device, only briefly
    private var answered = Set<String>()
    @ObservationIgnored private var cache: [String: (status: String, at: Date, timeline: Timeline?)] = [:]
    @ObservationIgnored private var running = false
    /// asked again while running: one more round with the newest input afterwards
    @ObservationIgnored private var pending: (refs: [AgentRef], shared: [UUID: SharedState])?

    /// `shared`: per server what was seen, dismissed or marked unread (HerdrStore.shared)
    func update(_ refs: [AgentRef], shared: [UUID: SharedState]) async {
        guard !running else {
            pending = (refs, shared)
            return
        }
        running = true
        defer { running = false }
        var input: (refs: [AgentRef], shared: [UUID: SharedState])? = (refs, shared)
        while let next = input {
            pending = nil
            await build(next.refs, shared: next.shared)
            input = pending
        }
    }

    private func build(_ refs: [AgentRef], shared: [UUID: SharedState]) async {
        var next: [InboxEntry] = []
        var keys = Set<String>()
        for ref in refs {
            let doc = shared[ref.server.id] ?? SharedState()
            guard let status = doc.inboxStatus(ref.pane) else { continue }
            let key = InboxEntry.key(ref)
            keys.insert(key)
            if answered.contains(key) { continue }
            var timeline = cache[ref.id]?.timeline
            let stale = cache[ref.id].map { $0.status != status || Date().timeIntervalSince($0.at) > 15 } ?? true
            if stale, ref.pane.agent == "omp" {
                timeline = (try? await HollrClient.timeline(ref.server, pane: ref.pane.pane, limit: 30)) ?? timeline
                cache[ref.id] = (status, .now, timeline)
            }
            guard let entry = InboxEntry.make(ref: ref, timeline: timeline, status: status),
                  !doc.hidesCard(entry.kind, of: ref.pane) else { continue }
            next.append(entry)
        }
        let order: [InboxEntry.Kind: Int] = [.ask: 0, .waiting: 1, .error: 2, .done: 3]
        next.sort { (order[$0.kind] ?? 9, $0.ref.title) < (order[$1.kind] ?? 9, $1.ref.title) }
        if next != entries { entries = next }
        answered.formIntersection(keys)
        let ids = Set(refs.map(\.id))
        cache = cache.filter { ids.contains($0.key) }
    }

    /// „Gesehen“: off the list right away (HerdrStore.dismiss keeps it so on every device).
    func dismiss(_ entry: InboxEntry) {
        entries.removeAll { $0.id == entry.id }
    }

    /// Answered from the home screen: hide it right away, it comes back when the agent needs you again.
    func markAnswered(_ entry: InboxEntry) {
        answered.insert(entry.key)
        cache[entry.id] = nil
        entries.removeAll { $0.id == entry.id }
    }
}
