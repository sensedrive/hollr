import Foundation
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit

/// A working agent on the lock screen / Dynamic Island. Started and updated by the server's
/// `hollr watch` via push (server/src/activity.ts – keep the field names in sync).
struct AgentActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// working | waiting | done | error
        var status: String
        /// current step, or the question while it waits
        var step: String
        var todoDone: Int
        var todoTotal: Int
        /// unix seconds the turn started
        var since: Double
    }

    var pane: String
    var host: String
    /// host key fingerprint – which paired server
    var fp: String
    var title: String
    var agent: String
}
#endif

/// hollr://open?fp=…&pane=… – opens an agent (Live Activity, widgets).
enum HollrLink {
    static func open(fp: String, pane: String) -> URL? {
        var c = URLComponents()
        c.scheme = "hollr"
        c.host = "open"
        c.queryItems = [URLQueryItem(name: "fp", value: fp), URLQueryItem(name: "pane", value: pane)]
        return c.url
    }

    static func parseOpen(_ url: URL) -> (fp: String, pane: String)? {
        guard url.scheme == "hollr", url.host == "open",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let pane = items.first(where: { $0.name == "pane" })?.value else { return nil }
        return (items.first(where: { $0.name == "fp" })?.value ?? "", pane)
    }
}
