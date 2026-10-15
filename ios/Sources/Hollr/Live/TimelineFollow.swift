import Citadel
import Foundation
import NIOCore

/// One line of `hollr gate follow` (server/src/follow.ts), decoded off the main thread.
enum FollowEvent {
    case full(Timeline)
    /// head = everything but the items; items = new or changed ones; order = all ids
    case delta(head: Timeline, order: [String], items: [TimelineItem])
    case gone
    case unsupported
    case other

    private struct Envelope: Decodable {
        let t: String?
        let error: String?
    }

    private struct Delta: Decodable {
        let head: Timeline
        let order: [String]
        let items: [TimelineItem]
        let etag: String?
    }

    static func decode(_ line: Data) -> FollowEvent {
        guard let env = try? JSONDecoder().decode(Envelope.self, from: line) else { return .other }
        if env.error == "not_allowed" { return .unsupported }
        if env.t == "error" { return .gone }
        switch env.t {
        case "full":
            return (try? JSONDecoder().decode(Timeline.self, from: line)).map(FollowEvent.full) ?? .other
        case "delta":
            // put "items": [] into the head so it decodes as a Timeline
            guard var obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
                  var head = obj["head"] as? [String: Any] else { return .other }
            head["items"] = []
            head["etag"] = obj["etag"]
            obj["head"] = head
            guard let fixed = try? JSONSerialization.data(withJSONObject: obj),
                  let d = try? JSONDecoder().decode(Delta.self, from: fixed) else { return .other }
            var h = d.head
            h.etag = d.etag
            return .delta(head: h, order: d.order, items: d.items)
        default:
            return .other
        }
    }

    /// Applies a delta to the timeline on screen; nil = an id is unknown (needs a full one).
    static func merge(_ current: Timeline?, head: Timeline, order: [String], items: [TimelineItem]) -> Timeline? {
        var known: [String: TimelineItem] = [:]
        for item in current?.items ?? [] { known[item.id] = item }
        for item in items { known[item.id] = item }
        var merged: [TimelineItem] = []
        merged.reserveCapacity(order.count)
        for id in order {
            guard let item = known[id] else { return nil }
            merged.append(item)
        }
        var next = head
        next.items = merged
        return next
    }
}
