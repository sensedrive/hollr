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
            .ask(id: "a1", questions: [AskQuestion(question: "Darf ich **pushen**?", options: ["Ja", "Nein"])],
                 answer: nil, pending: true),
        ], jobs: [], running: false, waiting: false)
        let entry = InboxEntry.make(ref: ref("blocked"), timeline: tl)
        XCTAssertEqual(entry?.kind, .ask)
        XCTAssertEqual(entry?.text, "Darf ich pushen?")
        XCTAssertEqual(entry?.options, ["Ja", "Nein"])
        XCTAssertEqual(entry?.turn, "a1")
    }

    func testSeveralQuestionsOrMultiSelectHaveNoOneTapOptions() {
        let several = Timeline(items: [
            .ask(id: "a1", questions: [AskQuestion(question: "DB?", options: ["SQLite", "Postgres"]),
                                       AskQuestion(question: "Extras?", options: ["Auth"], multi: true)],
                 answer: nil, pending: true),
        ], jobs: [], running: false, waiting: false)
        let entry = InboxEntry.make(ref: ref("blocked"), timeline: several)
        XCTAssertEqual(entry?.kind, .ask)
        XCTAssertEqual(entry?.text, "DB?")
        XCTAssertEqual(entry?.options, [])
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

final class MentionTests: XCTestCase {
    func testFindsFragmentAfterAt() {
        XCTAssertEqual(Mention.find(in: "schau dir @Agent", cursor: nil)?.query, "Agent")
        XCTAssertEqual(Mention.find(in: "@", cursor: nil)?.query, "")
        XCTAssertEqual(Mention.find(in: "in (@src/li", cursor: nil)?.query, "src/li")
        XCTAssertNil(Mention.find(in: "mail an a@b.de", cursor: nil)) // e-mail, not a mention
        XCTAssertNil(Mention.find(in: "@Agent fertig", cursor: nil)) // the word is over
        XCTAssertEqual(Mention.find(in: "@Agent fertig", cursor: 4)?.query, "Age") // cursor inside the word
    }

    func testInsertReplacesFragment() {
        let r = Mention.insert("src/AgentSession.swift", into: "fix @Agse bitte", cursor: 9)
        XCTAssertEqual(r?.text, "fix @src/AgentSession.swift  bitte")
        XCTAssertEqual(r?.cursor, "fix @src/AgentSession.swift ".count)
    }

    @MainActor func testSnippetTitle() {
        XCTAssertEqual(PromptSnippets.title("Mach weiter."), "Mach weiter.")
        XCTAssertEqual(PromptSnippets.title("Lass die Tests laufen und behebe alles"), "Lass die Tests laufen …")
    }
}

final class SharedStorageTests: XCTestCase {
    func testSnapshotAndSharedItemsRoundTrip() throws {
        try XCTSkipIf(SharedKeychain.group == nil, "no team id in this build")
        var snap = WidgetSnapshot()
        snap.agents = [.init(id: "s|w1:p1", fp: "fp", pane: "w1:p1", server: "mac", title: "tendr", agent: "omp", status: "blocked")]
        snap.updated = .now
        snap.save()
        XCTAssertEqual(WidgetSnapshot.load().agents.first?.title, "tendr")
        XCTAssertEqual(WidgetSnapshot.load().waiting, 1)
        let before = SharedItem.pending()
        let item = SharedItem(text: "Schau dir das an", fileName: "a.jpg", file: Data([1, 2, 3]))
        XCTAssertTrue(SharedItem.add(item))
        XCTAssertEqual(SharedItem.pending().last?.file, Data([1, 2, 3]))
        SharedItem.remove(item)
        XCTAssertEqual(SharedItem.pending(), before)
    }
}

final class LimitsTests: XCTestCase {
    func testTwoServersReportTheSameLimitOnce() {
        let caps = [
            UsageCapacity(provider: "anthropic", window: "7d", meter: nil, accounts: 1, used: 0.95),
            UsageCapacity(provider: "anthropic", window: "5h", meter: nil, accounts: 1, used: 0.09),
            UsageCapacity(provider: "openai-codex", window: "5h", meter: nil, accounts: 1, used: 0),
            // the same logins again from the second server
            UsageCapacity(provider: "anthropic", window: "5h", meter: nil, accounts: 1, used: 0.12),
            UsageCapacity(provider: "anthropic", window: "7d", meter: nil, accounts: 1, used: 0.95),
            UsageCapacity(provider: "openai-codex", window: "7d", meter: nil, accounts: 1, used: 0.02),
        ]
        let pooled = DashboardView.pooled(caps)
        XCTAssertEqual(pooled.map { "\($0.provider) \($0.window)" },
                       ["anthropic 5h", "anthropic 7d", "openai-codex 5h", "openai-codex 7d"])
        XCTAssertEqual(pooled.first?.used, 0.12) // the fullest one
    }
}

final class FollowTests: XCTestCase {
    func testAskDetailsDecode() throws {
        let json = #"{"title":null,"items":[{"k":"ask","id":"a","question":"Rebase?","options":["Merge","Rebase"],"pending":true,"header":"Rebase","descriptions":["ein Durchgang",""],"recommended":1}],"jobs":[],"running":false,"waiting":true}"#
        let tl = try JSONDecoder().decode(Timeline.self, from: Data(json.utf8))
        guard case let .ask(_, questions, _, pending) = tl.items.first, let q = questions.first else { return XCTFail("no ask") }
        XCTAssertEqual(questions.count, 1)
        XCTAssertEqual(q.options, ["Merge", "Rebase"])
        XCTAssertTrue(pending)
        XCTAssertEqual(q.recommended, 1)
        XCTAssertEqual(q.header, "Rebase")
        XCTAssertEqual(q.description(0), "ein Durchgang")
        XCTAssertNil(q.description(1))
        XCTAssertFalse(q.multi)
    }

    func testSeveralQuestionsDecodeInOrder() throws {
        let json = #"{"items":[{"k":"ask","id":"a","question":"DB?","options":["SQLite"],"pending":true,"questions":[{"question":"DB?","options":["SQLite"]},{"question":"Extras?","options":["Auth","Cache"],"multi":true}]}],"jobs":[],"running":false,"waiting":true}"#
        let tl = try JSONDecoder().decode(Timeline.self, from: Data(json.utf8))
        guard case let .ask(_, questions, _, _) = tl.items.first else { return XCTFail("no ask") }
        XCTAssertEqual(questions.map(\.question), ["DB?", "Extras?"])
        XCTAssertEqual(questions.map(\.multi), [false, true])
        XCTAssertFalse(questions.answeredByTap)
    }

    func testDeltaMergesByIdInOrder() throws {
        let full = #"{"t":"full","items":[{"k":"text","id":"1","text":"a"},{"k":"text","id":"2","text":"b"}],"jobs":[],"running":true,"waiting":false,"etag":"e1"}"#
        guard case let .full(first) = FollowEvent.decode(Data(full.utf8)) else { return XCTFail("full") }
        let delta = #"{"t":"delta","head":{"jobs":[],"running":false,"waiting":false,"status":"idle"},"order":["2","3"],"items":[{"k":"text","id":"3","text":"c"}],"etag":"e2"}"#
        guard case let .delta(head, order, items) = FollowEvent.decode(Data(delta.utf8)) else { return XCTFail("delta") }
        let merged = FollowEvent.merge(first, head: head, order: order, items: items)
        XCTAssertEqual(merged?.items.map(\.id), ["2", "3"]) // "1" fell out of the window, "3" is new
        XCTAssertEqual(merged?.running, false)
        XCTAssertEqual(merged?.etag, "e2")
        // an id the app doesn't have: nil → reconnect for a full timeline
        XCTAssertNil(FollowEvent.merge(first, head: head, order: ["9"], items: []))
        XCTAssertTrue({ if case .unsupported = FollowEvent.decode(Data(#"{"error":"not_allowed"}"#.utf8)) { return true }; return false }())
    }
}
