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
        let pane = ref.pane.pane
        let server = ref.server
        let heard = Clock()
        var supported = true
        do {
            let client = try await SSHPool.shared.client(for: server)
            heard.touch()
            // the server pings every 20 s: silence = a dead connection
            let watchdog = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(10))
                    if heard.age > 50 { await SSHPool.shared.invalidate(server); return }
                }
            }
            defer { watchdog.cancel() }
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
                            supported = false
                            return
                        case .gone:
                            self.lastError = String(localized: "Die Session gibt es nicht mehr.")
                            self.historyLoaded = true
                            return
                        case let .full(timeline):
                            self.apply(timeline)
                        case let .delta(head, order, items):
                            // an id we don't have (gap): reconnect for a full one
                            guard let merged = FollowEvent.merge(self.timeline, head: head, order: order, items: items) else { return }
                            self.apply(merged)
                        case .other:
                            break
                        }
                    }
                }
            }
        } catch is CancellationError {
        } catch {
            HollrLog.error("follow \(pane): \(error)")
            if HollrError.isTransport(error) { await SSHPool.shared.invalidate(server) }
        }
        return supported
    }

    /// A fresh timeline from the stream or a poll.
    private func apply(_ fresh: Timeline) {
        if fresh != timeline { timeline = fresh }
        if let status = fresh.status, !isLive { agentStatus = status }
        // typed prompts that now show up in the log are no longer "pending"
        let logged = Set(fresh.items.compactMap { item -> String? in
            if case let .user(_, text, _, _) = item { return text }
            return nil
        })
        pendingTyped.removeAll { logged.contains($0) }
        items.removeAll { $0.kind == .typed && !$0.final && logged.contains($0.text) }
        historyLoaded = true
        lastError = nil
    }

    func loadTimeline() async {
        guard usesTimeline else { return }
        do {
            guard let fresh = try await HollrClient.timeline(ref.server, pane: ref.pane.pane, etag: timeline?.etag) else {
                historyLoaded = true
                lastError = nil
                return // unchanged
            }
            apply(fresh)
        } catch {
            HollrLog.error("timeline \(ref.pane.pane): \(error)")
            lastError = error.localizedDescription
            historyLoaded = true
            // a closed pane or herdr error is an answer – reconnecting would only tear down the feed
            if HollrError.isTransport(error) { await SSHPool.shared.invalidate(ref.server) }
        }
    }

    /// Picks option `index` in omp's ask dialog (cursor starts on the first option).
    func answer(option index: Int) {
        sendKeys(Array(repeating: "down", count: index) + ["enter"])
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
    private(set) var lastError: String?

    private var task: Task<Void, Never>?
    private var outgoing: AsyncStream<Data>.Continuation?
    private let voice = VoiceIO()
    private var finished = false
    private var pendingTyped: [String] = []

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
            // typed prompts that are not in the log yet stay visible
            let logged = Set(fresh.filter { $0.kind == .typed }.map(\.text))
            pendingTyped.removeAll { logged.contains($0) }
            fresh += pendingTyped.map { TranscriptItem(kind: .typed, text: $0, final: false) }
            let signature = { (list: [TranscriptItem]) in list.map { "\($0.kind)|\($0.text)|\($0.final)" } }
            if signature(fresh) != signature(items), !(fresh.isEmpty && !items.isEmpty) { items = fresh }
            historyLoaded = true
            lastError = nil
        } catch {
            HollrLog.error("history \(ref.pane.pane): \(error)")
            lastError = error.localizedDescription
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
                    try? await Task.sleep(for: .milliseconds(400))
                    await loadScreen()
                } catch {
                    lastError = "Senden fehlgeschlagen: \(error.localizedDescription)"
                }
            }
            return
        }
        items.append(TranscriptItem(kind: .typed, text: trimmed, final: false))
        if phase == .live {
            send(.control(["t": "prompt", "text": trimmed]))
        } else {
            pendingTyped.append(trimmed)
            Task {
                do {
                    try await HollrClient.prompt(ref.server, pane: ref.pane.pane, text: trimmed)
                    nudge()
                } catch {
                    lastError = "Senden fehlgeschlagen: \(error.localizedDescription)"
                }
            }
        }
    }

    func sendKeys(_ keys: [String]) {
        if phase == .live {
            send(.control(["t": "keys", "keys": keys]))
        } else {
            Task {
                do {
                    try await HollrClient.keys(ref.server, pane: ref.pane.pane, keys: keys)
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
                                if self?.lastError == nil {
                                    self?.lastError = String(localized: "Verbindung verloren – keine Antwort vom Server.")
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
                if lastError == nil { lastError = Self.describe(error) }
            }
        }
        if !finished, phase != .ending, lastError == nil {
            lastError = String(localized: "Verbindung zum Server wurde unerwartet beendet.")
        }
        if let lastError { phase = .failed(lastError) } else { phase = .idle }
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
                    lastError = String(localized: "Audio konnte nicht starten: \(error.localizedDescription)")
                    send(.control(["t": "stop"]))
                }
            case "ended":
                finished = true
                if reason == "live_stopped" {
                    items.append(TranscriptItem(kind: .info, text: String(localized: "Live wurde am Rechner beendet.")))
                } else if lastError == nil, phase != .ending {
                    // the server ended the call on its own: say why
                    switch reason {
                    case "start_failed": lastError = String(localized: "Live konnte auf dem Server nicht starten.")
                    case "disconnected": lastError = String(localized: "Verbindung unterbrochen – bitte neu starten.")
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
            lastError = message
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
