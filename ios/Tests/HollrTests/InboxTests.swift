import XCTest
@testable import Hollr

final class InboxTests: XCTestCase {
    private func ref(_ status: String, agent: String? = "omp") -> AgentRef {
        AgentRef(server: .placeholder, workspace: "tendr", workspaceNumber: 1, tab: "Tickets", tabNumber: 1,
                 pane: Pane(pane: "w1:p1", agent: agent, status: status, title: "", cwd: "/tmp", focused: false, live: true))
    }

    func testPendingQuestionBecomesAskWithOptions() {
        let tl = Timeline(items: [
            .text(id: "t1", text: "Ich bin fast fertig."),
            .ask(id: "a1", question: "Darf ich **pushen**?", options: ["Ja", "Nein"], answer: nil, pending: true),
        ], jobs: [], running: false, waiting: false)
        let entry = InboxEntry.make(ref: ref("blocked"), timeline: tl)
        XCTAssertEqual(entry?.kind, .ask)
        XCTAssertEqual(entry?.text, "Darf ich pushen?")
        XCTAssertEqual(entry?.options, ["Ja", "Nein"])
        XCTAssertEqual(entry?.turn, "a1")
    }

    func testWaitingWithoutQuestionShowsLastWords() {
        let tl = Timeline(items: [.text(id: "t1", text: "Soll ich weitermachen?")], jobs: [], running: false, waiting: false)
        let entry = InboxEntry.make(ref: ref("blocked"), timeline: tl)
        XCTAssertEqual(entry?.kind, .waiting)
        XCTAssertEqual(entry?.text, "Soll ich weitermachen?")
    }

    func testDoneAndError() {
        let ok = Timeline(items: [.text(id: "t", text: "Alles grün."), .end(id: "e1", ms: 1000, status: "done", error: nil)],
                          jobs: [], running: false, waiting: false)
        XCTAssertEqual(InboxEntry.make(ref: ref("done"), timeline: ok)?.kind, .done)
        XCTAssertEqual(InboxEntry.make(ref: ref("done"), timeline: ok)?.text, "Alles grün.")
        let failed = Timeline(items: [.end(id: "e2", ms: 1000, status: "error", error: "rate limit")],
                              jobs: [], running: false, waiting: false)
        XCTAssertEqual(InboxEntry.make(ref: ref("done"), timeline: failed)?.kind, .error)
        XCTAssertEqual(InboxEntry.make(ref: ref("done"), timeline: failed)?.text, "rate limit")
    }

    func testWorkingAndIdleAreNotInTheInbox() {
        XCTAssertNil(InboxEntry.make(ref: ref("working"), timeline: nil))
        XCTAssertNil(InboxEntry.make(ref: ref("idle"), timeline: nil))
        // other agents (no timeline) still show up when they wait
        XCTAssertEqual(InboxEntry.make(ref: ref("blocked", agent: "claude"), timeline: nil)?.kind, .waiting)
    }

    func testLinks() {
        let url = HollrLink.open(fp: "SHA256:a+b/c", pane: "w1:p1")!
        let parsed = HollrLink.parseOpen(url)
        XCTAssertEqual(parsed?.fp, "SHA256:a+b/c")
        XCTAssertEqual(parsed?.pane, "w1:p1")
        XCTAssertNil(HollrLink.parseOpen(URL(string: "hollr://pair?c=abc")!))
    }
}
