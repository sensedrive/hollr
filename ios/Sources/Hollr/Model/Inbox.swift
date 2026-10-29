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

    static func == (a: InboxEntry, b: InboxEntry) -> Bool {
        a.id == b.id && a.kind == b.kind && a.text == b.text && a.options == b.options && a.turn == b.turn
    }

    /// Timeline → entry (pure, tested). nil = nothing for you here.
    static func make(ref: AgentRef, timeline: Timeline?) -> InboxEntry? {
        let status = ref.pane.status
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
    /// turns you dismissed ("ref.id|turn")
    private var dismissed = Set<String>()
    /// answered here: hidden until the agent's state changes
    private var answered: [String: String] = [:]
    @ObservationIgnored private var cache: [String: (status: String, at: Date, timeline: Timeline?)] = [:]
    @ObservationIgnored private var running = false

    func update(_ refs: [AgentRef]) async {
        guard !running else { return }
        running = true
        defer { running = false }
        var next: [InboxEntry] = []
        for ref in refs where ref.pane.status == "blocked" || ref.pane.status == "done" {
            if let was = answered[ref.id], was == ref.pane.status { continue }
            answered[ref.id] = nil
            var timeline = cache[ref.id]?.timeline
            let stale = cache[ref.id].map { $0.status != ref.pane.status || Date().timeIntervalSince($0.at) > 15 } ?? true
            if stale, ref.pane.agent == "omp" {
                timeline = (try? await HollrClient.timeline(ref.server, pane: ref.pane.pane, limit: 30)) ?? timeline
                cache[ref.id] = (ref.pane.status, .now, timeline)
            }
            guard let entry = InboxEntry.make(ref: ref, timeline: timeline),
                  !dismissed.contains("\(ref.id)|\(entry.turn)") else { continue }
            next.append(entry)
        }
        let order: [InboxEntry.Kind: Int] = [.ask: 0, .waiting: 1, .error: 2, .done: 3]
        next.sort { (order[$0.kind] ?? 9, $0.ref.title) < (order[$1.kind] ?? 9, $1.ref.title) }
        if next != entries { entries = next }
        let ids = Set(refs.map(\.id))
        cache = cache.filter { ids.contains($0.key) }
    }

    func dismiss(_ entry: InboxEntry) {
        dismissed.insert("\(entry.id)|\(entry.turn)")
        entries.removeAll { $0.id == entry.id }
    }

    /// Answered from the home screen: hide it right away, it comes back when the agent needs you again.
    func markAnswered(_ entry: InboxEntry) {
        answered[entry.id] = entry.ref.pane.status
        cache[entry.id] = nil
        entries.removeAll { $0.id == entry.id }
    }
}
