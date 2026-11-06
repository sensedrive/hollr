import SwiftUI

/// The chat input (molecule Composer): HUD on top, text, then actions – terminal keys and attachments on the
/// left, dictation, Live and send on the right; model and context as a quiet line at the bottom.
/// Live voice (omp) and local dictation live inside the same card.
struct Composer: View {
    @Bindable var session: AgentSession
    /// tells the screen to make room while typing
    var editing: Binding<Bool> = .constant(false)
    /// the omp HUD (working row, jobs, TODO) on top of the card (composer__top)
    var showsHUD = false
    /// tap on the model line: switch the model
    var onModel: (() -> Void)? = nil
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
        VStack(alignment: .leading, spacing: Gap.s) {
            if showsHUD, let timeline = session.timeline, AgentHUD.isVisible(timeline) {
                AgentHUD(timeline: timeline)
                    .padding(.bottom, 10)
                    .overlay(alignment: .bottom) { Rectangle().fill(Theme.border.opacity(0.7)).frame(height: 1) }
                    .padding(.horizontal, -2)
            }
            if session.isLive { liveStrip }
            if mine, case .failed(let message) = dictator.state {
                Text(message).font(Typo.sm).foregroundStyle(Theme.warn)
            }
            if mine, case .preparing(let message) = dictator.state, !message.isEmpty {
                Label(message, systemImage: "arrow.down.circle").font(Typo.sm).foregroundStyle(Theme.muted)
            }
            if mine, let notice = dictator.notice, !dictating {
                Text(notice).font(Typo.sm).foregroundStyle(Theme.muted)
            }
            if focused, !dictating, let mention = Mention.find(in: draft.text, cursor: draft.cursor) {
                MentionSuggestions(ref: ref, query: mention.query) { path in
                    if let r = Mention.insert(path, into: draft.text, cursor: draft.cursor) {
                        draft.text = r.text
                        draft.cursor = r.cursor
                    }
                }
            }
            if focused, !dictating, !isShell, Mention.find(in: draft.text, cursor: draft.cursor) == nil {
                SnippetChips { insertSnippet($0) }
            }
            ComposerField(placeholder: placeholder, text: dictating ? .constant(dictationPreview) : textBinding, cursor: cursorBinding)
                // proportional: easier to read and type than terminal type (code stays mono in the chat)
                .font(.body)
                .lineLimit(1...6)
                .focused($focused)
                .disabled(!hasAgent || dictating)
                .foregroundStyle(dictating ? Theme.muted : Theme.fg)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.horizontal, 2)
            actions
            if let modelHint { modelLine(modelHint) }
        }
        .composerStyle(focused: focused)
        .overlay {
            // a running live call frames the card in its state colour
            if session.isLive {
                RoundedRectangle(cornerRadius: Radius.composer, style: .continuous)
                    .strokeBorder(liveColor.opacity(0.55), lineWidth: 1)
            }
        }
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

    // MARK: Model line (composer__hint)

    /// "claude-opus-5-5 · 38 %": omp's model and context use
    private var modelHint: String? {
        let line = session.timeline?.line
        let parts = [line?.model ?? session.timeline?.model, line?.context].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func modelLine(_ hint: String) -> some View {
        Button { onModel?() } label: {
            Text(hint)
                .font(Typo.monoXS)
                .foregroundStyle(Theme.dim)
                .lineLimit(1).truncationMode(.middle)
                .padding(.horizontal, 2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(onModel == nil)
        .accessibilityLabel(hint)
        .accessibilityHint("Modell wechseln")
    }

    // MARK: Action row

    private var actions: some View {
        HStack(spacing: Gap.s) {
            HStack(spacing: 2) {
                keysMenu
                if focused {
                    Button { focused = false } label: { Image(systemName: "keyboard.chevron.compact.down") }
                        .buttonStyle(.icon())
                        .accessibilityLabel("Tastatur schließen")
                }
                if !isShell {
                    AttachButton(ref: ref) { insertSnippet($0) }
                }
            }
            .padding(.leading, -10)
            Spacer(minLength: 0)
            micButton
            if ref.pane.live && !session.isLive { liveButton }
            sendButton
        }
    }

    private var keysMenu: some View {
        Menu {
            Section(isShell ? String(localized: "Tasten ans Terminal senden") : "Tasten an \(ref.pane.agentName) senden") {
                key("Enter", "enter")
                key("Esc", "esc")
                key("Tab", "tab")
                key(String(localized: "Leertaste"), "space")
                key("↑", "up")
                key("↓", "down")
                key("y (ja)", "y")
                key("n (nein)", "n")
                key("Ctrl+C", "ctrl+c")
                key("Ctrl+D", "ctrl+d")
                key("Ctrl+L", "ctrl+l")
            }
        } label: {
            IconView(.terminal, size: 16)
                .foregroundStyle(Theme.muted)
                .frame(width: Metric.touch, height: Metric.touch)
                .contentShape(Rectangle())
        }
        .disabled(!hasAgent)
        .accessibilityLabel("Tasten senden")
    }

    private func key(_ title: String, _ name: String) -> some View {
        Button(title) { session.sendKeys([name]) }
    }

    private var micButton: some View {
        HStack(spacing: 2) {
            if recordingHere {
                // throw the recording away
                Button {
                    Haptics.tap(.light)
                    dictator.cancel()
                    holding = false
                } label: {
                    IconView(.x, size: 15)
                }
                .buttonStyle(.icon())
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
                // composer__mic[data-rec]: red disc with a stop square
                Circle().fill(Theme.red).frame(width: Metric.touch, height: Metric.touch)
                    .scaleEffect(1 + CGFloat(min(dictator.level * 8, 0.25)))
                RoundedRectangle(cornerRadius: 2, style: .continuous).fill(Theme.onAccent).frame(width: 12, height: 12)
            } else if dictator.owner == draft.key, dictator.state == .transcribing || { if case .preparing = dictator.state { return true }; return false }() {
                Spinner(color: Theme.muted, size: 16)
            } else {
                IconView(.mic, size: 16).foregroundStyle(Theme.muted)
            }
        }
        .frame(width: Metric.touch, height: Metric.touch)
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
            LiveButtonLabel()
        }
        .buttonStyle(.plain)
        .disabled(dictating)
        .accessibilityLabel("Live mit omp sprechen")
    }

    private var sendButton: some View {
        Button(action: send) {
            SendButtonLabel(ready: !trimmed.isEmpty && hasAgent && !dictating)
        }
        .buttonStyle(.plain)
        .disabled(trimmed.isEmpty || !hasAgent || dictating)
        .accessibilityLabel("Senden")
    }

    /// Inserts a saved prompt at the cursor.
    private func insertSnippet(_ prompt: String) {
        Haptics.tap(.light)
        let chars = Array(draft.text)
        let at = min(max(draft.cursor ?? chars.count, 0), chars.count)
        let before = String(chars[..<at]), after = String(chars[at...])
        let glue = before.isEmpty || before.hasSuffix(" ") || before.hasSuffix("\n") ? "" : " "
        draft.text = before + glue + prompt + after
        draft.cursor = (before + glue + prompt).count
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
        HStack(spacing: Gap.m) {
            LevelBars(level: session.muted ? 0 : max(session.inputLevel * 6, session.outputLevel * 4), color: liveColor)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.phase == .connecting ? "Verbinde …" : session.phase == .ending ? "Beende …" : "Live")
                    .font(Typo.lg)
                Text(session.phase == .live
                     ? [session.muted ? String(localized: "Mikro aus") : Theme.ompStateLabel(session.ompState), session.speakerMuted ? String(localized: "Ton aus") : nil]
                        .compactMap { $0 }.joined(separator: " · ")
                     : "omp /live")
                    .font(Typo.sm).foregroundStyle(liveColor)
            }
            Spacer()
            Button { session.speakerMuted.toggle() } label: {
                liveControl(session.speakerMuted ? "speaker.slash" : HIcon.volume.symbol, on: session.speakerMuted)
            }
            .buttonStyle(.plain)
            .disabled(session.phase != .live)
            .accessibilityLabel(session.speakerMuted ? String(localized: "Ton an") : String(localized: "Ton aus (Antwort nicht hören)"))
            Button { session.toggleMute() } label: {
                liveControl(session.muted ? "mic.slash" : HIcon.mic.symbol, on: session.muted)
            }
            .buttonStyle(.plain)
            .disabled(session.phase != .live)
            .accessibilityLabel(session.muted ? String(localized: "Mikrofon an") : String(localized: "Mikrofon aus (wie Leertaste) – du hörst weiter zu"))
            Button { session.stop() } label: {
                Image(systemName: "phone.down")
                    .font(.system(size: 16, weight: .medium))
                    .frame(width: 40, height: 40)
                    .background(Theme.red, in: Circle())
                    .foregroundStyle(Theme.onAccent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Live beenden")
        }
        .padding(.bottom, 2)
    }

    /// Round live-call control: text wash, or a warning fill while it is switched off.
    private func liveControl(_ symbol: String, on: Bool) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 16, weight: .medium))
            .frame(width: 40, height: 40)
            .background(on ? Theme.warn : Theme.wash(0.1), in: Circle())
            .foregroundStyle(on ? Theme.onAccent : Theme.fg)
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
            TextField(placeholder, text: $text, prompt: Text(placeholder).foregroundStyle(Theme.dim), axis: .vertical)
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
        TextField(placeholder, text: $text, selection: $selection, prompt: Text(placeholder).foregroundStyle(Theme.dim),
                  axis: .vertical)
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
