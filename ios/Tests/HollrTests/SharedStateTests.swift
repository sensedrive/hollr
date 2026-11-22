import XCTest
@testable import Hollr

final class SharedStateTests: XCTestCase {
    private func pane(_ status: String, id: String = "w1:p1", since: Double? = 1000, agent: String? = "omp") -> Pane {
        Pane(pane: id, agent: agent, status: status, title: "", cwd: "/tmp", focused: false, live: false, since: since)
    }

    func testDecodesTheServersDocAndToleratesMissingKeys() throws {
        let json = #"{"seen":{"w1:p1":5},"dismissed":{},"unread":{"w1:p2":true},"hiddenLong":{"w1:p3":7},"mySessions":["w1:p1"],"spaceOrder":["w2","w1"],"worktreeOrder":{"w1":["w3"]},"tabOrder":{"w1":["t2","t1"]}}"#
        let doc = try JSONDecoder().decode(SharedState.self, from: Data(json.utf8))
        XCTAssertEqual(doc.seen["w1:p1"], 5)
        XCTAssertTrue(doc.isUnread("w1:p2"))
        XCTAssertEqual(doc.spaceOrder, ["w2", "w1"])
        XCTAssertEqual(doc.tabOrder["w1"], ["t2", "t1"])
        XCTAssertEqual(try JSONDecoder().decode(SharedState.self, from: Data(#"{"seen":{}}"#.utf8)), SharedState())
    }

    func testChangesApplyLikeTheServer() {
        let doc = SharedState().applying([
            .seen("w1:p1", 10), .unread("w1:p2", true), .mySessions(["w1:p2", "w1:p1", "w1:p2"]),
            SharedChange(path: ["tabOrder", "w1"], value: .ids(["t1"])),
        ])
        XCTAssertEqual(doc.seen["w1:p1"], 10)
        XCTAssertTrue(doc.isUnread("w1:p2"))
        XCTAssertEqual(doc.mySessions, ["w1:p2", "w1:p1"]) // each id once
        XCTAssertEqual(doc.tabOrder["w1"], ["t1"])
        let removed = doc.applying([.unread("w1:p2", false), SharedChange(path: ["mySessions"], value: .remove)])
        XCTAssertFalse(removed.isUnread("w1:p2"))
        XCTAssertEqual(removed.mySessions, [])
        XCTAssertEqual(doc.applying([.seen("w1:p1", 10)]), doc) // equal → nothing to send
    }

    func testChangeJSONMatchesTheContract() throws {
        let data = try JSONSerialization.data(withJSONObject: [SharedChange.unread("w1:p1", false).json, SharedChange.unread("w1:p1", true).json])
        let back = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertEqual(back[0]["path"] as? [String], ["unread", "w1:p1"])
        XCTAssertTrue(back[0]["value"] is NSNull)
        XCTAssertEqual(back[1]["value"] as? Bool, true)
    }

    func testCardKeyIsPaneAtSince() {
        let ref = AgentRef(server: .placeholder, workspace: "x", workspaceNumber: 1, tab: "1", tabNumber: 1,
                           pane: pane("done", since: 1_763_800_000_123))
        XCTAssertEqual(InboxEntry.key(ref), "w1:p1@1763800000123")
    }

    func testSeenResultIsQuietUntilTheNextStatus() {
        var doc = SharedState()
        XCTAssertEqual(doc.shownStatus(pane("done")), "done")
        XCTAssertFalse(doc.hidesCard(.done, of: pane("done")))
        doc.seen["w1:p1"] = 1000
        XCTAssertEqual(doc.shownStatus(pane("done")), "idle")
        XCTAssertTrue(doc.hidesCard(.done, of: pane("done")))
        XCTAssertTrue(doc.hidesCard(.error, of: pane("done")))
        // a new status (new since) is a new result
        XCTAssertEqual(doc.shownStatus(pane("done", since: 2000)), "done")
        XCTAssertFalse(doc.hidesCard(.done, of: pane("done", since: 2000)))
        // a question still waits, however long it was looked at
        XCTAssertFalse(doc.hidesCard(.ask, of: pane("blocked")))
        XCTAssertEqual(doc.shownStatus(pane("blocked")), "blocked")
        // without since (not stamped yet) nothing counts as seen
        XCTAssertFalse(doc.resultSeen(pane("done", since: nil)))
    }

    func testDismissedHidesOnlyThatStatus() {
        var doc = SharedState()
        doc.dismissed["w1:p1"] = 1000
        XCTAssertTrue(doc.hidesCard(.ask, of: pane("blocked")))
        XCTAssertFalse(doc.hidesCard(.ask, of: pane("blocked", since: 2000)))
    }

    func testUnreadShowsAsNewResultUntilOpened() {
        var doc = SharedState()
        doc.seen["w1:p1"] = 1000
        doc.dismissed["w1:p1"] = 1000
        doc.unread["w1:p1"] = true
        XCTAssertEqual(doc.shownStatus(pane("done")), "done")
        XCTAssertFalse(doc.hidesCard(.done, of: pane("done")))
        // herdr calls it ready: still a new result here
        XCTAssertEqual(doc.shownStatus(pane("idle")), "done")
        XCTAssertEqual(doc.inboxStatus(pane("idle")), "done")
        XCTAssertNil(SharedState().inboxStatus(pane("idle")))
        XCTAssertNil(doc.inboxStatus(pane("working")))
        XCTAssertEqual(doc.shownStatus(pane("working")), "working")
        // a shell has no result
        XCTAssertEqual(doc.shownStatus(pane("idle", agent: nil)), "idle")
    }

    func testUnreadIdleBecomesADoneCard() {
        let ref = AgentRef(server: .placeholder, workspace: "x", workspaceNumber: 1, tab: "1", tabNumber: 1,
                           pane: pane("idle", agent: "claude"))
        XCTAssertNil(InboxEntry.make(ref: ref, timeline: nil))
        XCTAssertEqual(InboxEntry.make(ref: ref, timeline: nil, status: "done")?.kind, .done)
    }

    func testMySessionsMovesToTheFront() {
        XCTAssertEqual(MySessions.touching(["a", "b", "c"], "c"), ["c", "a", "b"])
        XCTAssertEqual(MySessions.touching(["a", "b"], "a"), ["a", "b"])
        let long = (0..<70).map { "p\($0)" }
        XCTAssertEqual(MySessions.touching(long, "new").count, MySessions.max)
    }
}

final class SharedOrderTests: XCTestCase {
    private func space(_ id: String, _ label: String, worktree: Bool = false) -> Space {
        Space(id: id, label: label, number: 1, focused: false, status: "idle", root: "/\(id)", repo: "r",
              isWorktree: worktree, git: nil, paneCount: 1)
    }

    func testSavedOrderFirstTheRestInTheirOwnOrder() {
        let tabs = ["t1", "t2", "t3", "t4"]
        XCTAssertEqual(SharedOrder.ordered(tabs, saved: ["t3", "gone", "t1"]) { $0 }, ["t3", "t1", "t2", "t4"])
        XCTAssertEqual(SharedOrder.ordered(tabs, saved: nil) { $0 }, tabs)
        XCTAssertEqual(SharedOrder.ordered(tabs, saved: []) { $0 }, tabs)
    }

    func testSeveralPanesOfOneTabKeepTheirOrder() {
        let panes = [("t1", "a"), ("t2", "b"), ("t1", "c")]
        XCTAssertEqual(SharedOrder.ordered(panes, saved: ["t2", "t1"]) { $0.0 }.map(\.1), ["b", "a", "c"])
    }

    func testWorktreesSavedFirstTheRestByName() {
        let trees = [space("w4", "zeta", worktree: true), space("w3", "alpha", worktree: true), space("w5", "mid", worktree: true)]
        XCTAssertEqual(SharedOrder.worktrees(trees, saved: ["w5"]).map(\.id), ["w5", "w3", "w4"])
        XCTAssertEqual(SharedOrder.worktrees(trees, saved: nil).map(\.id), ["w3", "w5", "w4"])
    }

    func testGroupsInDraggedOrderWithTheirWorktrees() {
        let all = [space("w1", "repo"), space("w2", "wt-b", worktree: true), space("w3", "wt-a", worktree: true),
                   Space(id: "w9", label: "solo", number: 2, focused: false, status: "idle", root: "/w9", repo: nil,
                         isWorktree: false, git: nil, paneCount: 1)]
        var doc = SharedState()
        doc.spaceOrder = ["w9"]
        doc.worktreeOrder["w1"] = ["w2"]
        let groups = SharedOrder.groups(SpacesView.group(all), in: doc)
        XCTAssertEqual(groups.map(\.key), ["w9", "w1"])
        XCTAssertEqual(groups[1].spaces.map(\.id), ["w1", "w2", "w3"])
        // nothing saved: server order, worktrees by name
        XCTAssertEqual(SharedOrder.groups(SpacesView.group(all), in: nil)[0].spaces.map(\.id), ["w1", "w3", "w2"])
    }
}
