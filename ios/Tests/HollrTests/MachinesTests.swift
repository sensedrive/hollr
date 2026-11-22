import XCTest
@testable import Hollr

final class MachinesTests: XCTestCase {
    private func machine(_ fp: String, _ at: Double, removed: Bool = false, label: String = "m") -> Machine {
        Machine(fp: fp, label: label, addresses: ["10.0.0.1"], port: 22, user: "martin", updatedAt: at,
                removed: removed ? true : nil)
    }

    private func server(_ fp: String, _ at: Double?) -> Server {
        var server = Server(label: fp, user: "martin", addresses: ["10.0.0.1"], port: 22, hostFingerprint: fp, deviceId: "d")
        server.updatedAt = at
        return server
    }

    func testUnionKeepsTheNewestPerMachine() {
        let union = Machines.union([
            [machine("a", 5, label: "old"), machine("b", 1)],
            [machine("a", 9, label: "new"), machine("c", 3)],
            [machine("a", 9, label: "same time, later")],
        ])
        XCTAssertEqual(union.map(\.fp), ["a", "b", "c"])
        XCTAssertEqual(union.first?.label, "new")
    }

    func testARemovalElsewhereRemovesAnOlderRecordHere() {
        let union = [machine("a", 10, removed: true), machine("b", 10, removed: true), machine("c", 10)]
        let servers = [server("a", 5), server("b", 20), server("c", 1), server("d", nil)]
        let gone = Machines.toRemove(union, servers: servers)
        XCTAssertEqual(gone.map(\.server.hostFingerprint), ["a"]) // b was paired again after the removal
        XCTAssertEqual(gone.first?.at, 10)
    }

    func testMissingAreAliveUnpairedAndNotRemovedHereLater() {
        let union = [machine("a", 5), machine("b", 5), machine("c", 5, removed: true), machine("d", 5)]
        let tombstones = [machine("d", 7, removed: true)]
        let missing = Machines.missing(union, servers: [server("a", 1)], tombstones: tombstones)
        XCTAssertEqual(missing.map(\.fp), ["b"])
        // an older tombstone here doesn't keep it away
        XCTAssertEqual(Machines.missing([machine("d", 9)], servers: [], tombstones: tombstones).map(\.fp), ["d"])
    }

    func testAnswersOthersRequestsForMachinesPairedHereOnce() {
        let requests = [
            PairRequest(fp: "a", install: "other", name: "Mac", at: 1),
            PairRequest(fp: "a", install: "me", name: "iPhone", at: 1),
            PairRequest(fp: "z", install: "other", name: "Mac", at: 1),
            PairRequest(fp: "b", install: "other", name: "Mac", at: 2),
        ]
        let done: Set<String> = [Machines.answerKey(requests[3])]
        let answer = Machines.toAnswer(requests, install: "me", paired: ["a", "b"], done: done)
        XCTAssertEqual(answer.map(\.fp), ["a"])
    }

    func testRequestsAtMostEveryTwoMinutes() {
        let now = Date()
        XCTAssertTrue(Machines.requestDue(nil, now: now))
        XCTAssertFalse(Machines.requestDue(now.addingTimeInterval(-60), now: now))
        XCTAssertTrue(Machines.requestDue(now.addingTimeInterval(-121), now: now))
    }

    func testMergeOnlyWhenTheServerLacksSomething() throws {
        let doc = try JSONDecoder().decode(MachinesDoc.self, from: Data(#"""
        {"machines":[{"fp":"a","label":"m","addresses":[],"port":22,"user":"u","updatedAt":5}],"requests":[],
         "prefs":{"snippets":{"value":["x"],"updatedAt":3}}}
        """#.utf8))
        let prefs = Prefs(snippets: Pref(value: ["x"], updatedAt: 3), vocabulary: nil)
        XCTAssertFalse(Machines.needsMerge([machine("a", 5)], prefs: prefs, server: doc))
        XCTAssertTrue(Machines.needsMerge([machine("a", 6)], prefs: prefs, server: doc))
        XCTAssertTrue(Machines.needsMerge([machine("b", 1)], prefs: prefs, server: doc))
        XCTAssertTrue(Machines.needsMerge([], prefs: Prefs(snippets: nil, vocabulary: Pref(value: "v", updatedAt: 1)), server: doc))
        XCTAssertTrue(Machines.needsMerge([], prefs: Prefs(), server: nil))
    }

    func testPrefsNewestWinsAndAnUntouchedLocalValueGivesWay() {
        let local = Pref(value: ["mine"], updatedAt: 10)
        XCTAssertEqual(Machines.adopts(local: local, remote: Pref(value: ["theirs"], updatedAt: 20))?.value, ["theirs"])
        XCTAssertNil(Machines.adopts(local: local, remote: Pref(value: ["theirs"], updatedAt: 5)))
        XCTAssertNil(Machines.adopts(local: local, remote: nil))
        // never edited here: whatever a server has wins, even with the same stamp
        XCTAssertEqual(Machines.adopts(local: Pref(value: "default", updatedAt: 1), remote: Pref(value: "desk", updatedAt: 1))?.value, "desk")
        XCTAssertNil(Machines.adopts(local: Pref(value: "same", updatedAt: 1), remote: Pref(value: "same", updatedAt: 9)))
        let union = Machines.union(prefs: [
            Prefs(snippets: Pref(value: ["a"], updatedAt: 2), vocabulary: nil),
            Prefs(snippets: Pref(value: ["b"], updatedAt: 4), vocabulary: Pref(value: "v", updatedAt: 1)),
        ])
        XCTAssertEqual(union.snippets?.value, ["b"])
        XCTAssertEqual(union.vocabulary?.value, "v")
    }

    func testRecordsAndTombstonesEncodeAsTheServerExpects() throws {
        var gone = Machine(server: server("a", nil))
        XCTAssertEqual(gone.updatedAt, 1) // never stamped: older than anything another app did
        gone.removed = true
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(gone)) as? [String: Any])
        XCTAssertEqual(json["fp"] as? String, "a")
        XCTAssertEqual(json["removed"] as? Bool, true)
        XCTAssertNil(try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(machine("b", 2))) as? [String: Any])["removed"])
    }

    @MainActor func testStoreStampsOldRecordsAndKeepsTombstones() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try JSONEncoder().encode([server("a", nil)]).write(to: dir.appendingPathComponent("servers.json"))
        let store = ServerStore(directory: dir)
        XCTAssertEqual(store.servers.first?.updatedAt, 1)
        store.remove(store.servers[0])
        XCTAssertEqual(store.tombstones.map(\.fp), ["a"])
        XCTAssertEqual(ServerStore(directory: dir).tombstones.first?.isRemoved, true)
        store.add(server("a", nil)) // paired again: the tombstone goes, the record is newer
        XCTAssertTrue(store.tombstones.isEmpty)
        XCTAssertGreaterThan(store.servers.first?.updatedAt ?? 0, 1)
    }
}
