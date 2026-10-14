import SwiftUI

/// One agent: conversation history, live voice (omp), typing, quick switching.
struct AgentDetailView: View {
    let agentId: String
    @Binding var path: [String]
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions

    var body: some View {
        if let session = resolveSession() {
            AgentConversation(session: session, path: $path)
                .id(agentId)
        } else {
            ContentUnavailableView("Agent nicht gefunden", systemImage: "questionmark.circle",
                                   description: Text("Die Session existiert in herdr nicht mehr."))
        }
    }

    private func resolveSession() -> AgentSession? {
        if let ref = herdr.ref(id: agentId, servers: store.servers) { return sessions.session(for: ref) }
        return sessions.sessions[agentId]
    }
}

private struct AgentConversation: View {
    @Bindable var session: AgentSession
    @Binding var path: [String]
    @Environment(MySessions.self) private var mySessions
    @Environment(SessionStore.self) private var sessions
    @Environment(HerdrStore.self) private var herdr
    @Environment(ServerStore.self) private var store

    @State private var confirmClose = false
    @State private var gitSpace: Space?
    @State private var switchModel = false
    /// keyboard is up → hide everything but transcript and composer
    @State private var editing = false
    /// reading mode → transcript only, full screen
    @State private var reading = false
    @AppStorage(TextScale.key) private var scaleIndex = TextScale.system
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var scaleToast: String?

    private var compact: Bool { editing || reading }

    private func rescale(by delta: Int) {
        scaleIndex = TextScale.step(scaleIndex, system: typeSize, by: delta)
        let label = TextScale.label(TextScale.steps[scaleIndex])
        withAnimation { scaleToast = label }
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            if scaleToast == label { withAnimation { scaleToast = nil } }
        }
    }

    private var ref: AgentRef { session.ref }

    /// The repo this chat's workspace works in.
    private func openGit() async {
        let ws = ref.pane.pane.split(separator: ":").first.map(String.init) ?? ""
        if herdr.spaces[ref.server.id]?.contains(where: { $0.id == ws }) != true {
            await herdr.refreshSpaces([ref.server])
        }
        gitSpace = herdr.spaces[ref.server.id]?.first { $0.id == ws && $0.git != nil }
    }

    private func closeChat() {
        if session.isLive { session.stop() }
        Task {
            do {
                try await HollrClient.close(ref.server, pane: ref.pane.pane)
                path.removeAll()
                await herdr.refresh(store.servers)
            } catch {
                HollrLog.error("close: \(error)")
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // omp shows status in its footer; other agents keep the small header
            if !compact && !session.usesTimeline { header }
            transcript
                .overlay(alignment: .top) { scaleToastView }
                .overlay(alignment: .topTrailing) { if reading { readingBar } }
                .safeAreaInset(edge: .bottom) { if reading { zenComposer } }
            if !reading { controls }
        }
        .animation(.easeInOut(duration: 0.2), value: reading)
        .themedPage()
        .toolbar(reading ? .hidden : .visible, for: .navigationBar)
        .toolbar(reading ? .hidden : .visible, for: .tabBar)
        .statusBarHidden(reading)
        .navigationTitle(session.timeline?.cleanTitle.map { _ in ref.title } ?? ref.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { dismissKeyboard(); reading = true } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .accessibilityLabel("Zen-Modus")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if ref.pane.agent != nil {
                        Button { switchModel = true } label: {
                            Label("Modell wechseln", systemImage: "cpu")
                        }
                    }
                    Button { Task { await openGit() } } label: {
                        Label("Git & Dateien", systemImage: "arrow.triangle.branch")
                    }
                    Section("Textgröße") {
                        Button { rescale(by: 1) } label: { Label("Größer", systemImage: "textformat.size.larger") }
                        Button { rescale(by: -1) } label: { Label("Kleiner", systemImage: "textformat.size.smaller") }
                        Button { scaleIndex = TextScale.system } label: { Label("Wie iOS", systemImage: "arrow.counterclockwise") }
                    }
                    Button(role: .destructive) { confirmClose = true } label: {
                        Label("Chat schließen", systemImage: "xmark.circle")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .sheet(isPresented: $switchModel) {
            ModelSwitchSheet(session: session).presentationDetents([.large])
        }
        .sheet(item: $gitSpace) { space in
            NavigationStack {
                GitPanel(server: ref.server, space: space, showAgents: false, tab: .changes)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) { Button("Fertig") { gitSpace = nil } }
                    }
            }
            .presentationDetents([.large])
        }
        .confirmationDialog("Chat schließen?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Schließen", role: .destructive) { closeChat() }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Das Pane „\(ref.title)“ wird in herdr auf \(ref.server.label) geschlossen und \(ref.pane.agentName) beendet.")
        }
        .task {
            // keep the conversation fresh while visible (live calls stream it themselves)
            while !Task.isCancelled {
                if session.usesTimeline {
                    await session.loadTimeline()
                } else {
                    await session.loadHistory()
                }
                await session.loadScreen()
                // 1.5 s while omp works or waits, 5 s when idle, paused while dictating – sooner on nudge()
                await session.waitForPoll()
            }
        }
        #if DEBUG
        .task { if UserDefaults.standard.string(forKey: "hollrLive") == ref.pane.pane { session.start() } }
        #endif
        .onAppear {
            PushManager.shared.visibleAgentId = ref.id
            mySessions.touch(ref.id)
        }
        .onDisappear { if PushManager.shared.visibleAgentId == ref.id { PushManager.shared.visibleAgentId = nil } }
        // the server's live feed saw a change (status, new pane …): refresh this chat now
        .onChange(of: herdr.changeCount) { _, _ in session.nudge() }
        .onChange(of: session.isLive) { _, live in
            UIApplication.shared.isIdleTimerDisabled = live
        }
        .sensoryFeedback(.impact, trigger: session.phase == .live)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(session.timeline?.running == true && session.agentStatus != "blocked" ? Theme.work : Theme.statusColor(session.agentStatus)).frame(width: 8, height: 8)
            Text(ref.pane.agent == nil
                 ? String(localized: "Terminal · \(ref.pane.folder)")
                 : "\(ref.pane.agentName) · \(session.timeline?.running == true && session.agentStatus != "blocked" ? "arbeitet" : Theme.statusLabel(session.agentStatus))")
            if session.phase == .live {
                Text("· Live: \(Theme.ompStateLabel(session.ompState))").foregroundStyle(session.muted ? Theme.warn : Theme.live)
            }
            Spacer()
            Text(ref.server.label)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    Text(session.timeline?.cleanTitle ?? ref.pane.title)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 4)
                    if session.usesTimeline {
                        let tl = session.timeline ?? .empty
                        if tl.items.isEmpty && session.items.isEmpty { emptyHint }
                        ForEach(tl.visibleItems) { item in
                            TimelineRow(item: item) { index, _ in session.answer(option: index) }
                                .equatable() // unchanged entries are not re-rendered on every refresh
                                .id(item.id)
                        }
                        // typed prompts not yet in the log, live notices
                        ForEach(session.items.filter { !$0.final || $0.kind == .info }) { item in
                            Bubble(item: item).id(item.id)
                        }
                    } else {
                        if session.items.isEmpty && (session.screen.isEmpty || !session.showsScreen) { emptyHint }
                        ForEach(session.items) { item in
                            Bubble(item: item).id(item.id)
                        }
                    }
                    // omp's question already shows as an Ask card – the raw screen would only repeat it
                    let askShown = session.usesTimeline && (session.timeline?.visibleItems.contains {
                        if case .ask(_, _, _, _, true) = $0 { return true } else { return false }
                    } ?? false)
                    if session.showsScreen && !session.screen.isEmpty && !askShown {
                        TerminalCard(text: session.screen, waiting: session.agentStatus == "blocked",
                                     collapsible: session.usesTimeline)
                    }
                    if case .failed(let message) = session.phase {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote).foregroundStyle(Theme.warn)
                            .frame(maxWidth: .infinity)
                    } else if let error = session.lastError {
                        Text(error).font(.footnote).foregroundStyle(Theme.warn).frame(maxWidth: .infinity)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(TapGesture().onEnded { if editing { dismissKeyboard() } })
            // pinch to scale all text (one step per pinch)
            .simultaneousGesture(
                MagnifyGesture()
                    .onEnded { value in
                        if value.magnification > 1.15 { rescale(by: 1) } else if value.magnification < 0.87 { rescale(by: -1) }
                    }
            )
            .defaultScrollAnchor(.bottom)
            .onChange(of: session.screen) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: session.timeline?.items.count) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: session.items.count) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    @ViewBuilder private var emptyHint: some View {
        VStack(spacing: 8) {
            if !session.historyLoaded {
                Skeleton(style: .chat, count: 6).frame(height: 420)
            } else if session.phase == .connecting {
                Text("omp /live wird gestartet …")
            } else if session.phase == .live {
                Text("Ich höre zu …")
            } else if ref.pane.live {
                Text("Tippe auf den Kreis und sprich mit omp.")
                Text("Was du sagst, landet direkt in dieser Session – wie /live am Rechner.").font(.footnote)
            } else if ref.pane.agent != nil {
                Text("Sprechen geht bisher nur mit omp.")
                Text("An \(ref.pane.agentName) kannst du unten Text schicken.").font(.footnote)
            } else {
                Text("Hier läuft kein Agent, nur eine Shell.")
            }
        }
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    // MARK: Reading mode / scale

    @ViewBuilder private var scaleToastView: some View {
        if let scaleToast {
            Label(scaleToast, systemImage: "textformat.size")
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Theme.card, in: Capsule())
                .id(scaleToast)
                .padding(.top, reading ? 56 : 10)
                .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    private var readingBar: some View {
        HStack(spacing: 4) {
            Button { rescale(by: -1) } label: { Image(systemName: "textformat.size.smaller").frame(width: 44, height: 44) }
                .accessibilityLabel("Text kleiner")
            Button { rescale(by: 1) } label: { Image(systemName: "textformat.size.larger").frame(width: 44, height: 44) }
                .accessibilityLabel("Text größer")
            Divider().frame(height: 22)
            Button { reading = false } label: {
                Image(systemName: "arrow.down.right.and.arrow.up.left").frame(width: 44, height: 44)
            }
            .accessibilityLabel("Zen-Modus beenden")
        }
        .font(.body.weight(.semibold))
        .foregroundStyle(.primary)
        .padding(.horizontal, 6)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(Theme.fg.opacity(0.1)))
        .padding(.trailing, 12).padding(.top, 2)
    }

    /// Zen: only transcript and a see-through composer floating over it.
    private var zenComposer: some View {
        VStack(spacing: 6) {
            if let timeline = session.timeline, AgentHUD.isVisible(timeline) {
                AgentHUD(timeline: timeline)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(.ultraThinMaterial.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            Composer(session: session, editing: $editing, translucent: true)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }

    // MARK: Controls

    private var controls: some View {
        VStack(spacing: 8) {
            if !editing, let timeline = session.timeline, AgentHUD.isVisible(timeline) {
                AgentHUD(timeline: timeline)
            }
            Composer(session: session, editing: $editing)
            if !editing {
                // omp's footer sits right under the editor
                if let line = session.timeline?.line {
                    // tap the model to switch it (like clicking omp's status line)
                    StatusLineView(line: line, running: session.timeline?.running == true)
                        .contentShape(Rectangle())
                        .onTapGesture { switchModel = true }
                }
                AgentSwitcher(current: ref) { path = [$0] }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }
}

/// The agent's terminal screen (Claude & co, or a question waiting for an answer).
private struct TerminalCard: View {
    let text: String
    let waiting: Bool
    /// omp chats: the screen is only a fallback – start folded so it doesn't cover the chat
    var collapsible = false
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if collapsible { withAnimation(.snappy) { expanded.toggle() } }
            } label: {
                HStack {
                    Label(waiting ? String(localized: "Wartet auf dich – antworte mit >_ (z. B. ↓ und Enter)") : String(localized: "Terminal"),
                          systemImage: waiting ? "exclamationmark.bubble.fill" : "terminal")
                    Spacer(minLength: 0)
                    if collapsible {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down").foregroundStyle(.secondary)
                    }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(waiting ? Theme.warn : .secondary)
            }
            .buttonStyle(.plain)
            .disabled(!collapsible)
            if !collapsible || expanded {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(text)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(waiting ? Theme.warn.opacity(0.5) : Theme.fg.opacity(0.08)))
    }
}

/// Chip strip to jump to other agents (like Heeler's switcher).
private struct AgentSwitcher: View {
    let current: AgentRef
    let onSwitch: (String) -> Void
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions

    var body: some View {
        let others = herdr.allAgents(store.servers)
        if others.count > 1 {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(others) { ref in
                            Button { onSwitch(ref.id) } label: {
                                HStack(spacing: 6) {
                                    Circle().fill(Theme.statusColor(ref.pane.status)).frame(width: 7, height: 7)
                                    Text(ref.title).lineLimit(1)
                                    if sessions.sessions[ref.id]?.isLive == true {
                                        Image(systemName: "waveform").foregroundStyle(Theme.live)
                                    }
                                }
                                .font(.caption.weight(.medium))
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(ref.id == current.id ? Theme.accent.opacity(0.3) : Theme.card, in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .id(ref.id)
                        }
                    }
                }
                .onAppear { proxy.scrollTo(current.id, anchor: .center) }
            }
        }
    }
}

private struct Bubble: View {
    let item: TranscriptItem

    var body: some View {
        switch item.kind {
        case .voice, .typed:
            HStack(alignment: .bottom, spacing: 6) {
                Spacer(minLength: 40)
                Image(systemName: item.kind == .voice ? "waveform" : "keyboard")
                    .font(.caption2).foregroundStyle(.secondary)
                Text(item.text)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.accent.opacity(item.final ? 0.35 : 0.2), in: RoundedRectangle(cornerRadius: 18))
            }
        case .agent:
            AgentMarkdown(text: item.text, dimmed: !item.final)
        case .tool:
            Label(item.text, systemImage: "hammer.fill")
                .font(.caption.monospaced())
                .foregroundStyle(Theme.work)
                .lineLimit(1)
                .padding(.leading, 6)
        case .info:
            Text(item.text).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        }
    }
}

struct RoundButton: View {
    let systemImage: String
    let active: Bool
    let enabled: Bool
    var tint: Color? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.title2)
                .frame(width: 58, height: 58)
                .background(background, in: Circle())
                .foregroundStyle(active ? Theme.onAccent : (tint == nil ? .primary : .white))
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
    }

    private var background: Color {
        if active { return Theme.warn.opacity(0.9) }
        return tint ?? Theme.card
    }
}

/// Glowing orb that breathes with the audio level.
struct Orb: View {
    var level: Float
    var color: Color
    var size: CGFloat

    var body: some View {
        let scale = 1 + CGFloat(min(level, 1)) * 0.18
        ZStack {
            Circle()
                .fill(color.opacity(0.25))
                .frame(width: size * 1.35, height: size * 1.35)
                .scaleEffect(scale)
                .blur(radius: 18)
            Circle()
                .fill(
                    RadialGradient(
                        colors: [color.opacity(0.95), color.opacity(0.75), color.opacity(0.35)],
                        center: UnitPoint(x: 0.35, y: 0.3), startRadius: 2, endRadius: size * 0.7
                    )
                )
                .frame(width: size, height: size)
                .scaleEffect(scale)
                .shadow(color: color.opacity(0.5), radius: 18, y: 8)
        }
        .animation(.easeOut(duration: 0.12), value: level)
        .animation(.easeInOut(duration: 0.3), value: color)
    }
}


/// omp's footer: model · folder · branch *dirty · context
struct StatusLineView: View {
    let line: StatusLine
    var running = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                if running { BrailleSpinner(color: Omp.accent) }
                if let model = line.model {
                    Label(model, systemImage: "circle.hexagongrid.fill").foregroundStyle(Omp.custom)
                }
                if let folder = line.folder {
                    Label("…\(folder)", systemImage: "folder.fill").foregroundStyle(.primary.opacity(0.8))
                }
                if let branch = line.branch {
                    HStack(spacing: 3) {
                        Image(systemName: "arrow.triangle.branch")
                        Text(branch)
                        if let dirty = line.dirty, dirty > 0 { Text("*\(dirty)") }
                    }
                    .foregroundStyle(Omp.accent)
                }
                if let context = line.context {
                    Label(context, systemImage: "gauge.with.dots.needle.33percent").foregroundStyle(Omp.muted)
                }
                if let cost = line.cost {
                    Text("$\(cost)").foregroundStyle(Omp.dim)
                }
            }
            .font(.caption2.monospaced())
            .padding(.horizontal, 6)
        }
    }
}
