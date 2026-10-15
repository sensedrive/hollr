import Foundation

/// Render-ready view of an omp session, built by `hollr gate timeline` (server/src/timeline.ts).
struct Timeline: Decodable, Equatable {
    var title: String?
    var items: [TimelineItem]
    var todo: [TodoPhase]?
    var jobs: [Job]
    var running: Bool
    var waiting: Bool
    var turnStartedAt: Double?
    var model: String?
    var status: String?
    var line: StatusLine?
    /// content fingerprint from the server – sent back on the next poll ("unchanged" costs a few bytes)
    var etag: String? = nil

    static let empty = Timeline(items: [], jobs: [], running: false, waiting: false)

    init(title: String? = nil, items: [TimelineItem], todo: [TodoPhase]? = nil, jobs: [Job], running: Bool,
         waiting: Bool, turnStartedAt: Double? = nil, model: String? = nil, status: String? = nil, line: StatusLine? = nil) {
        self.title = title
        self.items = items
        self.todo = todo
        self.jobs = jobs
        self.running = running
        self.waiting = waiting
        self.turnStartedAt = turnStartedAt
        self.model = model
        self.status = status
        self.line = line
    }

    /// The phase that is being worked on (first one with open tasks), like omp's TODO box.
    var activePhase: TodoPhase? {
        todo?.first { $0.tasks.contains { !$0.isClosed } } ?? todo?.last
    }

    /// Items as omp's transcript shows them: todo updates live only in the pinned TODO tree.
    var visibleItems: [TimelineItem] {
        items.compactMap { item in
            guard case let .tools(id, calls) = item else { return item }
            let shown = calls.filter { $0.name != "todo" }
            return shown.isEmpty ? nil : .tools(id: id, calls: shown)
        }
    }

    /// What omp shows in its working row: the intent of the latest running tool call.
    var workingLabel: String? {
        for item in items.reversed() {
            if case let .tools(_, calls) = item, let call = calls.last(where: { $0.status == "running" }) {
                return call.label
            }
        }
        return nil
    }

    var cleanTitle: String? {
        title.map { $0.replacingOccurrences(of: #"^[^\p{L}\p{N}]+"#, with: "", options: .regularExpression) }
            .flatMap { $0.isEmpty ? nil : $0 }
    }
}

struct ToolCall: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let label: String
    let detail: String?
    let status: String // running | ok | error
    let ms: Double?
    let add: Int?
    let del: Int?
    let result: String?
    let bg: String?
    var out: [String]? = nil
    var outTotal: Int? = nil
    var exit: Int? = nil
    var path: String? = nil
}

enum TimelineItem: Decodable, Equatable, Identifiable {
    case user(id: String, text: String, source: String, at: Double)
    case thinking(id: String, text: String)
    case text(id: String, text: String)
    case tools(id: String, calls: [ToolCall])
    case ask(id: String, question: String, options: [String], answer: String?, pending: Bool, details: AskDetails = AskDetails())
    case end(id: String, ms: Double, status: String, error: String?)
    case info(id: String, text: String)

    var id: String {
        switch self {
        case let .user(id, _, _, _), let .thinking(id, _), let .text(id, _), let .tools(id, _),
             let .ask(id, _, _, _, _, _), let .end(id, _, _, _), let .info(id, _):
            return id
        }
    }

    private enum Keys: String, CodingKey {
        case k, id, text, source, at, calls, question, options, answer, pending, ms, status, error
        case header, descriptions, recommended
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let id = try c.decode(String.self, forKey: .id)
        switch try c.decode(String.self, forKey: .k) {
        case "user":
            self = .user(id: id, text: try c.decode(String.self, forKey: .text),
                         source: (try? c.decode(String.self, forKey: .source)) ?? "typed",
                         at: (try? c.decode(Double.self, forKey: .at)) ?? 0)
        case "thinking": self = .thinking(id: id, text: try c.decode(String.self, forKey: .text))
        case "text": self = .text(id: id, text: try c.decode(String.self, forKey: .text))
        case "tools": self = .tools(id: id, calls: try c.decode([ToolCall].self, forKey: .calls))
        case "ask":
            self = .ask(id: id, question: try c.decode(String.self, forKey: .question),
                        options: (try? c.decode([String].self, forKey: .options)) ?? [],
                        answer: try? c.decode(String.self, forKey: .answer),
                        pending: (try? c.decode(Bool.self, forKey: .pending)) ?? false,
                        details: AskDetails(header: try? c.decode(String.self, forKey: .header),
                                            descriptions: (try? c.decode([String].self, forKey: .descriptions)) ?? [],
                                            recommended: try? c.decode(Int.self, forKey: .recommended)))
        case "end":
            self = .end(id: id, ms: (try? c.decode(Double.self, forKey: .ms)) ?? 0,
                        status: (try? c.decode(String.self, forKey: .status)) ?? "done",
                        error: try? c.decode(String.self, forKey: .error))
        default:
            self = .info(id: id, text: (try? c.decode(String.self, forKey: .text)) ?? "")
        }
    }
}

/// omp's ask extras: short title, a line per option, the recommended one.
struct AskDetails: Equatable {
    var header: String?
    var descriptions: [String] = []
    var recommended: Int?

    func description(_ index: Int) -> String? {
        index < descriptions.count && !descriptions[index].isEmpty ? descriptions[index] : nil
    }
}

struct TodoPhase: Decodable, Equatable, Identifiable {
    let name: String
    let tasks: [TodoTask]
    var id: String { name }
    var done: Int { tasks.filter { $0.status == "completed" }.count }
}

struct TodoTask: Decodable, Equatable, Identifiable {
    let content: String
    let status: String // pending | in_progress | completed | blocked | abandoned
    let blocker: String?
    var id: String { content }
    var isClosed: Bool { status == "completed" || status == "abandoned" }
}

struct Job: Decodable, Equatable, Identifiable {
    let id: String
    let type: String
    let label: String
    let startedAt: Double
}

enum Durations {
    /// omp's format: 850ms, 12.3s, 6m10s, 2h5m, 3d4h
    static func format(ms: Double) -> String {
        let ms = max(ms, 0)
        if ms < 1000 { return "\(Int(ms))ms" }
        let s = ms / 1000
        if s < 60 { return s < 10 ? String(format: "%.1fs", s) : "\(Int(s))s" }
        let total = Int(s)
        if total < 3600 { return "\(total / 60)m\(total % 60)s" }
        if total < 86400 { return "\(total / 3600)h\((total % 3600) / 60)m" }
        return "\(total / 86400)d\((total % 86400) / 3600)h"
    }

    static func since(_ epochMs: Double, now: Date = .now) -> String {
        format(ms: now.timeIntervalSince1970 * 1000 - epochMs)
    }
}
