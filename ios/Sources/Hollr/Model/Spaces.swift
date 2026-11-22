import Foundation

struct GitSummary: Codable, Hashable {
    let branch: String
    let ahead: Int
    let behind: Int
    let dirty: Int
    let lastCommit: Commit?

    struct Commit: Codable, Hashable {
        let hash: String
        let subject: String
        let at: Double
    }
}

/// herdr workspace with repo / worktree info (like herdr's "spaces" sidebar).
struct Space: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let number: Int
    let focused: Bool
    let status: String
    let root: String
    let repo: String?
    let isWorktree: Bool
    let git: GitSummary?
    let paneCount: Int
    /// its folder is gone (a worktree removed outside herdr) – it can only be closed; older servers don't send it
    var missing: Bool? = nil
    /// taken off the apps' lists with „Verstecken“ (kept on the server, same on every device); older servers don't send it
    var hidden: Bool? = nil

    var folder: String { root.split(separator: "/").last.map(String.init) ?? root }
    var isHidden: Bool { hidden == true }
}

/// Spaces hidden with „Verstecken“: off the main list, the overview and the inbox – herdr keeps them running.
/// A session that waits for you (blocked) still shows (parity with the desktop app's `isHidden`).
enum HiddenSpaces {
    /// the main list: not hidden, or hidden but waiting for you
    static func shown(_ spaces: [Space], status: (Space) -> String) -> [Space] {
        spaces.filter { !$0.isHidden || status($0) == "blocked" }
    }

    /// the „Versteckt“ list, in the server's order
    static func hidden(_ spaces: [Space]) -> [Space] { spaces.filter(\.isHidden) }

    /// the session's space is hidden and the session doesn't wait for you
    static func hides(_ ref: AgentRef, in spaces: [Space]?) -> Bool {
        guard ref.pane.status != "blocked", let spaces else { return false }
        let ws = ref.workspaceId
        return spaces.contains { $0.id == ws && $0.isHidden }
    }

    /// the list with exactly `ids` hidden
    static func marking(_ spaces: [Space], hidden ids: Set<String>) -> [Space] {
        spaces.map { space in
            var space = space
            space.hidden = ids.contains(space.id)
            return space
        }
    }

    /// hide / unhide came with hollr 0.47.0 (a "0.47.0-dev" build counts as 0.47.0)
    static func supported(version: String) -> Bool {
        let parts = version.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        let padded = parts + Array(repeating: 0, count: max(0, 3 - parts.count))
        return padded.prefix(3).lexicographicallyPrecedes([0, 47, 0]) == false
    }
}

extension AgentRef {
    /// herdr workspace id of the pane ("w1" of "w1:p2")
    var workspaceId: String { pane.pane.split(separator: ":").first.map(String.init) ?? "" }
}

struct CommitRow: Codable, Identifiable, Hashable {
    let hash: String
    let subject: String
    let author: String
    let at: Double
    let refs: String?
    var id: String { hash }
}

struct ChangedFile: Codable, Identifiable, Hashable {
    let status: String
    let path: String
    var id: String { path }
}

struct DirEntry: Codable, Identifiable, Hashable {
    let name: String
    let dir: Bool
    let size: Int
    var mtime: Double? = nil
    var id: String { name }
}

struct FileContent: Codable {
    let path: String
    let size: Int
    let binary: Bool
    let truncated: Bool
    let text: String
}

/// omp's footer: model · folder · branch · context
struct StatusLine: Codable, Equatable {
    var model: String?
    var folder: String?
    var branch: String?
    var dirty: Int?
    var context: String?
    var cost: String?
}

struct UsageLimit: Codable, Identifiable, Hashable {
    let provider: String
    let account: String?
    let label: String
    let window: String
    let used: Double
    let resetsAt: Double?
    let status: String?
    var id: String { "\(provider)|\(account ?? "")|\(label)|\(window)" }

    /// "5 Hour" / "5 hours" → "5h", "7 Day" → "7d", "Monthly" → "Monat"
    var shortWindow: String {
        let w = window.lowercased()
        if let n = w.split(separator: " ").first.flatMap({ Int($0) }) {
            if w.contains("hour") { return "\(n)h" }
            if w.contains("day") { return "\(n)d" }
        }
        return w.contains("month") ? "Monat" : window
    }

    var providerName: String { UsageLimit.name(provider) }

    static func name(_ provider: String) -> String {
        switch provider {
        case "anthropic": return "Claude"
        case "openai-codex": return "ChatGPT"
        case "cursor": return "Cursor"
        case "ollama-cloud": return "Ollama"
        default: return provider
        }
    }
}

enum RelativeTime {
    /// Time until a reset, precise to the minute: "in 4 Std., 23 Min.", "in 1 Tag, 6 Std.".
    static func countdown(_ epochMs: Double) -> String {
        let seconds = epochMs / 1000 - Date.now.timeIntervalSince1970
        guard seconds > 30 else { return String(localized: "gleich") }
        let f = DateComponentsFormatter()
        f.unitsStyle = .short
        f.maximumUnitCount = 2
        f.allowedUnits = seconds >= 86_400 ? [.day, .hour] : [.hour, .minute]
        var calendar = Calendar.current
        calendar.locale = Locale(identifier: Bundle.main.preferredLocalizations.first ?? "de")
        f.calendar = calendar
        let text = f.string(from: seconds) ?? ""
        return String(localized: "in \(text)")
    }

    static func string(_ epochMs: Double) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        f.locale = Locale(identifier: "de_DE")
        return f.localizedString(for: Date(timeIntervalSince1970: epochMs / 1000), relativeTo: .now)
    }
}

/// Pooled usage across all accounts of a provider (what omp rotates through).
struct UsageCapacity: Codable, Identifiable, Hashable {
    let provider: String
    let window: String
    let meter: String?
    let accounts: Int
    let used: Double
    var id: String { "\(provider)|\(window)|\(meter ?? "")" }
}
