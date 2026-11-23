import XCTest
@testable import Hollr

final class PluginHostTests: XCTestCase {
    private let allow = ["sandcastle"]

    func testIgnoresForeignMessages() {
        XCTAssertNil(PluginHostRequest.parse("hi", allowed: allow))
        XCTAssertNil(PluginHostRequest.parse(["type": "hollr-open-url", "url": "https://x"], allowed: allow))
        XCTAssertNil(PluginHostRequest.parse(["hollr": 1, "type": "servers"], allowed: allow))
        XCTAssertNil(PluginHostRequest.parse(["hollr": 1, "id": "1", "type": "nope"], allowed: allow))
    }

    func testServersAndOpenSession() {
        XCTAssertEqual(PluginHostRequest.parse(["hollr": 1, "id": "1", "type": "servers"], allowed: allow), .servers(id: "1"))
        XCTAssertEqual(PluginHostRequest.parse(["hollr": 1, "type": "open-session", "server": "s", "pane": "w1:p2"], allowed: allow),
                       .openSession(server: "s", pane: "w1:p2"))
        XCTAssertNil(PluginHostRequest.parse(["hollr": 1, "type": "open-session", "server": "s"], allowed: allow))
    }

    func testGateHonoursAllowlistAndObjectStdin() {
        XCTAssertEqual(
            PluginHostRequest.parse(["hollr": 1, "id": "2", "type": "gate", "server": "s", "command": "sandcastle", "stdin": ["op": "x"]],
                                    allowed: allow),
            .gate(id: "2", server: "s", command: "sandcastle", stdin: ["op": "x"]))
        guard case .reject(id: "3", _) = PluginHostRequest.parse(
            ["hollr": 1, "id": "3", "type": "gate", "server": "s", "command": "fs", "stdin": [:] as [String: Any]], allowed: allow)
        else { return XCTFail("fs must be refused") }
        guard case .reject = PluginHostRequest.parse(
            ["hollr": 1, "id": "4", "type": "gate", "server": "s", "command": "sandcastle", "stdin": [1]], allowed: allow)
        else { return XCTFail("array stdin must be refused") }
        guard case .reject = PluginHostRequest.parse(
            ["hollr": 1, "id": "5", "type": "gate", "server": "s", "command": "sandcastle"], allowed: [])
        else { return XCTFail("empty allowlist must refuse") }
    }
}
