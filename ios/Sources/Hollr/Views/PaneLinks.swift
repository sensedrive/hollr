import SwiftUI

/// Ticket keys (`TENDR-1037`) and issue/PR numbers (`#3575`) in a session's terminal and chat become links: a tap
/// opens the Sandcastle board on that ticket, or – no board on any server – the JIRA / GitHub page in the Hollr
/// browser. What counts as a link comes from the pane's repo (`hollr gate links`).

extension HollrClient {
    /// The pane's repo context: its GitHub repo (`owner/name`) and the JIRA project keys of its `.lul-workr.json`.
    struct LinkContext: Decodable, Equatable {
        struct Jira: Decodable, Equatable {
            let baseUrl: String
            let keys: [String]
        }

        let repo: String?
        let jira: Jira?

        static let none = LinkContext(repo: nil, jira: nil)
    }

    static func links(_ server: Server, pane: String) async throws -> LinkContext {
        try await fs(server, ["pane": pane], as: LinkContext.self, command: "links")
    }
}

typealias LinkContext = HollrClient.LinkContext

/// Per pane for this app session. An older server (`not_allowed`) has no links; other failures are asked again.
@MainActor
final class PaneLinkCache {
    static let shared = PaneLinkCache()
    private var cache: [String: LinkContext] = [:]

    func context(for ref: AgentRef) async -> LinkContext {
        if let known = cache[ref.id] { return known }
        do {
            let context = try await HollrClient.links(ref.server, pane: ref.pane.pane)
            cache[ref.id] = context
            return context
        } catch HollrError.server("not_allowed") {
            cache[ref.id] = LinkContext.none
            return .none
        } catch {
            HollrLog.error("links: \(error)")
            return .none
        }
    }
}

/// A tappable reference: a JIRA ticket or a GitHub issue/PR of the pane's repo.
enum LinkRef: Hashable {
    case ticket(String)
    case issue(Int)

    static let scheme = "hollr-link"

    /// `hollr-link://ticket/TENDR-1037` · `hollr-link://issue/3575`
    var url: URL {
        switch self {
        case let .ticket(key): URL(string: "\(Self.scheme)://ticket/\(key)")!
        case let .issue(n): URL(string: "\(Self.scheme)://issue/\(n)")!
        }
    }

    init?(url: URL) {
        guard url.scheme == Self.scheme, let value = url.pathComponents.dropFirst().first else { return nil }
        switch url.host() {
        case "ticket" where value.range(of: #"^[A-Z][A-Z0-9]+-\d+$"#, options: .regularExpression) != nil:
            self = .ticket(value)
        case "issue":
            guard let n = Int(value), n > 0 else { return nil }
            self = .issue(n)
        default:
            return nil
        }
    }

    /// The board's deep link: `<KEY>:` for a ticket, `:<n>` (with the repo) for an issue.
    var boardTicket: String {
        switch self {
        case let .ticket(key): "\(key):"
        case let .issue(n): ":\(n)"
        }
    }

    /// The page itself, for the browser when no server has the board.
    func pageURL(_ context: LinkContext) -> URL? {
        switch self {
        case let .ticket(key):
            guard let base = context.jira?.baseUrl else { return nil }
            let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
            return URL(string: "\(trimmed)/browse/\(key)")
        case let .issue(n):
            guard let repo = context.repo else { return nil }
            return URL(string: "https://github.com/\(repo)/issues/\(n)")
        }
    }
}

/// The two patterns – identical in the terminal page (terminal.html) and on every other client.
enum LinkMatcher {
    struct Match: Equatable {
        let range: NSRange
        let ref: LinkRef
    }

    private static let issue = try! NSRegularExpression(pattern: #"(?<![\w/&#])#(\d{1,6})\b"#)
    private static let urls = try! NSRegularExpression(pattern: #"(?:\b[a-zA-Z][a-zA-Z0-9+.-]*://|\bwww\.)[^\s<>"'`]+"#)

    /// JIRA keys as the server gives them; only plain project keys make it into the pattern.
    static func validKeys(_ keys: [String]) -> [String] {
        keys.filter { $0.range(of: #"^[A-Z][A-Z0-9]+$"#, options: .regularExpression) != nil }
    }

    private static func jira(_ keys: [String]) -> NSRegularExpression? {
        let keys = validKeys(keys)
        guard !keys.isEmpty else { return nil }
        return try? NSRegularExpression(pattern: #"\b("# + keys.joined(separator: "|") + #")-(\d+)\b"#)
    }

    /// Matches in plain text, never inside a URL. JIRA only with known keys, issues only with a known repo.
    static func matches(in text: String, keys: [String], hasRepo: Bool) -> [Match] {
        let ns = text as NSString
        let all = NSRange(location: 0, length: ns.length)
        let inURL = urls.matches(in: text, range: all).map(\.range)
        func free(_ r: NSRange) -> Bool { !inURL.contains { NSIntersectionRange($0, r).length > 0 } }
        var out: [Match] = []
        if let jira = jira(keys) {
            for m in jira.matches(in: text, range: all) where free(m.range) {
                out.append(Match(range: m.range, ref: .ticket(ns.substring(with: m.range))))
            }
        }
        if hasRepo {
            for m in issue.matches(in: text, range: all) where free(m.range) {
                if let n = Int(ns.substring(with: m.range(at: 1))), n > 0 { out.append(Match(range: m.range, ref: .issue(n))) }
            }
        }
        return out.sorted { $0.range.location < $1.range.location }
    }

    static func matches(in text: String, context: LinkContext) -> [Match] {
        matches(in: text, keys: context.jira?.keys ?? [], hasRepo: context.repo != nil)
    }

    // code spans, links, images, autolinks and raw HTML tags on a Markdown line: left as they are
    private static let protected = try! NSRegularExpression(
        pattern: #"(`+)[\s\S]*?\1|!?\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\[[^\]]*\]|<[^>\s]+>"#)

    /// Markdown with every match outside code (fenced blocks, code spans) and existing links turned into a
    /// `hollr-link://` link.
    static func linkify(markdown: String, context: LinkContext) -> String {
        guard context.repo != nil || !validKeys(context.jira?.keys ?? []).isEmpty else { return markdown }
        var fence: String?
        let lines = markdown.components(separatedBy: "\n").map { line -> String in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let open = fence {
                if trimmed.hasPrefix(open) { fence = nil }
                return line
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                fence = String(trimmed.prefix(3))
                return line
            }
            return linkify(line: line, context: context)
        }
        return lines.joined(separator: "\n")
    }

    private static func linkify(line: String, context: LinkContext) -> String {
        let found = matches(in: line, context: context)
        guard !found.isEmpty else { return line }
        let ns = line as NSString
        let skip = protected.matches(in: line, range: NSRange(location: 0, length: ns.length)).map(\.range)
        var out = ""
        var at = 0
        for m in found where !skip.contains(where: { NSIntersectionRange($0, m.range).length > 0 }) {
            guard m.range.location >= at else { continue }
            out += ns.substring(with: NSRange(location: at, length: m.range.location - at))
            out += "[\(ns.substring(with: m.range))](\(m.ref.url.absoluteString))"
            at = m.range.location + m.range.length
        }
        out += ns.substring(from: at)
        return out
    }
}

/// Opens a tapped reference: the session's own server's board if it has the Sandcastle plugin, else the first
/// paired server's that does; no board anywhere → the page in the Hollr browser.
@MainActor
enum LinkOpener {
    static func open(_ ref: LinkRef, context: LinkContext, server: Server, servers: [Server],
                     browser: OpenInBrowser) async {
        if let (target, plugin) = await BoardLink.shared.target(prefer: server, servers: servers) {
            let repo: String? = if case .issue = ref { context.repo } else { nil }
            BoardLink.shared.request = .init(server: target, plugin: plugin, ticket: ref.boardTicket, repo: repo)
        } else if let url = ref.pageURL(context) {
            browser(url)
        }
    }
}

private struct PaneLinkContextKey: EnvironmentKey {
    static let defaultValue = LinkContext.none
}

extension EnvironmentValues {
    /// the repo context of the session shown here (`.paneLinks`): what becomes a link in its text
    var paneLinks: LinkContext {
        get { self[PaneLinkContextKey.self] }
        set { self[PaneLinkContextKey.self] = newValue }
    }
}

/// Loads the pane's link context for everything below and handles taps on `hollr-link://` URLs; other links go on
/// to the outer `openURL` (the link chooser).
private struct PaneLinks: ViewModifier {
    let ref: AgentRef
    @Environment(ServerStore.self) private var store
    @Environment(\.openURL) private var outer
    @Environment(\.openInBrowser) private var browser
    @State private var context = LinkContext.none

    func body(content: Content) -> some View {
        content
            .environment(\.paneLinks, context)
            .environment(\.openURL, OpenURLAction { url in
                guard let link = LinkRef(url: url) else {
                    outer(url)
                    return .handled
                }
                let context = context, server = ref.server, servers = store.servers, browser = browser
                Task { await LinkOpener.open(link, context: context, server: server, servers: servers, browser: browser) }
                return .handled
            })
            .task(id: ref.id) { context = await PaneLinkCache.shared.context(for: ref) }
    }
}

extension View {
    func paneLinks(_ ref: AgentRef) -> some View { modifier(PaneLinks(ref: ref)) }
}
