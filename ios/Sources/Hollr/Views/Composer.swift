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
    @State private var dictator = Dictator()
    @State private var text = ""
    @State private var textBeforeDictation = ""
    @FocusState private var focused: Bool

    private var ref: AgentRef { session.ref }
    /// agents and plain terminals both take input
    private var hasAgent: Bool { true }
    private var isShell: Bool { ref.pane.agent == nil }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if session.isLive { liveStrip }
            if case .failed(let message) = dictator.state {
                Text(message).font(.caption).foregroundStyle(Theme.warn)
            }
            if case .preparing(let message) = dictator.state {
                Label(message, systemImage: "arrow.down.circle").font(.caption).foregroundStyle(.secondary)
            }
            TextField(placeholder, text: dictating ? .constant(dictationPreview) : $text, axis: .vertical)
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
        .onDisappear { session.dictating = false }
    }

    private var placeholder: String {
        if isShell { return String(localized: "Befehl ausführen …") }
        return session.isLive ? String(localized: "Oder tippen …") : String(localized: "Nachricht an \(ref.pane.agentName) …")
    }

    private var dictating: Bool { dictator.isRecording || dictator.state == .transcribing }

    private func syncDictating() {
        session.dictating = dictating
        if !dictating { session.nudge() } // catch up right after dictation
    }
    private var dictationPreview: String {
        let spoken = dictator.state == .transcribing && dictator.text.isEmpty ? "transkribiere …" : dictator.text
        return [textBeforeDictation, spoken].filter { !$0.isEmpty }.joined(separator: " ")
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
        Button {
            Task {
                if dictator.isRecording {
                    let result = await dictator.stop(settings: settings)
                    text = [textBeforeDictation, result].filter { !$0.isEmpty }.joined(separator: " ")
                    if settings.autoSend, !result.isEmpty { send() }
                } else {
                    textBeforeDictation = trimmed
                    focused = false
                    await dictator.start(settings: settings)
                }
            }
        } label: {
            ZStack {
                if dictator.isRecording {
                    Circle().fill(Color.red).frame(width: 38, height: 38)
                        .scaleEffect(1 + CGFloat(min(dictator.level * 8, 0.25)))
                    Image(systemName: "stop.fill").font(.system(size: 14)).foregroundStyle(.white)
                } else if dictator.state == .transcribing || { if case .preparing = dictator.state { return true }; return false }() {
                    ProgressView().frame(width: 38, height: 38)
                } else {
                    Image(systemName: "mic").frame(width: 38, height: 38)
                }
            }
        }
        .disabled(!hasAgent || session.isLive || dictator.state == .transcribing)
        .foregroundStyle(.primary)
        .accessibilityLabel(dictator.isRecording ? "Diktat beenden" : "Diktieren")
        .animation(.easeOut(duration: 0.1), value: dictator.level)
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
        guard !trimmed.isEmpty else { return }
        session.sendText(trimmed)
        text = ""
        focused = false
        textBeforeDictation = ""
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
