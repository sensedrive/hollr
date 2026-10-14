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

    var folder: String { root.split(separator: "/").last.map(String.init) ?? root }
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
