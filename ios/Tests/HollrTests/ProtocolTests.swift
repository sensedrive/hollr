import XCTest
@testable import Hollr

final class ProtocolTests: XCTestCase {
    func testFrameRoundtripAcrossChunks() {
        let frames: [Frame] = [.audio(Data([1, 2, 3, 4])), .control(["t": "mute", "on": true])]
        let bytes = frames.map(\.encoded).reduce(Data(), +)
        var decoder = FrameDecoder()
        var out: [Frame] = []
        out += decoder.push(bytes.subdata(in: 0..<3))
        out += decoder.push(bytes.subdata(in: 3..<10))
        out += decoder.push(bytes.subdata(in: 10..<bytes.count))
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0], .audio(Data([1, 2, 3, 4])))
        guard case .json(let json) = out[1],
              let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any]
        else { return XCTFail("json frame") }
        XCTAssertEqual(obj["t"] as? String, "mute")
    }

    func testLiveEvents() {
        XCTAssertEqual(LiveEvent(json: Data(#"{"t":"phase","phase":"ended","reason":"hangup"}"#.utf8)), .phase("ended", reason: "hangup"))
        XCTAssertEqual(LiveEvent(json: Data(#"{"t":"answer","text":"4711","final":true}"#.utf8)), .answer("4711", final: true))
        XCTAssertEqual(LiveEvent(json: Data(#"{"t":"tool","name":"read"}"#.utf8)), .tool(name: "read", intent: nil))
        XCTAssertEqual(LiveEvent(json: Data("nope".utf8)), .other)
    }

    func testPairingPayload() throws {
        let json = #"{"v":1,"a":["1.2.3.4"],"p":22,"u":"ubuntu","fp":"SHA256:abc","s":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","e":\#(Int(Date().timeIntervalSince1970) + 600),"l":"my-server"}"#
        let c = Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let payload = try PairingPayload.parse("hollr://pair?c=\(c)")
        XCTAssertEqual(payload.l, "my-server")
        XCTAssertEqual(payload.bootstrapSeed?.count, 32)
        XCTAssertThrowsError(try PairingPayload.parse("https://example.com"))
    }

    func testExpiredPayloadRejected() {
        let json = #"{"v":1,"a":["1.2.3.4"],"p":22,"u":"u","fp":"x","s":"AA","e":1,"l":"x"}"#
        let c = Data(json.utf8).base64EncodedString().replacingOccurrences(of: "=", with: "")
        XCTAssertThrowsError(try PairingPayload.parse("hollr://pair?c=\(c)")) { error in
            XCTAssertEqual(error as? PairingPayload.ParseError, .expired)
        }
    }
}

@MainActor
final class DictationTests: XCTestCase {
    func testVocabularyPostProcessing() {
        let s = DictationSettings()
        s.useVocabulary = true
        s.vocabularyText = "TypeScript = Type Script, Type Skript\nJIRA = Jira\nKubernetes\nomp = OMP"
        s.replacements = []
        XCTAssertEqual(s.apply("das Type-Skript-Refactoring"), "das TypeScript-Refactoring")
        XCTAssertEqual(s.apply("den jira Link auf kubernetes"), "den JIRA Link auf Kubernetes")
        XCTAssertEqual(s.apply("frag OMP"), "frag omp")
        XCTAssertEqual(s.apply("Typescripten bleibt"), "Typescripten bleibt") // no partial-word hits
    }

    /// A text cut inside an emoji (older servers) must not make the whole chat undecodable.
    func testLoneSurrogateIsRepaired() throws {
        let raw = Data(#"{"a":"\\ud83d is text","b":"\ud83d\udd16","c":"x\ud83d"}"#.utf8)
        XCTAssertNil(try? JSONSerialization.jsonObject(with: raw))
        let fixed = String(decoding: JSONRepair.wellFormed(raw), as: UTF8.self)
        XCTAssertEqual(fixed, #"{"a":"\\ud83d is text","b":"\ud83d\udd16","c":"x\ufffd"}"#)
        let obj = try JSONSerialization.jsonObject(with: Data(fixed.utf8)) as? [String: String]
        XCTAssertEqual(obj?["b"], "🔖")
    }
}

final class TimelineDecodeTests: XCTestCase {
    /// One item the app can't read must not take the whole chat down (it stayed on its skeleton).
    func testUnreadableItemBecomesNote() throws {
        let raw = #"""
        {"items":[{"k":"text","id":"a","text":"Hallo"},{"k":"text","id":"b","text":42},
          {"k":"tools","id":"c","calls":[{"id":"t1","name":"read","label":"a.ts","status":"ok"},{"id":"t2","name":"bash"}]}],
         "todo":[{"tasks":[{"content":"Bauen"},{"status":"pending"}]}],
         "jobs":[{"id":"j"}],"running":false,"waiting":false}
        """#
        let tl = try JSONDecoder().decode(Timeline.self, from: Data(raw.utf8))
        XCTAssertEqual(tl.items.map(\.id), ["a", "b", "c"])
        guard case .info = tl.items[1] else { return XCTFail("placeholder for the unreadable item") }
        guard case let .tools(_, calls) = tl.items[2] else { return XCTFail("tools") }
        XCTAssertEqual(calls.map(\.id), ["t1"])
        XCTAssertEqual(tl.todo?.first?.tasks.map(\.content), ["Bauen"])
        XCTAssertEqual(tl.todo?.first?.tasks.first?.status, "pending")
        XCTAssertEqual(tl.jobs.count, 0)
    }

    /// A server error is not an empty chat.
    func testErrorAnswerIsNoTimeline() {
        XCTAssertNil(try? JSONDecoder().decode(Timeline.self, from: Data(#"{"error":"not_found"}"#.utf8)))
    }

    func testFollowLines() throws {
        let full = Data(#"{"t":"full","items":[{"k":"text","id":"a","text":"x\ud83d"}],"jobs":[],"running":true,"waiting":false,"etag":"e1"}"#.utf8)
        guard case let .full(tl) = FollowEvent.decode(full) else { return XCTFail("full with a lone surrogate") }
        XCTAssertEqual(tl.etag, "e1")
        // repaired, not swallowed into a placeholder by the lenient item decoding
        XCTAssertEqual(tl.items.first, .text(id: "a", text: "x\u{FFFD}"))

        // a changed item the app can't read keeps its id: the delta still merges instead of reconnecting forever
        let delta = Data(#"{"t":"delta","head":{"jobs":[],"running":false,"waiting":false},"order":["a","b"],"items":[{"k":"text","id":"b"}],"etag":"e2"}"#.utf8)
        guard case let .delta(head, order, items) = FollowEvent.decode(delta) else { return XCTFail("delta") }
        let merged = try XCTUnwrap(FollowEvent.merge(tl, head: head, order: order, items: items))
        XCTAssertEqual(merged.items.map(\.id), ["a", "b"])
        XCTAssertEqual(merged.etag, "e2")
        XCTAssertFalse(merged.running)

        // an id the app never saw: nil = reconnect for a full timeline
        XCTAssertNil(FollowEvent.merge(tl, head: head, order: ["a", "zz"], items: []))

        guard case .other = FollowEvent.decode(Data(#"{"t":"ping"}"#.utf8)) else { return XCTFail("ping") }
        guard case .gone = FollowEvent.decode(Data(#"{"t":"error","error":"not_found"}"#.utf8)) else { return XCTFail("gone") }
        guard case .unsupported = FollowEvent.decode(Data(#"{"error":"not_allowed"}"#.utf8)) else { return XCTFail("old server") }
        guard case .broken = FollowEvent.decode(Data(#"{"t":"full","items":"#.utf8)) else { return XCTFail("cut line") }
    }

    /// The placeholder keeps the item's id: once the server sends that item in a readable form, it takes its place.
    func testPlaceholderIsReplacedByReadableItem() throws {
        let full = Data(#"{"t":"full","items":[{"k":"text","id":"a","text":"x"},{"k":"text","id":"b","text":7}],"jobs":[],"running":true,"waiting":false}"#.utf8)
        guard case let .full(tl) = FollowEvent.decode(full) else { return XCTFail("full") }
        guard case .info = tl.items[1] else { return XCTFail("placeholder") }
        let delta = Data(#"{"t":"delta","head":{"jobs":[],"running":true,"waiting":false},"order":["a","b"],"items":[{"k":"text","id":"b","text":"jetzt lesbar"}]}"#.utf8)
        guard case let .delta(head, order, items) = FollowEvent.decode(delta) else { return XCTFail("delta") }
        let merged = try XCTUnwrap(FollowEvent.merge(tl, head: head, order: order, items: items))
        XCTAssertEqual(merged.items.last, .text(id: "b", text: "jetzt lesbar"))
    }

    /// An escaped backslash before "ud83d" is text, not a surrogate: the repair leaves the line as it is.
    func testEscapedBackslashIsNoSurrogate() {
        let raw = Data(#"{"t":"full","items":[{"k":"text","id":"a","text":"C:\\ud83d\\x"}],"jobs":[],"running":false,"waiting":false}"#.utf8)
        XCTAssertEqual(JSONRepair.wellFormed(raw), raw)
        guard case let .full(tl) = FollowEvent.decode(raw) else { return XCTFail("full") }
        XCTAssertEqual(tl.items.first, .text(id: "a", text: #"C:\ud83d\x"#))
    }
}

final class PaletteContrastTests: XCTestCase {
    /// Markdown hues: too pale ones (Latte's yellow 2.3:1) reach 4.5:1, readable ones stay untouched.
    func testReadableHues() {
        for palette in Palette.all {
            for hue in [palette.purple, palette.green, palette.yellow] {
                let ink = Palette.readable(hue, text: palette.fg, on: palette.bg)
                XCTAssertGreaterThanOrEqual(Palette.contrast(ink, palette.bg), 4.5, palette.name)
            }
        }
        XCTAssertLessThan(Palette.contrast(Palette.latte.yellow, Palette.latte.bg), 3)
        for palette in [Palette.hollr, .hollrLight, .githubLight] {
            for hue in [palette.purple, palette.green, palette.yellow] {
                XCTAssertEqual(Palette.readable(hue, text: palette.fg, on: palette.bg), hue, palette.name)
            }
        }
    }
}

final class RaceTests: XCTestCase {
    /// The chat stream's watchdog must win even when the stream never ends (a half-open connection).
    func testFirstOutcomeWinsWithoutWaitingForTheRest() async {
        let race = Race()
        let hung = Task { try? await Task.sleep(for: .seconds(3600)) }
        Task { race.finish(FollowStalled()) }
        let outcome = await race.wait()
        XCTAssertTrue(outcome is FollowStalled)
        race.finish(nil)
        hung.cancel()
    }

    func testFinishedBeforeWaitReturnsAtOnce() async {
        let race = Race()
        race.finish(nil)
        race.finish(FollowStalled())
        let outcome = await race.wait()
        XCTAssertNil(outcome)
    }
}
