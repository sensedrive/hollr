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
}
