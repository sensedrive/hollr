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
    /// ping and anything unknown
    case other
    /// a line that doesn't decode: its changes would be lost – the stream starts over with a full timeline
    case broken

    private struct Envelope: Decodable {
        let t: String?
        let error: String?
    }

    private struct Delta: Decodable {
        let head: Timeline
        let order: [String]
        let items: [LossyItem]
        let etag: String?
    }

    static func decode(_ raw: Data) -> FollowEvent {
        do {
            // older servers could send a lone surrogate (text cut inside an emoji): repaired, not dropped
            return try parse(JSONRepair.wellFormed(raw))
        } catch {
            HollrLog.error("follow: undecodable line \(error) \(String(decoding: raw.prefix(120), as: UTF8.self))")
            return .broken
        }
    }

    private static func parse(_ line: Data) throws -> FollowEvent {
        let env = try JSONDecoder().decode(Envelope.self, from: line)
        if env.error == "not_allowed" { return .unsupported }
        switch env.t {
        case "error":
            return .gone
        case "full":
            return .full(try JSONDecoder().decode(Timeline.self, from: line))
        case "delta":
            // put "items": [] into the head so it decodes as a Timeline
            guard var obj = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                  var head = obj["head"] as? [String: Any] else { throw HollrError.badResponse }
            head["items"] = []
            obj["head"] = head
            let d = try JSONDecoder().decode(Delta.self, from: try JSONSerialization.data(withJSONObject: obj))
            var h = d.head
            h.etag = d.etag
            return .delta(head: h, order: d.order, items: d.items.map(\.item))
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
