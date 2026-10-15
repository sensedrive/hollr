import XCTest
@testable import Hollr

@MainActor
final class DraftTests: XCTestCase {
    private func ref(pane: String = "w1:p1", workspace: String = "tendr", server: Server = .placeholder) -> AgentRef {
        AgentRef(server: server, workspace: workspace, workspaceNumber: 1, tab: "1", tabNumber: 1,
                 pane: Pane(pane: pane, agent: "omp", status: "idle", title: "", cwd: "/tmp", focused: false, live: true))
    }

    private func tempURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("drafts-\(UUID().uuidString).json")
    }

    /// Zen mode and other layouts ask the store again – they must get the same draft with the same text.
    func testSameChatGetsSameDraft() {
        let store = DraftStore(url: nil)
        store.draft(for: ref()).text = "langer Text"
        XCTAssertTrue(store.draft(for: ref()) === store.draft(for: ref()))
        XCTAssertEqual(store.draft(for: ref()).text, "langer Text")
    }

    func testDraftsDoNotMixBetweenChats() {
        let store = DraftStore(url: nil)
        store.draft(for: ref(pane: "w1:p1")).text = "A"
        store.draft(for: ref(pane: "w1:p2")).text = "B"
        // herdr hands out the same pane id again in another workspace
        XCTAssertEqual(store.draft(for: ref(pane: "w1:p1", workspace: "bpg")).text, "")
        let other = Server(label: "mac", user: "m", addresses: [], port: 22, hostFingerprint: "x", deviceId: "d")
        XCTAssertEqual(store.draft(for: ref(pane: "w1:p1", server: other)).text, "")
        XCTAssertEqual(store.draft(for: ref(pane: "w1:p1")).text, "A")
        XCTAssertEqual(store.draft(for: ref(pane: "w1:p2")).text, "B")
    }

    func testSurvivesRestart() {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = DraftStore(url: url)
        store.draft(for: ref()).text = "noch nicht gesendet 👍 äöü"
        store.draft(for: ref(pane: "w2:p1")).text = "zweiter"
        store.save()
        let reopened = DraftStore(url: url)
        XCTAssertEqual(reopened.draft(for: ref()).text, "noch nicht gesendet 👍 äöü")
        XCTAssertEqual(reopened.draft(for: ref(pane: "w2:p1")).text, "zweiter")
    }

    func testSavesShortlyAfterTyping() async throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = DraftStore(url: url)
        store.draft(for: ref()).text = "getippt"
        try await Task.sleep(for: .milliseconds(900))
        XCTAssertEqual(DraftStore(url: url).draft(for: ref()).text, "getippt")
    }

    func testSentDraftIsGoneAfterRestart() {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = DraftStore(url: url)
        let draft = store.draft(for: ref())
        draft.text = "senden"
        store.save()
        draft.clear()
        store.save()
        XCTAssertEqual(DraftStore(url: url).draft(for: ref()).text, "")
    }

    func testOldDraftsExpire() {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = DraftStore(url: url)
        store.draft(for: ref()).text = "alt"
        store.save()
        let later = Date().addingTimeInterval(DraftStore.maxAge + 60)
        XCTAssertEqual(DraftStore(url: url, now: later).draft(for: ref()).text, "")
    }

    /// Dictation finished after the composer was swapped (zen mode): text goes into the draft at the cursor.
    func testDictationInsertsAtCursor() {
        let store = DraftStore(url: nil)
        let draft = store.draft(for: ref())
        draft.text = "Hallo Welt"
        draft.beforeDictation = "Hallo"
        draft.afterDictation = "Welt"
        let settings = DictationSettings()
        let voiceSend = settings.voiceSend, autoSend = settings.autoSend
        settings.voiceSend = false
        settings.autoSend = false
        defer { settings.voiceSend = voiceSend; settings.autoSend = autoSend }
        Composer.insert("schöne", into: draft, settings: settings, session: AgentSession(ref: ref()))
        XCTAssertEqual(draft.text, "Hallo schöne Welt")
        XCTAssertEqual(draft.cursor, "Hallo schöne".count)
        // nothing recognised: the typed text stays
        draft.beforeDictation = draft.text
        draft.afterDictation = ""
        Composer.insert("", into: draft, settings: settings, session: AgentSession(ref: ref()))
        XCTAssertEqual(draft.text, "Hallo schöne Welt")
    }
}

final class DictationTextTests: XCTestCase {
    func testHallucinationsAreDropped() {
        XCTAssertEqual(DictationText.dropHallucinations("Untertitel im Auftrag des ZDF, 2021"), "")
        XCTAssertEqual(DictationText.dropHallucinations("Bitte prüf den Build."), "Bitte prüf den Build.")
    }

    func testFillers() {
        XCTAssertEqual(DictationText.dropFillers("Ähm, bitte äh prüf das.", language: "de"), "Bitte prüf das.")
        // "um" is a German word
        XCTAssertEqual(DictationText.dropFillers("Es geht um den Test", language: "de"), "Es geht um den Test")
    }

    func testTickets() {
        let prefixes = DictationText.ticketPrefixes(in: ["TENDR-725", "Swift"])
        XCTAssertEqual(prefixes, ["TENDR"])
        XCTAssertEqual(DictationText.formatTickets("schau dir tendr 745 an", prefixes: prefixes), "schau dir TENDR-745 an")
        XCTAssertEqual(DictationText.formatTickets("Tendr minus 12", prefixes: prefixes), "TENDR-12")
    }

    func testVoiceSend() {
        XCTAssertEqual(DictationText.voiceSend("Bitte keine anderen Dateien ändern, senden.").text, "Bitte keine anderen Dateien ändern")
        XCTAssertTrue(DictationText.voiceSend("Mach weiter und schick es ab").send)
        XCTAssertFalse(DictationText.voiceSend("Kannst du die Mail senden lassen?").send)
        XCTAssertFalse(DictationText.voiceSend("senden").send) // nothing left to send
    }

    func testSilenceTrim() {
        XCTAssertNil(Silence.trim([Float](repeating: 0, count: 16_000)))
        var samples = [Float](repeating: 0.001, count: 32_000)
        for i in 12_000..<20_000 { samples[i] = sin(Float(i) * 0.1) * 0.3 }
        let trimmed = Silence.trim(samples)
        XCTAssertNotNil(trimmed)
        // 0.5 s speech + 250 ms padding on each side (whole 20 ms frames) instead of 2 s
        XCTAssertLessThan(trimmed?.count ?? .max, 17_000)
    }
}
