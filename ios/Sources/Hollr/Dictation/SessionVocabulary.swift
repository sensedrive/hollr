import Foundation

extension DictationContext {
    /// Words the open session is about: workspace, tab, folder, title, ticket keys and file names
    /// from the recent conversation. They go into the engines' vocabulary and fix spelling afterwards.
    @MainActor init(session: AgentSession) {
        var words: [String] = []
        let ref = session.ref
        words += [ref.workspace, ref.tab, ref.pane.folder, session.timeline?.title ?? ""]
        var texts: [String] = []
        var paths: [String] = []
        for item in (session.timeline?.items ?? []).suffix(40) {
            switch item {
            case let .user(_, text, _, _), let .text(_, text): texts.append(String(text.prefix(4000)))
            case let .ask(_, question, options, _, _, _): texts.append(question + " " + options.joined(separator: " "))
            case let .tools(_, calls): paths += calls.compactMap(\.path)
            default: break
            }
        }
        let all = texts.joined(separator: "\n")
        // ticket keys like TENDR-725 – the most recent ones first
        words += Self.matches(#"\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b"#, in: all).reversed()
        // file names without extension ("AgentSession.swift" → "AgentSession")
        words += paths.reversed().compactMap { path in
            let name = (path as NSString).lastPathComponent
            let stem = (name as NSString).deletingPathExtension
            return stem.count >= 4 ? stem : nil
        }
        // CamelCase / snake_case identifiers people say out loud
        words += Self.matches(#"\b[a-z]+[A-Z][A-Za-z0-9]+\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]+\b"#, in: all).reversed()
        var seen = Set<String>()
        terms = words
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.count >= 3 && Int($0) == nil && seen.insert($0.lowercased()).inserted }
            .prefix(40)
            .map { $0 }
    }

    private static func matches(_ pattern: String, in text: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text))
            .compactMap { Range($0.range, in: text).map { String(text[$0]) } }
    }
}
