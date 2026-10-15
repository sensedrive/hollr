import SwiftUI

/// The chat input card (Moshi-style): text on top, actions below.
/// Live voice (omp) and local dictation live inside the same card.
struct Composer: View {
    @Bindable var session: AgentSession
    /// tells the screen to make room while typing
    var editing: Binding<Bool> = .constant(false)
    /// Zen mode: frosted glass so the transcript shows through
    var translucent = false
    @Environment(SessionStore.self) private var sessions
    @Environment(DictationSettings.self) private var settings
    @Environment(DraftStore.self) private var drafts
    /// app-wide: one microphone; survives zen mode and layout changes
    @Environment(Dictator.self) private var dictator
    /// finger is held on the mic (hold-to-talk: release ends the dictation)
    @State private var holding = false
    @State private var pressStarted: Date?
    @FocusState private var focused: Bool

    private var ref: AgentRef { session.ref }
    /// agents and plain terminals both take input
    private var hasAgent: Bool { true }
    private var isShell: Bool { ref.pane.agent == nil }
    /// The unsent text lives in the draft store, not in this view: zen mode and other layouts show
    /// another Composer, switching chats rebuilds the screen – the text stays.
    private var draft: Draft { drafts.draft(for: ref) }
    private var trimmed: String { draft.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var textBinding: Binding<String> {
        let draft = draft
        return Binding(get: { draft.text }, set: { draft.text = $0 })
    }
    private var cursorBinding: Binding<Int?> {
        let draft = draft
        return Binding(get: { draft.cursor }, set: { draft.cursor = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if session.isLive { liveStrip }
            if mine, case .failed(let message) = dictator.state {
                Text(message).font(.caption).foregroundStyle(Theme.warn)
            }
            if mine, case .preparing(let message) = dictator.state, !message.isEmpty {
                Label(message, systemImage: "arrow.down.circle").font(.caption).foregroundStyle(.secondary)
            }
            if mine, let notice = dictator.notice, !dictating {
                Text(notice).font(.caption).foregroundStyle(.secondary)
            }
            ComposerField(placeholder: placeholder, text: dictating ? .constant(dictationPreview) : textBinding, cursor: cursorBinding)
                .font(.system(.body, design: .monospaced))
                .lineLimit(1...6)
                .focused($focused)
                .disabled(!hasAgent || dictating)
                .foregroundStyle(dictating ? .secondary : .primary)
                .submitLabel(.send)
                .onSubmit(send)
            actions
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .background(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(translucent ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(Theme.raised))
                .overlay(
                    RoundedRectangle(cornerRadius: 26, style: .continuous)
                        .stroke(session.isLive ? liveColor.opacity(0.55) : Theme.fg.opacity(0.12), lineWidth: 1)
                )
        )
        .animation(.easeInOut(duration: 0.2), value: session.isLive)
        .onChange(of: focused) { _, now in withAnimation(.easeInOut(duration: 0.2)) { editing.wrappedValue = now } }
        // while dictating, the chat stops refreshing so the transcription gets the CPU
        .onChange(of: dictating) { _, _ in syncDictating() }
        .onAppear {
            Dictator.prewarm(settings)
            dictator.composerAppeared(draft.key)
            syncDictating()
        }
        .onDisappear {
            // the dictation keeps running while another composer of this chat takes over (zen mode);
            // leaving the chat ends it and keeps the text (Dictator.composerDisappeared)
            dictator.composerDisappeared(draft.key)
        }
    }

    private var placeholder: String {
        if isShell { return String(localized: "Befehl ausführen …") }
        return session.isLive ? String(localized: "Oder tippen …") : String(localized: "Nachricht an \(ref.pane.agentName) …")
    }

    /// the running dictation belongs to this chat
    private var mine: Bool { dictator.owner == draft.key || (dictator.owner == nil && !dictator.isBusy) }
    private var dictating: Bool { dictator.owner == draft.key && (dictator.isRecording || dictator.state == .transcribing) }
    private var recordingHere: Bool { dictator.owner == draft.key && dictator.isRecording }

    private func syncDictating() {
        session.dictating = dictating
        if !dictating { session.nudge() } // catch up right after dictation
    }
    private var dictationPreview: String {
        let spoken = dictator.state == .transcribing && dictator.text.isEmpty
            ? String(localized: "transkribiere …")
            : dictator.isRecording && dictator.text.isEmpty ? String(localized: "hört zu …") : dictator.text
        return [draft.beforeDictation, spoken, draft.afterDictation].filter { !$0.isEmpty }.joined(separator: " ")
    }

    // MARK: Action row

    private var actions: some View {
        HStack(spacing: 18) {
            keysMenu
            if focused {
                Button { focused = false } label: {
                    Image(systemName: "keyboard.chevron.compact.down")
                }
                .foregroundStyle(.secondary)
                .accessibilityLabel("Tastatur schließen")
            }
            Spacer()
            micButton
            if ref.pane.live && !session.isLive { liveButton }
            sendButton
        }
        .font(.title3)
    }

    private var keysMenu: some View {
        Menu {
            Section(isShell ? String(localized: "Tasten ans Terminal senden") : "Tasten an \(ref.pane.agentName) senden") {
                key("Enter", "enter")
                key("Esc", "esc")
                key("Tab", "tab")
                key("↑", "up")
                key("↓", "down")
                key("y (ja)", "y")
                key("n (nein)", "n")
                key("Ctrl+C", "ctrl+c")
                key("Ctrl+D", "ctrl+d")
                key("Ctrl+L", "ctrl+l")
            }
        } label: {
            Text(">_").font(.system(.title3, design: .monospaced).weight(.semibold))
        }
        .disabled(!hasAgent)
        .foregroundStyle(.primary)
        .accessibilityLabel("Tasten senden")
    }

    private func key(_ title: String, _ name: String) -> some View {
        Button(title) { session.sendKeys([name]) }
    }

    private var micButton: some View {
        HStack(spacing: 14) {
            if recordingHere {
                // throw the recording away
                Button {
                    Haptics.tap(.light)
                    dictator.cancel()
                    holding = false
                } label: {
                    Image(systemName: "xmark").font(.body.weight(.semibold)).frame(width: 30, height: 38)
                }
                .foregroundStyle(.secondary)
                .accessibilityLabel("Diktat verwerfen")
                .transition(.scale.combined(with: .opacity))
            }
            micLabel
                .contentShape(Circle())
                // tap = start/stop, hold = talk while holding (released after ≥ 0.3 s ends it).
                // onPressingChanged also reports a cancelled touch (permission alert, call) – a
                // DragGesture would never end then and the mic would stay stuck.
                .onLongPressGesture(minimumDuration: 0.3, maximumDistance: 80, perform: {}) { pressing in
                    if pressing {
                        guard pressStarted == nil, micEnabled else { return }
                        pressStarted = Date()
                        if !recordingHere && !dictator.isBusy { startDictation(); holding = true } else { holding = false }
                    } else {
                        let held = pressStarted.map { Date().timeIntervalSince($0) } ?? 0
                        pressStarted = nil
                        if holding {
                            holding = false
                            if held >= 0.3 { stopDictation() } // short tap: keeps recording until the next tap
                        } else if recordingHere {
                            stopDictation()
                        }
                    }
                }
                .opacity(micEnabled ? 1 : 0.35)
                .accessibilityElement()
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(recordingHere ? "Diktat beenden" : "Diktieren")
                .accessibilityHint("Tippen zum Starten und Beenden – oder gedrückt halten und sprechen")
                .accessibilityAction { recordingHere ? stopDictation() : startDictation() }
        }
        .animation(.easeOut(duration: 0.15), value: recordingHere)
    }

    /// another chat's dictation or a transcription in progress blocks the mic here
    private var micEnabled: Bool {
        hasAgent && !session.isLive && dictator.state != .transcribing && (recordingHere || !dictator.isBusy)
    }

    private var micLabel: some View {
        ZStack {
            if recordingHere {
                Circle().fill(Color.red).frame(width: 38, height: 38)
                    .scaleEffect(1 + CGFloat(min(dictator.level * 8, 0.25)))
                Image(systemName: "stop.fill").font(.system(size: 14)).foregroundStyle(.white)
            } else if dictator.owner == draft.key, dictator.state == .transcribing || { if case .preparing = dictator.state { return true }; return false }() {
                ProgressView().frame(width: 38, height: 38)
            } else {
                Image(systemName: "mic").frame(width: 38, height: 38)
            }
        }
        .animation(.easeOut(duration: 0.1), value: dictator.level)
    }

    private func startDictation() {
        guard micEnabled, !dictator.isBusy else { return }
        // split the text at the cursor: dictation goes in between
        let draft = draft
        let chars = Array(draft.text)
        let at = min(max(draft.cursor ?? chars.count, 0), chars.count)
        draft.beforeDictation = String(chars[..<at]).trimmingCharacters(in: .whitespaces)
        draft.afterDictation = String(chars[at...]).trimmingCharacters(in: .whitespaces)
        focused = false
        Haptics.tap(.medium)
        let context = DictationContext(session: session)
        let settings = settings
        let session = session
        Task {
            await dictator.start(settings: settings, context: context, owner: draft.key) { result in
                Composer.insert(result, into: draft, settings: settings, session: session)
            }
        }
    }

    private func stopDictation() {
        Haptics.tap(.light)
        Task { await dictator.finish() }
    }

    /// Puts the dictated text at the cursor of the chat's draft; "… senden" (or auto-send) sends it.
    /// Static: the composer that started the dictation may be gone (zen mode, other chat).
    static func insert(_ result: String, into draft: Draft, settings: DictationSettings, session: AgentSession) {
        var spoken = result
        var sendNow = settings.autoSend
        if settings.voiceSend {
            let (rest, said) = DictationText.voiceSend(spoken)
            if said { spoken = rest; sendNow = true }
        }
        let head = [draft.beforeDictation, spoken].filter { !$0.isEmpty }.joined(separator: " ")
        draft.text = [head, draft.afterDictation].filter { !$0.isEmpty }.joined(separator: " ")
        draft.cursor = head.count
        draft.beforeDictation = ""
        draft.afterDictation = ""
        if spoken.isEmpty {
            Haptics.notify(.warning)
        } else {
            Haptics.notify(.success)
            let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if sendNow, !text.isEmpty {
                session.sendText(text)
                draft.clear()
            }
        }
    }

    private var liveButton: some View {
        Button {
            sessions.endOtherLiveCalls(except: ref.id)
            session.start()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "waveform")
                Text("Live").font(.subheadline.weight(.semibold))
            }
            .padding(.horizontal, 12)
            .frame(height: 38)
            .background(Theme.live.opacity(0.22), in: Capsule())
            .foregroundStyle(Theme.live)
        }
        .disabled(dictating)
        .accessibilityLabel("Live mit omp sprechen")
    }

    private var sendButton: some View {
        Button(action: send) {
            Image(systemName: "arrow.up")
                .font(.body.weight(.semibold))
                .frame(width: 42, height: 42)
                .background(trimmed.isEmpty ? Theme.fg.opacity(0.1) : Theme.accent, in: Circle())
                .foregroundStyle(trimmed.isEmpty ? Color.secondary : Theme.onAccent)
        }
        .disabled(trimmed.isEmpty || !hasAgent || dictating)
        .accessibilityLabel("Senden")
    }

    private func send() {
        guard !trimmed.isEmpty, !dictating else { return }
        session.sendText(trimmed)
        draft.clear()
        focused = false
    }

    // MARK: Live strip (inside the card while a call runs)

    private var liveColor: Color {
        if session.muted { return Theme.warn }
        if session.phase != .live { return Theme.accent }
        return session.ompState == "working" || session.ompState == "thinking" ? Theme.work : Theme.live
    }

    private var liveStrip: some View {
        HStack(spacing: 12) {
            LevelBars(level: session.muted ? 0 : max(session.inputLevel * 6, session.outputLevel * 4), color: liveColor)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.phase == .connecting ? "Verbinde …" : session.phase == .ending ? "Beende …" : "Live")
                    .font(.subheadline.weight(.semibold))
                Text(session.phase == .live
                     ? [session.muted ? String(localized: "Mikro aus") : Theme.ompStateLabel(session.ompState), session.speakerMuted ? String(localized: "Ton aus") : nil]
                        .compactMap { $0 }.joined(separator: " · ")
                     : "omp /live")
                    .font(.caption).foregroundStyle(liveColor)
            }
            Spacer()
            Button { session.speakerMuted.toggle() } label: {
                Image(systemName: session.speakerMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    .frame(width: 40, height: 40)
                    .background(session.speakerMuted ? Theme.warn : Theme.fg.opacity(0.1), in: Circle())
                    .foregroundStyle(session.speakerMuted ? Theme.onAccent : .primary)
            }
            .disabled(session.phase != .live)
            .accessibilityLabel(session.speakerMuted ? String(localized: "Ton an") : String(localized: "Ton aus (Antwort nicht hören)"))
            Button { session.toggleMute() } label: {
                Image(systemName: session.muted ? "mic.slash.fill" : "mic.fill")
                    .frame(width: 40, height: 40)
                    .background(session.muted ? Theme.warn : Theme.fg.opacity(0.1), in: Circle())
                    .foregroundStyle(session.muted ? Theme.onAccent : .primary)
            }
            .disabled(session.phase != .live)
            .accessibilityLabel(session.muted ? String(localized: "Mikrofon an") : String(localized: "Mikrofon aus (wie Leertaste) – du hörst weiter zu"))
            Button { session.stop() } label: {
                Image(systemName: "phone.down.fill")
                    .frame(width: 40, height: 40)
                    .background(Color.red, in: Circle())
                    .foregroundStyle(.white)
            }
            .accessibilityLabel("Live beenden")
        }
        .padding(.bottom, 2)
    }
}

/// Five bars that dance with the audio level.
struct LevelBars: View {
    var level: Float
    var color: Color
    private let weights: [CGFloat] = [0.45, 0.8, 1, 0.7, 0.4]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(weights.indices, id: \.self) { i in
                Capsule()
                    .fill(color)
                    .frame(width: 4, height: 6 + 22 * weights[i] * CGFloat(min(level, 1)))
            }
        }
        .frame(width: 36, height: 30)
        .animation(.easeOut(duration: 0.12), value: level)
    }
}

/// Text field that reports the cursor position (iOS 18+) so dictation lands where you were typing.
private struct ComposerField: View {
    let placeholder: String
    @Binding var text: String
    @Binding var cursor: Int?

    var body: some View {
        if #available(iOS 18, macCatalyst 18, *) {
            SelectionField(placeholder: placeholder, text: $text, cursor: $cursor)
        } else {
            TextField(placeholder, text: $text, axis: .vertical)
        }
    }
}

@available(iOS 18, macCatalyst 18, *)
private struct SelectionField: View {
    let placeholder: String
    @Binding var text: String
    @Binding var cursor: Int?
    @State private var selection: TextSelection?

    var body: some View {
        TextField(placeholder, text: $text, selection: $selection, axis: .vertical)
            .onChange(of: selection) { _, new in
                // the selection can still point into the previous text (draft restored, dictation preview):
                // only use it when it is a valid position in the current one
                guard let new, case let .selection(range) = new.indices,
                      range.upperBound <= text.endIndex,
                      let i = String.Index(range.upperBound, within: text) else { cursor = nil; return }
                cursor = text.distance(from: text.startIndex, to: i)
            }
            .onChange(of: cursor) { _, new in
                // put the cursor behind freshly dictated text
                guard let new, new >= 0, new <= text.count else { return }
                let i = text.index(text.startIndex, offsetBy: new)
                if case let .selection(range)? = selection?.indices, range.upperBound <= text.endIndex,
                   range.upperBound == i { return }
                selection = TextSelection(insertionPoint: i)
            }
            .onChange(of: text) { _, new in
                // text replaced from outside (sent, dictation inserted): drop a selection that no longer fits
                if case let .selection(range)? = selection?.indices, range.upperBound > new.endIndex { selection = nil }
            }
    }
}

enum Haptics {
    static func tap(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }

    static func notify(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        UINotificationFeedbackGenerator().notificationOccurred(type)
    }
}
