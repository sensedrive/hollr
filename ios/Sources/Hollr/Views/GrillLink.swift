import Foundation

/// Grill session labels („Grill TENDR-1071 · #3551“, „Auto-Grill #3551“, „Grill TENDR-1071“): the link from a herdr
/// session to its card on the Sandcastle board. Same regex as the server and the plugin.
enum GrillLabel {
    private static let full = try! NSRegularExpression(pattern: #"^(Auto-)?Grill (?:([A-Z][A-Z0-9]+-\d+) · )?#(\d+)$"#)
    private static let keyOnly = try! NSRegularExpression(pattern: #"^(Auto-)?Grill ([A-Z][A-Z0-9]+-\d+)$"#)

    /// The board's deep-link ticket (`<KEY>:<n>`, `:<n>` or `<KEY>:`) for a Grill label, else nil.
    static func ticket(_ label: String) -> String? {
        let s = label.trimmingCharacters(in: .whitespaces)
        let ns = s as NSString
        let range = NSRange(location: 0, length: ns.length)
        func group(_ m: NSTextCheckingResult, _ i: Int) -> String {
            m.range(at: i).location == NSNotFound ? "" : ns.substring(with: m.range(at: i))
        }
        if let m = full.firstMatch(in: s, range: range) { return "\(group(m, 2)):\(group(m, 3))" }
        if let m = keyOnly.firstMatch(in: s, range: range) { return "\(group(m, 2)):" }
        return nil
    }

    /// The plugin URL with `&open=<ticket>` appended to its fragment (next to `token=`), percent-encoded like JS
    /// encodeURIComponent.
    static func url(_ url: URL, opening ticket: String?) -> URL {
        guard let ticket, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        let value = ticket.addingPercentEncoding(withAllowedCharacters: allowed) ?? ticket
        let fragment = parts.percentEncodedFragment ?? ""
        parts.percentEncodedFragment = fragment.isEmpty ? "open=\(value)" : "\(fragment)&open=\(value)"
        return parts.url ?? url
    }
}

/// „Im Board zeigen“ from a chat: which server shows the Sandcastle board, and the request RootView turns into the
/// Plugins tab (a new PluginRoute, or an `open` event to the board already shown).
@MainActor @Observable
final class BoardLink {
    static let shared = BoardLink()

    struct Request: Equatable {
        let server: Server
        let plugin: PluginInfo
        let ticket: String
    }

    /// set by the chat, consumed by RootView
    var request: Request?
    /// a ticket for the board page already on screen; PluginView posts it as an `open` event
    var event: (server: Server.ID, ticket: String, serial: Int)?

    /// per server for this app session: its Sandcastle plugin, nil = none (failed lists are asked again)
    private var cache: [Server.ID: PluginInfo?] = [:]

    private func board(on server: Server) async -> PluginInfo? {
        if let known = cache[server.id] { return known }
        guard let list = try? await HollrClient.plugins(server) else { return nil }
        let plugin = list.first { $0.id == "sandcastle" && $0.error == nil }
        cache[server.id] = plugin
        return plugin
    }

    /// `prefer` when it lists the Sandcastle plugin, else the first of `servers` that does.
    func target(prefer: Server, servers: [Server]) async -> (Server, PluginInfo)? {
        if let p = await board(on: prefer) { return (prefer, p) }
        for s in servers where s.id != prefer.id {
            if let p = await board(on: s) { return (s, p) }
        }
        return nil
    }
}
