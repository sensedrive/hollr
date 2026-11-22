import Foundation

/// What the desktop app and this app share about one server (`hollr gate shared`, kept on the server, so both
/// always show the same): results seen or dismissed, sessions marked unread, "Meine Sitzungen" and the dragged
/// order of spaces, worktrees and tabs. Keys are herdr ids (pane "w1:p2", workspace "w1", tab ids) – never this
/// app's server id, which the desktop doesn't know. The desktop's "long run" cards (`hiddenLong`) have no
/// counterpart here and are left alone.
struct SharedState: Codable, Equatable {
    /// pane → `since` of the status whose result was looked at
    var seen: [String: Double] = [:]
    /// pane → `since` of the status whose card was removed by hand
    var dismissed: [String: Double] = [:]
    /// panes marked unread by hand (until opened again)
    var unread: [String: Bool] = [:]
    /// "Meine Sitzungen", newest first
    var mySessions: [String] = []
    /// dragged order of the space groups (the first space id of each)
    var spaceOrder: [String] = []
    /// repo space → its worktree spaces in dragged order
    var worktreeOrder: [String: [String]] = [:]
    /// space → its tab ids in dragged order
    var tabOrder: [String: [String]] = [:]

    init(mySessions: [String] = []) {
        self.mySessions = mySessions
    }

    // every key is optional: a doc from a newer or older server still loads
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seen = try c.decodeIfPresent([String: Double].self, forKey: .seen) ?? [:]
        dismissed = try c.decodeIfPresent([String: Double].self, forKey: .dismissed) ?? [:]
        unread = try c.decodeIfPresent([String: Bool].self, forKey: .unread) ?? [:]
        mySessions = try c.decodeIfPresent([String].self, forKey: .mySessions) ?? []
        spaceOrder = try c.decodeIfPresent([String].self, forKey: .spaceOrder) ?? []
        worktreeOrder = try c.decodeIfPresent([String: [String]].self, forKey: .worktreeOrder) ?? [:]
        tabOrder = try c.decodeIfPresent([String: [String]].self, forKey: .tabOrder) ?? [:]
    }

    /// The doc after `changes`, applied like the server does (so the optimistic state matches its answer).
    func applying(_ changes: [SharedChange]) -> SharedState {
        var next = self
        for change in changes { next.apply(change) }
        return next
    }

    private mutating func apply(_ change: SharedChange) {
        guard let key = change.path.first else { return }
        let value = change.value
        if change.path.count == 1 {
            switch key {
            case "mySessions": mySessions = value.ids ?? []
            case "spaceOrder": spaceOrder = value.ids ?? []
            default: break
            }
            return
        }
        let entry = change.path[1]
        switch key {
        case "seen": seen[entry] = value.number
        case "dismissed": dismissed[entry] = value.number
        case "unread": unread[entry] = value == .flag ? true : nil
        case "worktreeOrder": worktreeOrder[entry] = value.ids
        case "tabOrder": tabOrder[entry] = value.ids
        default: break
        }
    }
}

/// One change to the shared doc: `path` = [key] for a list, [key, entry] for a map; `.remove` drops the entry
/// (or empties the list).
struct SharedChange: Equatable {
    enum Value: Equatable {
        case number(Double), flag, ids([String]), remove

        var number: Double? {
            if case let .number(n) = self { return n }
            return nil
        }

        /// like the server: each id once, in order
        var ids: [String]? {
            guard case let .ids(list) = self else { return nil }
            var once = Set<String>()
            return list.filter { once.insert($0).inserted }
        }

        var json: Any {
            switch self {
            case let .number(n): return n
            case .flag: return true
            case let .ids(list): return list
            case .remove: return NSNull()
            }
        }
    }

    let path: [String]
    let value: Value

    var json: [String: Any] { ["path": path, "value": value.json] }

    static func seen(_ pane: String, _ since: Double) -> SharedChange { SharedChange(path: ["seen", pane], value: .number(since)) }
    static func dismissed(_ pane: String, _ since: Double) -> SharedChange { SharedChange(path: ["dismissed", pane], value: .number(since)) }
    static func unread(_ pane: String, _ on: Bool) -> SharedChange { SharedChange(path: ["unread", pane], value: on ? .flag : .remove) }
    static func mySessions(_ panes: [String]) -> SharedChange { SharedChange(path: ["mySessions"], value: .ids(panes)) }
}

// MARK: seen / dismissed / unread (pure, tested)

extension SharedState {
    /// marked unread by hand: shows as a new result until opened
    func isUnread(_ pane: String) -> Bool { unread[pane] == true }

    /// the result of the pane's current status was looked at (and not marked unread since)
    func resultSeen(_ pane: Pane) -> Bool {
        guard let since = pane.since, !isUnread(pane.pane) else { return false }
        return seen[pane.pane] == since
    }

    /// The status its dot and the lists show: a session marked unread as a new result, a seen result as ready.
    func shownStatus(_ pane: Pane) -> String {
        if pane.status == "working" || pane.status == "blocked" { return pane.status }
        if pane.agent != nil && isUnread(pane.pane) { return "done" }
        if pane.status == "done" && resultSeen(pane) { return "idle" }
        return pane.status
    }

    /// Which status the pane brings into "Braucht dich" (nil = none): one that waits for you, a result, or a
    /// session marked unread (even when herdr calls it ready).
    func inboxStatus(_ pane: Pane) -> String? {
        if pane.status == "blocked" || pane.status == "done" { return pane.status }
        return pane.status == "idle" && isUnread(pane.pane) ? "done" : nil
    }

    /// A card stays hidden when it was removed by hand for this status, or is a result already seen. A question
    /// still waits however long it was looked at; a session marked unread always shows.
    func hidesCard(_ kind: InboxEntry.Kind, of pane: Pane) -> Bool {
        if isUnread(pane.pane) { return false }
        if let since = pane.since, dismissed[pane.pane] == since { return true }
        return (kind == .done || kind == .error) && resultSeen(pane)
    }
}

// MARK: dragged orders (pure, tested)

enum SharedOrder {
    /// `items` in the saved order; ones not saved yet follow in their own order (tabs, space groups)
    static func ordered<T>(_ items: [T], saved: [String]?, id: (T) -> String) -> [T] {
        guard let saved, !saved.isEmpty else { return items }
        var rank: [String: Int] = [:]
        for (i, value) in saved.enumerated() where rank[value] == nil { rank[value] = i }
        let known: [(item: T, rank: Int, at: Int)] = items.enumerated().compactMap { at, item in
            rank[id(item)].map { (item: item, rank: $0, at: at) }
        }
        let sorted = known.sorted { ($0.rank, $0.at) < ($1.rank, $1.at) }.map(\.item)
        return sorted + items.filter { rank[id($0)] == nil }
    }

    /// a repo's worktrees: the saved order first, the rest by name (like the desktop sidebar)
    static func worktrees(_ spaces: [Space], saved: [String]?) -> [Space] {
        var rank: [String: Int] = [:]
        for (i, value) in (saved ?? []).enumerated() where rank[value] == nil { rank[value] = i }
        return spaces.sorted { a, b in
            let ra = rank[a.id] ?? Int.max
            let rb = rank[b.id] ?? Int.max
            if ra != rb { return ra < rb }
            return a.label.localizedCompare(b.label) == .orderedAscending
        }
    }

    /// space groups (repo + its worktrees, or one space) in the dragged orders
    static func groups(_ groups: [(key: String, spaces: [Space])], in doc: SharedState?) -> [(key: String, spaces: [Space])] {
        let ordered = ordered(groups, saved: doc?.spaceOrder) { $0.key }
        return ordered.map { group in
            guard group.spaces.count > 2, let head = group.spaces.first else { return group }
            return (key: group.key, spaces: [head] + worktrees(Array(group.spaces.dropFirst()), saved: doc?.worktreeOrder[group.key]))
        }
    }
}
