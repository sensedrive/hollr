import AVFoundation
import Citadel
import Foundation
import NIOCore
import Observation

struct TranscriptItem: Identifiable, Equatable {
    enum Kind: Equatable { case voice, typed, tool, agent, info }
    let id = UUID()
    let kind: Kind
    var text: String
    var final = true
    /// a typed prompt that didn't reach the server (no connection): shown as such, can be sent again
    var failed = false
}

/// Conversation with one agent pane: history from the omp session log, typed prompts,
/// and (for omp) a live voice call. Kept alive by `SessionStore` while you navigate around –
/// a live call keeps running in the background until you end it.
@MainActor
@Observable
final class AgentSession {
    enum Phase: Equatable {
        case idle, connecting, live, ending
        case failed(String)
    }

    private(set) var ref: AgentRef
    private(set) var phase: Phase = .idle
    private(set) var items: [TranscriptItem] = []
    private(set) var agentStatus: String
    /// omp's own live state from its footer: listening, speaking, working, muted …
    private(set) var ompState: String?
    private(set) var inputLevel: Float = 0
    private(set) var outputLevel: Float = 0
    private(set) var historyLoaded = false
    /// Rich omp timeline (turns, tools, todo, jobs) – the main view for omp agents.
    private(set) var timeline: Timeline?

    var usesTimeline: Bool { ref.pane.agent == "omp" }

    // MARK: polling – cheap when nothing changes, fast while omp works, paused while you dictate

    /// set by the composer while dictating: the transcription gets the CPU, the chat waits
    var dictating = false
    @ObservationIgnored private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    /// How long until the next refresh.
    var pollInterval: Duration {
        if dictating { return .seconds(8) }
        if !usesTimeline { return .seconds(3) }
        let busy = timeline?.running == true || agentStatus == "working" || agentStatus == "blocked"
        return busy ? .milliseconds(1500) : .seconds(5)
    }

    /// Waits for the next poll – or less, when `nudge()` says something just happened.
    /// Every waiter has its own slot: two views polling the same session (a sheet over the list)
    /// must not wake each other up in a loop.
    func waitForPoll() async {
        let interval = pollInterval
        let id = UUID()
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            waiters[id] = cont
            // strong self: at most one poll interval, and the continuation is always resumed
            Task { @MainActor in
                try? await Task.sleep(for: interval)
                self.waiters.removeValue(forKey: id)?.resume()
            }
        }
    }

    /// Refresh now (after sending, answering, or a change from the live feed).
    func nudge() {
        let all = waiters
        waiters = [:]
        for cont in all.values { cont.resume() }
    }

    /// The chat as a stream (`gate follow`): changes arrive the moment omp writes them, a few KB
    /// each, instead of a poll every 1.5 s. Returns false when the server is too old (poll then).
    func follow() async -> Bool {
        guard usesTimeline else { return false }
        #if DEBUG
        if DemoMode.isDemo(ref.server) { return false } // demo answers polls only
        #endif
        let pane = ref.pane.pane
        let server = ref.server
        let heard = Clock()
        let unsupported = Flag()
        // the connection this stream ran on: only that one is dropped when it fails
        var used: SSHClient?
        do {
            let client = try await SSHPool.shared.client(for: server)
            used = client
            let race = Race()
            let stream = Task {
                do {
                    try await self.stream(client, pane: pane, heard: heard, unsupported: unsupported)
                    race.finish(nil)
                } catch {
                    race.finish(error)
                }
            }
            let watchdog = Task { await Self.watch(heard, pane: pane, race: race) }
            // the race, not the stream: on a half-open connection ending the stream waits for a channel close that
            // never comes – the chat would sit on its skeleton until the view goes away
            let outcome = await withTaskCancellationHandler {
                await race.wait()
            } onCancel: {
                race.finish(CancellationError())
            }
            watchdog.cancel()
            switch outcome {
            case is FollowStalled:
                stream.cancel()
                // closing the connection ends the hung stream too; the next try connects fresh
                await SSHPool.shared.invalidate(server, ifStill: client)
            case let error?:
                stream.cancel()
                throw error
            case nil:
                break
            }
        } catch is CancellationError {
        } catch {
            HollrLog.error("follow \(pane): \(error)")
            // nothing shown yet: say why, instead of a skeleton without end
            if timeline == nil, !Task.isCancelled { loadError = Self.describe(error) }
            if HollrError.isTransport(error) {
                // the pool may hold a fresh connection by now (its idle check replaced this one): a prompt on it
                // would fail if the dead stream took it down too
                if let used { await SSHPool.shared.invalidate(server, ifStill: used) } else { await SSHPool.shared.invalidate(server) }
            }
        }
        return !unsupported.value
    }

    /// Reads `follow` until it ends; sets `unsupported` for a server without it.
    private func stream(_ client: SSHClient, pane: String, heard: Clock, unsupported: Flag) async throws {
        try await client.withExec("follow \(pane) 150") { inbound, _ in
            var buffer = Data()
            for try await output in inbound {
                guard case .stdout(let bytes) = output else { continue }
                heard.touch()
                buffer.append(contentsOf: bytes.readableBytesView)
                while let nl = buffer.firstIndex(of: 0x0a) {
                    let line = Data(buffer[buffer.startIndex..<nl])
                    buffer.removeSubrange(buffer.startIndex...nl)
                    // decoding a full timeline (~100 KB) stays off the main thread
                    let event = await Task.detached(priority: .userInitiated) { FollowEvent.decode(line) }.value
                    switch event {
                    case .unsupported:
                        unsupported.value = true
                        return
                    case .gone:
                        self.loadError = String(localized: "Die Session gibt es nicht mehr.")
                        self.historyLoaded = true
                        return
                    case let .full(timeline):
                        self.apply(timeline)
                    case let .delta(head, order, items):
                        // an id we don't have (gap): reconnect for a full one
                        guard let merged = FollowEvent.merge(self.timeline, head: head, order: order, items: items) else { return }
                        self.apply(merged)
                    case .broken:
                        // skipping it would keep what it changed stale until that item changes again
                        if self.timeline == nil {
                            self.loadError = String(localized: "Der Chat ließ sich nicht lesen. Hollr auf dem Server und hier aktualisieren.")
                        }
                        return
                    case .other:
                        break
                    }
                }
            }
        }
    }

    /// Ends the race with `FollowStalled` once the stream is dead. The server answers at once with the whole
    /// chat and pings every 20 s; buffered pings arrive the moment the app is back or the network settled.
    private static func watch(_ heard: Clock, pane: String, race: Race) async {
        let opened = Date()
        var generation = NetworkWatch.shared.generation
        var recheck: Date?
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            // suspended: nothing can arrive, and coming back bumps the generation
            guard NetworkWatch.shared.active else { continue }
            if NetworkWatch.shared.generation != generation {
                generation = NetworkWatch.shared.generation
                recheck = Date().addingTimeInterval(3)
            }
            let dead: Bool
            if !heard.any {
                dead = Date().timeIntervalSince(opened) > 10
            } else if let at = recheck, Date() >= at {
                recheck = nil
                dead = heard.age > 25
            } else {
                dead = heard.age > 55
            }
            if dead {
                HollrLog.error("follow \(pane): nothing for \(Int(heard.any ? heard.age : Date().timeIntervalSince(opened)))s – reconnecting")
                race.finish(FollowStalled())
                return
            }
        }
    }

    /// A fresh timeline from the stream or a poll.
    private func apply(_ fresh: Timeline) {
        if fresh != timeline { timeline = fresh }
        if let status = fresh.status, !isLive { agentStatus = status }
        // typed prompts that now show up in the log are no longer "pending". Each log entry settles one prompt, and
        // only entries that weren't there when it was sent count: an earlier "weiter" doesn't settle a new one.
        let users = fresh.items.compactMap { item -> (id: String, text: String)? in
            if case let .user(id, text, _, _) = item { return (id, text.trimmingCharacters(in: .whitespacesAndNewlines)) }
            return nil
        }
        var claimed = Set<String>()
        var landed = Set<UUID>()
        for sent in items where sent.kind == .typed && !sent.final {
            let before = usersBefore[sent.id] ?? []
            guard let entry = users.first(where: { $0.text == sent.text && !before.contains($0.id) && !claimed.contains($0.id) })
            else { continue }
            claimed.insert(entry.id)
            landed.insert(sent.id)
            usersBefore[sent.id] = nil
        }
        if !landed.isEmpty {
            items.removeAll { landed.contains($0.id) }
            notSentSettled()
        }
        historyLoaded = true
        loadError = nil
    }

    func loadTimeline() async {
        guard usesTimeline else { return }
        do {
            guard let fresh = try await HollrClient.timeline(ref.server, pane: ref.pane.pane, etag: timeline?.etag) else {
                historyLoaded = true
                loadError = nil
                return // unchanged
            }
            apply(fresh)
        } catch {
            HollrLog.error("timeline \(ref.pane.pane): \(error)")
            loadError = error.localizedDescription
            historyLoaded = true
            // a closed pane or herdr error is an answer – reconnecting would only tear down the feed
            if HollrError.isTransport(error) { await SSHPool.shared.invalidate(ref.server) }
        }
    }

    /// Answers omp's question `ask` – one pick per question. false: not sent (`lastError` says why).
    @discardableResult
    func answer(ask: String, picks: [AskPick]) async -> Bool {
        do {
            try await HollrClient.answer(ref.server, pane: ref.pane.pane, ask: ask, picks: picks)
            actionWorked()
            nudge()
            return true
        } catch {
            lastError = String(localized: "Antwort nicht gesendet: \(error.localizedDescription)")
            return false
        }
    }

    /// omp waits on a question shown in the chat: typed text answers it instead of starting a turn.
    private var asking: Bool {
        timeline?.items.contains { if case .ask(_, _, _, true) = $0 { true } else { false } } == true
    }

    /// Terminal screen – shown for agents without a parsed chat (Claude …) and while one waits for you.
    private(set) var screen = ""

    var showsScreen: Bool { ref.pane.agent != "omp" || agentStatus == "blocked" }

    func loadScreen() async {
        guard showsScreen else { screen = ""; return }
        let lines = ref.pane.agent == nil ? 80 : 40
        if let text = try? await HollrClient.screen(ref.server, pane: ref.pane.pane, lines: lines) {
            screen = Self.cleanScreen(text)
        }
    }

    /// Drops box-drawing frames and status bars so the screen reads well on a phone.
    static func cleanScreen(_ text: String) -> String {
        text.components(separatedBy: "\n")
            .map { line in
                var l = line
                for ch in ["│", "┃", "╭", "╮", "╰", "╯"] { l = l.replacingOccurrences(of: ch, with: "") }
                // Nerd-Font / powerline glyphs (private use area) have no iOS font – drop them
                l = String(String.UnicodeScalarView(l.unicodeScalars.filter { s in
                    !((0xE000...0xF8FF).contains(s.value) || s.value >= 0xF0000)
                }))
                return l.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
            }
            .filter { line in
                let t = line.trimmingCharacters(in: .whitespaces)
                return !t.isEmpty && !t.allSatisfy { "─━═-".contains($0) }
            }
            .joined(separator: "\n")
    }
    /// What went wrong with something you did (send, answer, keys). Stays until the next action works – a chat
    /// refresh no longer wipes it a second later, before you could read it. The live call has its own (`callError`).
    private(set) var lastError: String?
    /// Why the chat doesn't load or update (stream, poll, history); cleared by the next good refresh.
    private(set) var loadError: String?

    private func actionWorked() {
        lastError = nil
        notSent = nil
    }

    /// The "Nicht gesendet" text in `lastError` belongs to the failed messages: once none is left (it arrived
    /// after all, or was discarded) it would only contradict the chat.
    private func notSentSettled() {
        guard let notSent, !items.contains(where: \.failed) else { return }
        if lastError == notSent { lastError = nil }
        self.notSent = nil
    }

    /// Why the live call failed – its own error: a failed answer during the call must not turn a call that
    /// ended normally into a failed one, nor hide why the connection dropped.
    @ObservationIgnored private var callError: String?
    @ObservationIgnored private var notSent: String?

    private var task: Task<Void, Never>?
    private var outgoing: AsyncStream<Data>.Continuation?
    private let voice = VoiceIO()
    private var finished = false
    /// per typed prompt, what the log already held with its text when it was sent – that doesn't settle it.
    /// omp's timeline: those entries' ids · other agents' history (no ids): how many there were
    @ObservationIgnored private var usersBefore: [UUID: Set<String>] = [:]
    @ObservationIgnored private var typedBefore: [UUID: Int] = [:]

    init(ref: AgentRef) {
        self.ref = ref
        self.agentStatus = ref.pane.status
    }

    var isLive: Bool { phase == .connecting || phase == .live || phase == .ending }
    var muted: Bool { ompState == "muted" }
    /// Speaker off (you still talk, omp keeps working – you just don't hear it)
    var speakerMuted = false {
        didSet { voice.outputMuted = speakerMuted }
    }
    var canLive: Bool { ref.pane.live }

    func update(_ ref: AgentRef) {
        self.ref = ref
        if !isLive { agentStatus = ref.pane.status }
    }

    // MARK: History

    /// Reloads the conversation from the server (skipped while live – the live stream is newer).
    func loadHistory() async {
        guard ref.pane.agent != nil, !usesTimeline, !(isLive && historyLoaded) else { return }
        do {
            let events = try await HollrClient.history(ref.server, pane: ref.pane.pane)
            var fresh: [TranscriptItem] = []
            for event in events { Self.append(event, to: &fresh) }
            if isLive {
                // call started before the first load: put the older conversation in front
                let liveSigs = Set(items.map { "\($0.kind)|\($0.text)" })
                items = fresh.filter { !liveSigs.contains("\($0.kind)|\($0.text)") } + items
                historyLoaded = true
                return
            }
            // typed prompts not in the log yet stay visible, and so do messages that didn't go out (with their
            // "Erneut senden") – the same items, so a failing send still finds its message by id. Each log entry
            // settles one prompt, and only entries beyond those there were when it was sent: an earlier "weiter"
            // doesn't settle (and drop) a new one.
            var logged: [String: Int] = [:]
            for item in fresh where item.kind == .typed {
                logged[item.text.trimmingCharacters(in: .whitespacesAndNewlines), default: 0] += 1
            }
            var settled = false
            for sent in items where sent.kind == .typed && !sent.final {
                let count = logged[sent.text] ?? 0
                // older ones that left the window (the last 80 events) no longer count
                let before = min(typedBefore[sent.id] ?? 0, count)
                if count > before {
                    logged[sent.text] = count - 1
                    typedBefore[sent.id] = nil
                    settled = true
                } else {
                    typedBefore[sent.id] = before
                    fresh.append(sent)
                }
            }
            let signature = { (list: [TranscriptItem]) in list.map { "\($0.kind)|\($0.text)|\($0.final)|\($0.failed)" } }
            if signature(fresh) != signature(items), !(fresh.isEmpty && !items.isEmpty) { items = fresh }
            if settled { notSentSettled() }
            historyLoaded = true
            loadError = nil
        } catch {
            HollrLog.error("history \(ref.pane.pane): \(error)")
            loadError = error.localizedDescription
            historyLoaded = true
        }
    }

    private static func append(_ event: LiveEvent, to items: inout [TranscriptItem]) {
        switch event {
        case let .delegation(text): items.append(TranscriptItem(kind: .voice, text: text))
        case let .user(text): items.append(TranscriptItem(kind: .typed, text: text))
        case let .tool(name, intent): items.append(TranscriptItem(kind: .tool, text: intent.map { "\(name) · \($0)" } ?? name))
        case let .answer(text, final): items.append(TranscriptItem(kind: .agent, text: text, final: final))
        default: break
        }
    }

    // MARK: Typing

    func sendText(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if ref.pane.agent == nil {
            // plain terminal: run the command, the screen shows the result
            Task {
                do {
                    try await HollrClient.prompt(ref.server, pane: ref.pane.pane, text: trimmed)
                    actionWorked()
                    try? await Task.sleep(for: .milliseconds(400))
                    await loadScreen()
                } catch {
                    lastError = String(localized: "Senden fehlgeschlagen: \(error.localizedDescription)")
                }
            }
            return
        }
        if asking {
            // the server turns it into omp's "Other (type your own)" answer – it never shows as a message
            Task {
                do {
                    try await HollrClient.prompt(ref.server, pane: ref.pane.pane, text: trimmed)
                    actionWorked()
                    nudge()
                } catch {
                    lastError = String(localized: "Antwort nicht gesendet: \(error.localizedDescription)")
                }
            }
            return
        }
        let item = TranscriptItem(kind: .typed, text: trimmed, final: false)
        items.append(item)
        if usesTimeline {
            usersBefore[item.id] = Set((timeline?.items ?? []).compactMap { entry -> String? in
                if case let .user(id, text, _, _) = entry, text.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed { return id }
                return nil
            })
        } else {
            typedBefore[item.id] = items.filter { logged in
                logged.kind == .typed && logged.final && logged.text.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed
            }.count
        }
        if phase == .live {
            send(.control(["t": "prompt", "text": trimmed]))
        } else {
            deliver(item.id, trimmed)
        }
    }

    /// Sends a typed prompt. Not sent (no connection, no answer): the message says so in the chat and can be
    /// sent again – it never looks sent while the agent didn't get it. A prompt whose answer only got lost may
    /// still arrive: when it shows up in the log, the "not sent" mark goes away by itself (apply).
    private func deliver(_ id: UUID, _ text: String) {
        Task {
            do {
                try await HollrClient.prompt(ref.server, pane: ref.pane.pane, text: text)
                actionWorked()
                nudge()
            } catch {
                HollrLog.error("prompt \(ref.pane.pane): \(error)")
                // gone already: it showed up in the log, only the answer got lost – it did arrive
                if let i = items.firstIndex(where: { $0.id == id }) {
                    items[i].failed = true
                    let message = String(localized: "Nicht gesendet: \(error.localizedDescription)")
                    notSent = message
                    lastError = message
                }
                if HollrError.isTransport(error) { await SSHPool.shared.invalidate(ref.server) }
            }
        }
    }

    /// "Erneut senden" on a message that didn't go out.
    func resend(_ id: UUID) {
        guard let i = items.firstIndex(where: { $0.id == id && $0.failed }) else { return }
        items[i].failed = false
        lastError = nil
        deliver(id, items[i].text)
    }

    /// Drops a message that didn't go out.
    func discard(_ id: UUID) {
        items.removeAll { $0.id == id && $0.failed }
        usersBefore[id] = nil
        typedBefore[id] = nil
        notSentSettled()
    }

    func sendKeys(_ keys: [String]) {
        if phase == .live {
            send(.control(["t": "keys", "keys": keys]))
        } else {
            Task {
                do {
                    try await HollrClient.keys(ref.server, pane: ref.pane.pane, keys: keys)
                    actionWorked()
                    nudge() // show omp's reaction right away instead of on the next poll
                } catch { lastError = String(localized: "Tasten senden fehlgeschlagen: \(error.localizedDescription)") }
            }
        }
    }

    // MARK: Live

    func start() {
        guard !isLive, canLive else { return }
        phase = .connecting
        finished = false
        lastError = nil
        callError = nil
        task = Task { await run() }
    }

    func stop() {
        guard isLive else { return }
        HollrLog.info("live: stop requested")
        phase = .ending
        send(.control(["t": "stop"]))
        let call = task
        Task {
            try? await Task.sleep(for: .seconds(6))
            // only this call – not one started again in the meantime
            if phase == .ending, let call, call == task { call.cancel() }
        }
    }

    /// Same as pressing Space in omp: toggles omp's own live mute.
    func toggleMute() {
        guard phase == .live else { return }
        let want = !muted
        ompState = want ? "muted" : "listening" // optimistic, omp confirms via footer
        send(.control(["t": "mute", "on": want]))
    }

    private func send(_ frame: Frame) {
        outgoing?.yield(frame.encoded)
    }

    private func run() async {
        HollrLog.info("live: start \(ref.pane.pane) on \(ref.server.label)")
        guard await AVAudioApplication.requestRecordPermission() else {
            phase = .failed(String(localized: "Ohne Mikrofon-Zugriff geht es nicht (Einstellungen › Hollr › Mikrofon)."))
            return
        }
        // switch the audio hardware into voice-chat mode now, while SSH and /live start up
        VoiceIO.prepareSession()
        let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingNewest(200))
        outgoing = continuation
        voice.onCapture = { [weak self] pcm in
            guard let self else { return }
            Task { @MainActor in
                if !self.muted, self.phase == .live { continuation.yield(Frame.audio(pcm).encoded) }
            }
        }
        voice.onLevels = { [weak self] input, output in
            Task { @MainActor in
                self?.inputLevel = input
                self?.outputLevel = output
            }
        }

        let voice = self.voice
        let pane = ref.pane.pane
        do {
            let client = try await HollrClient.connect(ref.server)
            HollrLog.info("live: ssh connected")
            defer { Task { try? await client.close() } }
            try await client.withExec("live \(pane)") { inbound, outbound in
                let writer = Task {
                    do {
                        for await chunk in stream { try await outbound.write(ByteBuffer(bytes: chunk)) }
                    } catch {
                        HollrLog.info("live: writer stopped (\(error))")
                    }
                }
                defer { writer.cancel() }
                // heartbeat: a ping every 5 s (also while muted) – the server answers with pong and ends
                // a call it hasn't heard from; if we hear nothing for 20 s the connection is gone
                let heard = Clock()
                let heartbeat = Task { [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(5))
                        if Task.isCancelled { return }
                        continuation.yield(Frame.control(["t": "ping"]).encoded)
                        if heard.age > 20 {
                            HollrLog.error("live: nothing from the server for \(Int(heard.age))s – connection lost")
                            await MainActor.run {
                                if self?.callError == nil {
                                    self?.callError = String(localized: "Verbindung verloren – keine Antwort vom Server.")
                                }
                            }
                            try? await client.close()
                            return
                        }
                    }
                }
                defer { heartbeat.cancel() }
                var decoder = FrameDecoder()
                for try await output in inbound {
                    heard.touch()
                    switch output {
                    case .stderr(let buffer):
                        HollrLog.error("live: server stderr \(String(buffer: buffer))")
                    case .stdout(let buffer):
                        for frame in decoder.push(Data(buffer.readableBytesView)) {
                            switch frame {
                            case .audio(let pcm): voice.play(pcm)
                            case .json(let data): if await handle(LiveEvent(json: data)) { return }
                            }
                        }
                    }
                }
                HollrLog.info("live: server closed the channel")
            }
        } catch is CancellationError {
            HollrLog.info("live: cancelled")
        } catch {
            if finished {
                HollrLog.info("live: closed after end (\(error))")
            } else {
                HollrLog.error("live: failed \(error)")
                if callError == nil { callError = Self.describe(error) }
            }
        }
        if !finished, phase != .ending, callError == nil {
            callError = String(localized: "Verbindung zum Server wurde unerwartet beendet.")
        }
        if let callError { phase = .failed(callError) } else { phase = .idle }
        speakerMuted = false
        ompState = nil
        continuation.finish()
        outgoing = nil
        self.voice.stop()
        HollrLog.info("live: done \(phase)")
    }

    private static func describe(_ error: Error) -> String {
        if let hollr = error as? HollrError { return hollr.localizedDescription }
        let text = String(describing: error)
        if text.contains("ChannelError") || text.contains("Closed") { return String(localized: "Verbindung zum Server wurde beendet.") }
        return error.localizedDescription
    }

    /// Returns true when the call is over.
    private func handle(_ event: LiveEvent) async -> Bool {
        switch event {
        case let .phase(p, reason):
            HollrLog.info("live: phase \(p) \(reason ?? "")")
            switch p {
            case "live":
                do {
                    try voice.start()
                    phase = .live
                    #if DEBUG
                    if let clip = UserDefaults.standard.string(forKey: "hollrClip") {
                        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                            .appendingPathComponent(clip)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.voice.injectFile(url) }
                    }
                    #endif
                } catch {
                    HollrLog.error("live: audio start failed \(error)")
                    callError = String(localized: "Audio konnte nicht starten: \(error.localizedDescription)")
                    send(.control(["t": "stop"]))
                }
            case "ended":
                finished = true
                if reason == "live_stopped" {
                    items.append(TranscriptItem(kind: .info, text: String(localized: "Live wurde am Rechner beendet.")))
                } else if callError == nil, phase != .ending {
                    // the server ended the call on its own: say why
                    switch reason {
                    case "start_failed": callError = String(localized: "Live konnte auf dem Server nicht starten.")
                    case "disconnected": callError = String(localized: "Verbindung unterbrochen – bitte neu starten.")
                    default: break
                    }
                }
                return true
            default: break
            }
        case let .status(s):
            agentStatus = s
        case let .omp(state):
            ompState = state
        case let .error(code, message):
            HollrLog.error("live: server error \(code) \(message)")
            finished = true
            callError = message
            return true
        case .delegation, .user, .tool, .answer:
            if case let .user(text) = event, let i = items.lastIndex(where: { $0.kind == .typed && $0.text == text && !$0.final }) {
                items[i].final = true
            } else {
                Self.append(event, to: &items)
            }
        case .other:
            break
        }
        return false
    }
}

/// Keeps one `AgentSession` per agent for the app's lifetime.
@MainActor
@Observable
final class SessionStore {
    private(set) var sessions: [String: AgentSession] = [:]

    func session(for ref: AgentRef) -> AgentSession {
        if let existing = sessions[ref.id] {
            existing.update(ref)
            return existing
        }
        let session = AgentSession(ref: ref)
        sessions[ref.id] = session
        return session
    }

    /// The call that is currently live (Hollr allows one at a time per phone).
    var liveSession: AgentSession? { sessions.values.first { $0.isLive } }

    func endOtherLiveCalls(except id: String) {
        for (key, session) in sessions where key != id && session.isLive { session.stop() }
    }
}

/// The chat stream went silent (dead connection): reconnect.
struct FollowStalled: Error {}

/// A flag set from another task.
final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false
    var value: Bool {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

/// The first of several outcomes (stream ended, watchdog, cancellation) – `wait()` returns it, later ones are
/// ignored. `nil` = the stream ended normally.
final class Race: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    private var outcome: Error?
    private var waiter: CheckedContinuation<Error?, Never>?

    func finish(_ error: Error?) {
        let waiting: CheckedContinuation<Error?, Never>? = lock.withLock {
            guard !done else { return nil }
            done = true
            outcome = error
            defer { waiter = nil }
            return waiter
        }
        waiting?.resume(returning: error)
    }

    func wait() async -> Error? {
        await withCheckedContinuation { (cont: CheckedContinuation<Error?, Never>) in
            let ready: Bool = lock.withLock {
                if done { return true }
                waiter = cont
                return false
            }
            if ready { cont.resume(returning: lock.withLock { outcome }) }
        }
    }
}
