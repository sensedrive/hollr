import SwiftUI

/// What the dictation screen opens with: the text typed before and after the cursor.
struct DictationRequest: Identifiable {
    let id = UUID()
    let before: String
    let after: String
}

/// Full-screen dictation, like ChatGPT's voice input: one tap on the mic opens it and it listens right away.
/// What you say appears live; the big button in the middle pauses and resumes; ✓ ends. Then the text is there
/// to edit before it goes out (or into the input field). ✕ throws it away. Einstellungen › Sprache uses the same
/// screen to try the engine.
struct DictationOverlay: View {
    enum Mode {
        /// a chat: send the text, or keep it in the composer
        case chat(send: (String) -> Void, keep: (String) -> Void)
        /// the settings' test: the text comes back
        case test(done: (String) -> Void)
    }

    /// text typed around the cursor when the mic was tapped – the dictation goes in between
    let before: String
    let after: String
    let context: DictationContext
    /// one microphone app-wide: who the running dictation belongs to (the chat's draft key)
    let owner: String
    let mode: Mode

    @Environment(\.dismiss) private var dismiss
    @Environment(Dictator.self) private var dictator
    @Environment(DictationSettings.self) private var settings
    /// the text to check and edit once the dictation ended; nil while listening
    @State private var review: String?
    /// text that stays before / after the next dictation (the typed text, or what was reviewed when you continue)
    @State private var head = ""
    @State private var tail = ""
    @State private var started = false
    @FocusState private var editing: Bool

    private var mine: Bool { dictator.owner == owner }
    private var listening: Bool { mine && dictator.isRecording }
    private var converting: Bool { mine && dictator.state == .transcribing }
    private var preparing: Bool {
        guard mine, case .preparing = dictator.state else { return false }
        return true
    }
    private var failure: String? {
        guard review == nil, case .failed(let message) = dictator.state else { return nil }
        return message
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            if let review {
                reviewBody(review)
            } else if let failure {
                failureBody(failure)
            } else {
                transcript
                controls
            }
        }
        .background(Theme.bg.ignoresSafeArea())
        .task {
            guard !started else { return }
            started = true
            head = before
            tail = after
            dictator.composerAppeared(owner)
            await listen()
        }
        .onDisappear {
            if mine && dictator.isBusy { dictator.cancel() }
            dictator.composerDisappeared(owner)
        }
        .interactiveDismissDisabled()
    }

    // MARK: Top bar – ✕, what dictates, clock

    private var topBar: some View {
        HStack(spacing: Gap.m) {
            // while listening the trash button below throws it away; reviewing has no other way out
            if review != nil || failure != nil {
                Button(action: discard) {
                    IconView(.x, size: 16).foregroundStyle(Theme.fg)
                        .frame(width: Metric.touch, height: Metric.touch)
                        .background(Theme.wash(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .accessibilityLabel("Verwerfen")
            } else {
                Color.clear.frame(width: Metric.touch, height: Metric.touch)
            }
            Spacer(minLength: 0)
            VStack(spacing: 2) {
                Text(review == nil ? String(localized: "Diktat") : String(localized: "Text prüfen"))
                    .font(Typo.lg).foregroundStyle(Theme.fg)
                Text(settings.engineLabel).font(Typo.sm).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
            // the clock keeps the bar balanced: same width as ✕
            TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                Text(review == nil ? clock(dictator.recordedSeconds) : "")
                    .font(Typo.monoSmall.monospacedDigit()).foregroundStyle(Theme.muted)
            }
            .frame(width: Metric.touch)
        }
        .padding(.horizontal, Gap.l).padding(.top, Gap.s).padding(.bottom, Gap.m)
    }

    private func clock(_ seconds: Double) -> String {
        let s = Int(seconds)
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    // MARK: Listening – live text

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Gap.m) {
                    liveText
                        .font(.title3)
                        .lineSpacing(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, Gap.xl).padding(.top, Gap.l)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: dictator.text) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("end", anchor: .bottom) }
            }
        }
        .frame(maxHeight: .infinity)
    }

    /// typed text quiet, the spoken text bright; a hint while nothing is said yet
    private var liveText: Text {
        let spoken = mine ? dictator.text : ""
        let quiet = Theme.muted
        if spoken.isEmpty {
            let hint: String
            if preparing, case .preparing(let message) = dictator.state, !message.isEmpty { hint = message }
            else if preparing { hint = String(localized: "Mikrofon startet …") }
            else if dictator.paused { hint = String(localized: "Pausiert – tippe auf den Knopf, um weiterzusprechen.") }
            else if let model = dictator.loadingModel {
                hint = String(localized: "Sprich ruhig schon – \(model) wird noch geladen. Nach einem App-Update dauert das einmalig ein, zwei Minuten, dann erscheint der Text.")
            }
            else { hint = String(localized: "Sprich einfach los …") }
            return Text(join(head, tail).isEmpty ? "" : join(head, tail) + "\n\n").foregroundColor(quiet)
                + Text(hint).foregroundColor(Theme.dim)
        }
        // what is being said right now (Parakeet/Whisper preview) is softer: it can still change
        let live = mine ? dictator.pending : ""
        let firm = live.isEmpty ? spoken : String(spoken.dropLast(live.count)).trimmingCharacters(in: .whitespaces)
        return Text(head.isEmpty ? "" : head + " ").foregroundColor(quiet)
            + Text(firm).foregroundColor(Theme.fg)
            + Text(live.isEmpty ? "" : (firm.isEmpty ? "" : " ") + live).foregroundColor(Theme.fg.opacity(0.6))
            + Text(tail.isEmpty ? "" : " " + tail).foregroundColor(quiet)
    }

    // MARK: Listening – controls (✕ discard · big pause/resume · ✓ done)

    private var controls: some View {
        VStack(spacing: Gap.l) {
            HStack(alignment: .center) {
                sideButton(icon: .trash, label: String(localized: "Verwerfen"), filled: false, action: discard)
                    .keyboardShortcut(.cancelAction)
                Spacer(minLength: 0)
                bigButton
                Spacer(minLength: 0)
                sideButton(icon: .check, label: String(localized: "Fertig"), filled: true, action: finish)
                    .disabled(!listening)
                    .keyboardShortcut(.return, modifiers: [])
            }
            .padding(.horizontal, Gap.xxl)
            Text(statusLine).font(Typo.sm).foregroundStyle(Theme.muted)
                .frame(minHeight: 18)
                .contentTransition(.opacity)
                .animation(.easeOut(duration: 0.15), value: statusLine)
        }
        .padding(.top, Gap.l).padding(.bottom, Gap.xl)
    }

    private var statusLine: String {
        if converting {
            return dictator.loadingModel.map { String(localized: "\($0) wird geladen …") } ?? String(localized: "Wandle um …")
        }
        if listening, !dictator.paused, let model = dictator.loadingModel { return String(localized: "Hört zu · \(model) lädt") }
        if preparing { return String(localized: "Einen Moment …") }
        if dictator.paused { return String(localized: "Pausiert") }
        return listening ? String(localized: "Hört zu") : ""
    }

    /// pause while listening, resume while paused; a spinner while the microphone starts or the text is made
    private var bigButton: some View {
        let level = CGFloat(min(dictator.level * 10, 1))
        let active = listening && !dictator.paused
        return Button {
            Haptics.tap(.medium)
            dictator.paused ? dictator.resume() : dictator.pause()
        } label: {
            ZStack {
                // the voice: two soft rings that grow with the level
                Circle().fill(Theme.accent.opacity(0.12))
                    .scaleEffect(active ? 1.18 + level * 0.35 : 1)
                Circle().fill(Theme.accent.opacity(0.18))
                    .scaleEffect(active ? 1.06 + level * 0.18 : 1)
                Circle().fill(dictator.paused ? Theme.raised : Theme.accent)
                    .overlay(Circle().strokeBorder(Theme.accent.opacity(dictator.paused ? 0.7 : 0), lineWidth: 2))
                if converting || preparing {
                    Spinner(color: Theme.onAccent, size: 26)
                } else {
                    Image(systemName: dictator.paused ? "mic.fill" : "pause.fill")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(dictator.paused ? Theme.accent : Theme.onAccent)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .frame(width: 96, height: 96)
            .animation(.easeOut(duration: 0.12), value: level)
            .animation(.spring(duration: 0.3), value: dictator.paused)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!listening)
        .keyboardShortcut(.space, modifiers: [])
        .accessibilityLabel(dictator.paused ? "Weitersprechen" : "Pausieren")
    }

    private func sideButton(icon: HIcon, label: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                IconView(icon, size: 20)
                    .foregroundStyle(filled ? Theme.onAccent : Theme.fg)
                    .frame(width: 58, height: 58)
                    .background(filled ? Theme.fg : Theme.wash(0.1), in: Circle())
                Text(label).font(Typo.sm).foregroundStyle(Theme.muted)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: Review – edit, then send

    private func reviewBody(_ text: String) -> some View {
        VStack(spacing: 0) {
            if let notice = dictator.notice {
                Label(notice, icon: .info).font(Typo.sm).foregroundStyle(Theme.warn)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Gap.xl).padding(.bottom, Gap.s)
            }
            TextEditor(text: Binding(get: { review ?? "" }, set: { review = $0 }))
                .font(.title3)
                .lineSpacing(4)
                .scrollContentBackground(.hidden)
                .focused($editing)
                .padding(.horizontal, Gap.l)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Nichts verstanden – sprich weiter oder tippe selbst.")
                            .font(.title3).foregroundStyle(Theme.dim)
                            .padding(.horizontal, Gap.l + 5).padding(.top, 8)
                            .allowsHitTesting(false)
                    }
                }
            HStack(spacing: Gap.s) {
                Button(action: continueDictating) {
                    Label("Weiter diktieren", icon: .mic)
                }
                .buttonStyle(.hollr(.secondary))
                Spacer(minLength: 0)
                switch mode {
                case .chat(let send, let keep):
                    Button("Ins Eingabefeld") {
                        keep(text)
                        dismiss()
                    }
                    .buttonStyle(.hollr(.ghost))
                    Button {
                        Haptics.notify(.success)
                        send(text.trimmingCharacters(in: .whitespacesAndNewlines))
                        dismiss()
                    } label: {
                        SendButtonLabel(ready: !trimmed(text).isEmpty, size: 52)
                    }
                    .buttonStyle(.plain)
                    .disabled(trimmed(text).isEmpty)
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityLabel("Senden")
                case .test(let done):
                    Button("Fertig") {
                        done(text)
                        dismiss()
                    }
                    .buttonStyle(.hollr(.primary))
                    .keyboardShortcut(.return, modifiers: .command)
                }
            }
            .padding(.horizontal, Gap.l).padding(.vertical, Gap.m)
        }
    }

    // MARK: Failure – the reason, and what to do

    private func failureBody(_ message: String) -> some View {
        VStack(spacing: Gap.l) {
            Spacer()
            IconView(.alert, size: 28).foregroundStyle(Theme.warn)
            Text(message).font(Typo.md).foregroundStyle(Theme.fg).multilineTextAlignment(.center)
                .padding(.horizontal, Gap.xl)
            HStack(spacing: Gap.s) {
                Button("Schließen", action: discard).buttonStyle(.hollr(.secondary))
                Button("Erneut versuchen") { Task { await listen() } }.buttonStyle(.hollr(.primary))
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Actions

    private func listen() async {
        Haptics.tap(.medium)
        await dictator.start(settings: settings, context: context, owner: owner) { spoken in
            delivered(spoken)
        }
    }

    /// the dictation ended (✓, the system stopped it, the app went away): send right away when asked to, else review
    private func delivered(_ result: String) {
        var spoken = result
        var sendNow = settings.autoSend
        if settings.voiceSend {
            let (rest, said) = DictationText.voiceSend(spoken)
            if said { spoken = rest; sendNow = true }
        }
        let text = join(join(head, spoken), tail)
        if sendNow, case .chat(let send, _) = mode, !trimmed(text).isEmpty {
            Haptics.notify(.success)
            send(trimmed(text))
            dismiss()
            return
        }
        Haptics.notify(spoken.isEmpty ? .warning : .success)
        review = text
        editing = true
    }

    private func finish() {
        Haptics.tap(.light)
        Task { await dictator.finish() }
    }

    /// back to listening; the reviewed text stays in front of what comes next
    private func continueDictating() {
        head = review ?? ""
        tail = ""
        review = nil
        editing = false
        Task { await listen() }
    }

    private func discard() {
        Haptics.tap(.light)
        if mine && dictator.isBusy { dictator.cancel() }
        dismiss()
    }

    private func join(_ a: String, _ b: String) -> String {
        [a, b].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
}
