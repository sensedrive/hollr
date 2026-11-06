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
            if !herdr.loaded {
                // cold start / opened from a notification: the tree is still loading
                Spinner(color: Theme.muted, size: 20).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                EmptyState(icon: .help, title: String(localized: "Agent nicht gefunden"),
                           text: String(localized: "Die Session existiert in herdr nicht mehr."))
                    .frame(maxHeight: .infinity)
            }
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
    /// herdr refused to close the chat – shown, the chat stays
    @State private var closeError: String?
    @State private var gitSpace: Space?
    @State private var switchModel = false
    @State private var showTerminal = false
    /// keyboard is up → hide everything but transcript and composer
    @State private var editing = false
    /// reading mode → transcript only, full screen
    @State private var reading = false
    /// at the end of the chat: new output scrolls into view
    @State private var following = true
    @State private var readingAnchor: String?
    @State private var unseen = 0
    @Environment(\.dismiss) private var dismiss
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
                // in a sheet the chat is the root (empty path): close the sheet instead
                if path.isEmpty { dismiss() } else { path.removeAll() }
                await herdr.refresh(store.servers)
            } catch {
                HollrLog.error("close: \(error)")
                closeError = error.localizedDescription
            }
        }
    }

    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.expandSheet) private var expandSheet
    /// iPhone in landscape: chat on the left, terminal or changes on the right
    private var landscape: Bool { verticalSizeClass == .compact && !reading }

    var body: some View {
        VStack(spacing: 0) {
            if !compact { header }
            HStack(spacing: 0) {
                conversation
                if landscape {
                    Rectangle().fill(Theme.border).frame(width: 1)
                    SidePanel(ref: ref)
                        .containerRelativeFrame(.horizontal) { width, _ in width * 0.5 }
                }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: reading)
        .fullScreenCover(isPresented: $showTerminal) { TerminalScreen(ref: ref) }
        // the zen composer goes away with the keyboard up: its focus change never arrives
        .onChange(of: reading) { _, zen in
            editing = false
            if zen { expandSheet?() }
        }
        .themedPage()
        .toolbar(reading ? .hidden : .visible, for: .navigationBar)
        .toolbar(reading || landscape ? .hidden : .visible, for: .tabBar)
        .statusBarHidden(reading)
        .navigationTitle(session.timeline?.cleanTitle.map { _ in ref.title } ?? ref.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await openGit() } } label: { Image(.branch) }
                    .buttonStyle(.icon())
                    .accessibilityLabel("Git & Dateien")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { dismissKeyboard(); reading = true } label: { Image(.maximize) }
                    .buttonStyle(.icon())
                    .accessibilityLabel("Zen-Modus")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if ref.pane.agent != nil {
                        Button { switchModel = true } label: { Label("Modell wechseln", icon: .cpu) }
                    }
                    Button { showTerminal = true } label: { Label("Terminal", icon: .terminal) }
                    Section("Textgröße") {
                        Button { rescale(by: 1) } label: { Label("Größer", systemImage: "textformat.size.larger") }
                        Button { rescale(by: -1) } label: { Label("Kleiner", systemImage: "textformat.size.smaller") }
                        Button { scaleIndex = TextScale.system } label: { Label("Wie iOS", systemImage: "arrow.counterclockwise") }
                    }
                    Button(role: .destructive) { confirmClose = true } label: {
                        Label("Chat schließen", icon: .x)
                    }
                } label: { Image(.more).foregroundStyle(Theme.muted) }
                .accessibilityLabel("Mehr")
            }
        }
        .sheet(isPresented: $switchModel) {
            ModelSwitchSheet(session: session).presentationDetents([.large])
        }
        .sheet(item: $gitSpace) { space in
            NavigationStack {
                GitPanel(server: ref.server, space: space, tab: .changes)
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
        .alert("Chat ließ sich nicht schließen", isPresented: Binding(get: { closeError != nil }, set: { if !$0 { closeError = nil } })) {
            Button("OK") { closeError = nil }
        } message: { Text(closeError ?? "") }
        .task {
            // omp: the chat streams in (`gate follow`); older servers are polled
            guard session.usesTimeline else { return }
            var failures = 0
            while !Task.isCancelled {
                let started = Date()
                guard await session.follow() else {
                    // server without `follow`: poll like before
                    while !Task.isCancelled {
                        await session.loadTimeline()
                        await session.waitForPoll()
                    }
                    return
                }
                // the stream ended (network, pane gone, gap): reconnect, slower when it keeps failing
                failures = Date().timeIntervalSince(started) > 30 ? 0 : failures + 1
                try? await Task.sleep(for: .seconds(min(Double(failures) * 2, 15)))
            }
        }
        .task {
            // other agents' history, and the terminal screen while one waits for you
            while !Task.isCancelled {
                if !session.usesTimeline { await session.loadHistory() }
                await session.loadScreen()
                // 1.5 s while busy, 5 s idle, paused while dictating – sooner on nudge()
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

    // MARK: Header (organism AgentHeader)

    /// omp reports "working" a moment late: a running turn counts as working unless it waits for you
    private var shownStatus: String {
        session.timeline?.running == true && session.agentStatus != "blocked" ? "working" : session.agentStatus
    }

    /// Status dot, agent badge, state and server – and the Chat / Terminal switch.
    private var header: some View {
        HStack(spacing: Gap.s) {
            AgentBadge(pane: ref.pane)
            StatusDot(status: shownStatus, agent: ref.pane.agent != nil, pulse: shownStatus == "working")
            HStack(spacing: 4) {
                Text(ref.pane.agent == nil
                     ? String(localized: "Terminal · \(ref.pane.folder)")
                     : Theme.statusLabel(shownStatus))
                    .foregroundStyle(ref.pane.agent == nil ? Theme.muted : Theme.statusColor(shownStatus))
                if session.phase == .live {
                    Text("· Live: \(Theme.ompStateLabel(session.ompState))").foregroundStyle(session.muted ? Theme.warn : Theme.live)
                }
                Text("· \(ref.server.label)").foregroundStyle(Theme.dim)
            }
            .font(Typo.sm)
            .lineLimit(1)
            Spacer(minLength: Gap.xs)
            Segmented(label: String(localized: "Ansicht"),
                      options: [(value: false, title: String(localized: "Chat")), (value: true, title: String(localized: "Terminal"))],
                      selection: Binding(get: { terminalView }, set: { if $0 != terminalView { toggleView() } }))
        }
        .padding(.horizontal, Gap.l)
        .padding(.vertical, 6)
        .background(Theme.bg)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    // MARK: Transcript

    /// Follow new output only while you are at the end – scrolling up to read stops it.
    private func follow(_ proxy: ScrollViewProxy, animated: Bool = true) {
        guard following else { unseen += 1; return }
        if animated { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) } }
        else { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    private func settleAtBottom(_ proxy: ScrollViewProxy) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    /// The chat's rows (own function: inside `transcript` the Release compiler needed >300 ms).
    @ViewBuilder private func transcriptRows(_ visible: [TimelineItem]) -> some View {
                    Text(session.timeline?.cleanTitle ?? ref.pane.title)
                        .font(Typo.sm).foregroundStyle(Theme.dim)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, Gap.xs)
                    if session.usesTimeline {
                        let tl = session.timeline ?? .empty
                        if tl.items.isEmpty && session.items.isEmpty { emptyHint }
                        ForEach(visible) { item in
                            TimelineRow(item: item) { ask, picks in await session.answer(ask: ask, picks: picks) }
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
                    let askShown = session.usesTimeline && visible.contains {
                        if case .ask(_, _, _, true) = $0 { return true } else { return false }
                    }
                    if session.showsScreen && !session.screen.isEmpty && !askShown {
                        TerminalCard(text: session.screen, waiting: session.agentStatus == "blocked",
                                     collapsible: session.usesTimeline)
                    }
                    if case .failed(let message) = session.phase {
                        Label(message, icon: .alert)
                            .font(Typo.note).foregroundStyle(Theme.warn)
                            .frame(maxWidth: .infinity)
                    } else if let error = session.lastError {
                        Text(error).font(Typo.note).foregroundStyle(Theme.warn).frame(maxWidth: .infinity)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        // iOS 17: the end of the list on screen = following (iOS 18 measures the distance)
                        .onAppear { if #unavailable(iOS 18) { following = true; unseen = 0 } }
                        .onDisappear { if #unavailable(iOS 18) { following = false } }
                    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // computed once per update (it filters the whole list)
                let visible = session.timeline?.visibleItems ?? []
                LazyVStack(alignment: .leading, spacing: Gap.m) { transcriptRows(visible) }
                .scrollTargetLayout()
                .padding(.horizontal, Gap.m)
                .padding(.vertical, Gap.l)
            }
            // while you read, the entry at the top stays put – even when entries below change size
            .scrollPosition(id: $readingAnchor, anchor: .top)
            .modifier(FollowTracker(following: $following, unseen: $unseen))
            .overlay(alignment: .bottomTrailing) {
                if !following {
                    JumpToEnd(unseen: unseen) {
                        following = true
                        unseen = 0
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                }
            }
            .animation(.easeOut(duration: 0.15), value: following)
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(TapGesture().onEnded { if editing { dismissKeyboard() } })
            // pinch to scale all text (one step per pinch)
            .simultaneousGesture(
                MagnifyGesture()
                    .onEnded { value in
                        if value.magnification > 1.15 { rescale(by: 1) } else if value.magnification < 0.87 { rescale(by: -1) }
                    }
            )
            .modifier(BottomAnchor())
            // zen on/off swaps the composer: the lazy rows lose their layout and stay blank until the
            // list scrolls – scroll once the new layout has settled
            // zen on/off swaps the composer, and a restored multi-line draft makes it tall from the start:
            // the lazy list then sits past its end (blank) – scroll to the end once the layout has settled
            .onChange(of: reading) { settleAtBottom(proxy) }
            .onChange(of: session.historyLoaded) { settleAtBottom(proxy) }
            .task { settleAtBottom(proxy) }
            // the waiting screen redraws every second: follow it without animation, and never count it as new
            .onChange(of: session.screen) { if following { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: session.timeline?.items.count) { follow(proxy) }
            .onChange(of: session.items.count) { follow(proxy) }
        }
    }

    @ViewBuilder private var emptyHint: some View {
        VStack(spacing: Gap.s) {
            if !session.historyLoaded {
                Skeleton(style: .chat, count: 6).frame(height: 420)
            } else if session.phase == .connecting {
                Text("omp /live wird gestartet …")
            } else if session.phase == .live {
                Text("Ich höre zu …")
            } else if ref.pane.live {
                Text("Schreib unten, diktiere mit dem Mikrofon – oder tippe auf „Live“ und sprich mit omp.")
                Text("Live landet direkt in dieser Session – wie /live am Rechner.").font(Typo.note).foregroundStyle(Theme.dim)
            } else if ref.pane.agent != nil {
                Text("Schreib \(ref.pane.agentName) unten eine Nachricht – oder diktiere sie mit dem Mikrofon.")
                Text("Live-Gespräche gibt es nur mit omp.").font(Typo.note).foregroundStyle(Theme.dim)
            } else {
                Text("Hier läuft kein Agent, nur eine Shell.")
            }
        }
        .font(Typo.md)
        .multilineTextAlignment(.center).foregroundStyle(Theme.muted)
        .frame(maxWidth: .infinity)
        .padding(.top, Gap.xxxl)
    }

    // MARK: Reading mode / scale

    @ViewBuilder private var scaleToastView: some View {
        if let scaleToast {
            Label(scaleToast, systemImage: "textformat.size")
                .font(Typo.note.weight(.semibold))
                .padding(.horizontal, 14).padding(.vertical, Gap.s)
                .background(Theme.side, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
                .id(scaleToast)
                .padding(.top, reading ? 56 : 10)
                .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    private var readingBar: some View {
        HStack(spacing: 2) {
            Button { rescale(by: -1) } label: { Image(systemName: "textformat.size.smaller") }
                .buttonStyle(.icon())
                .accessibilityLabel("Text kleiner")
            Button { rescale(by: 1) } label: { Image(systemName: "textformat.size.larger") }
                .buttonStyle(.icon())
                .accessibilityLabel("Text größer")
            Rectangle().fill(Theme.border).frame(width: 1, height: 22)
            Button { reading = false } label: { Image(systemName: "arrow.down.right.and.arrow.up.left") }
                .buttonStyle(.icon())
                .accessibilityLabel("Zen-Modus beenden")
        }
        .padding(.horizontal, Gap.xs)
        .background(Theme.side, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        .padding(.trailing, Gap.m).padding(.top, 2)
    }

    /// tap on the composer's model line: switch the model (agents only)
    private var modelAction: (() -> Void)? {
        ref.pane.agent != nil ? { switchModel = true } : nil
    }

    /// Zen: only transcript and the composer (with its HUD) over it.
    private var zenComposer: some View {
        Composer(session: session, editing: $editing, showsHUD: true, onModel: modelAction)
            .padding(.horizontal, Gap.s)
            .padding(.bottom, Gap.xs)
    }

    /// Chat (Hollr's own rendering of omp's log) or Terminal (the agent's real TUI via herdr attach –
    /// works for every agent, Heeler-style). Remembered separately for omp and the others.
    @AppStorage("chat.view.omp") private var ompView = "chat"
    @AppStorage("chat.view.other") private var otherView = "terminal"
    private var terminalView: Bool { (session.usesTimeline ? ompView : otherView) == "terminal" }

    private func toggleView() {
        let next = terminalView ? "chat" : "terminal"
        if session.usesTimeline { ompView = next } else { otherView = next }
    }

    @ViewBuilder private var conversation: some View {
        if terminalView {
            // the TUI draws its own input line and footer: the composer sits below, not over it
            VStack(spacing: 0) {
                AgentTerminalView(ref: ref)
                    .overlay(alignment: .topTrailing) { if reading { readingBar } }
                if reading { zenComposer } else { controls }
            }
        } else {
            chatConversation
        }
    }

    private var chatConversation: some View {
        // the composer floats over the chat: the conversation scrolls underneath
        transcript
            .overlay(alignment: .top) { scaleToastView }
            .overlay(alignment: .topTrailing) { if reading { readingBar } }
            .safeAreaInset(edge: .bottom) { if reading { zenComposer } else { controls } }
    }

    // MARK: Controls

    private var controls: some View {
        VStack(spacing: Gap.s) {
            Composer(session: session, editing: $editing, showsHUD: !editing && !terminalView, onModel: modelAction)
            if !editing {
                // omp's footer sits right under the editor
                if !terminalView, let line = session.timeline?.line, StatusLineView.hasContent(line) {
                    // tap to switch the model (like clicking omp's status line)
                    StatusLineView(line: line)
                        .contentShape(Rectangle())
                        .onTapGesture { modelAction?() }
                }
                AgentSwitcher(current: ref) { path = [$0] }
            }
        }
        .padding(.horizontal, Gap.s)
        .padding(.top, Gap.s)
        .padding(.bottom, 6)
        // status line and chips stay readable over the chat: the page color fades in towards the bottom
        .background(alignment: .bottom) {
            // below the composer (status line, chips) the page is solid; above it the chat shows through
            LinearGradient(stops: [.init(color: Theme.bg.opacity(0), location: 0),
                                   .init(color: Theme.bg.opacity(0), location: 0.45),
                                   .init(color: Theme.bg, location: 0.62),
                                   .init(color: Theme.bg, location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
        }
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
        VStack(alignment: .leading, spacing: Gap.s) {
            Button {
                if collapsible { withAnimation(.snappy) { expanded.toggle() } }
            } label: {
                HStack(spacing: Gap.s) {
                    Label(waiting ? String(localized: "Wartet auf dich – antworte über die Tasten (z. B. ↓ und Enter)") : String(localized: "Terminal"),
                          icon: waiting ? .help : .terminal)
                    Spacer(minLength: 0)
                    if collapsible {
                        IconView(.chevronRight, size: 12)
                            .foregroundStyle(Theme.dim)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .font(Typo.sm.weight(.semibold))
                .foregroundStyle(waiting ? Theme.warn : Theme.muted)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!collapsible)
            if !collapsible || expanded {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(text)
                        .font(Typo.monoSmall)
                        .foregroundStyle(Theme.fg)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
        }
        .padding(.vertical, Gap.m).padding(.horizontal, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.lg, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg, style: .continuous)
            .strokeBorder(waiting ? Theme.warn.opacity(0.45) : Theme.border, lineWidth: 1))
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
                    HStack(spacing: 6) {
                        ForEach(others) { ref in
                            let selected = ref.id == current.id
                            Button { onSwitch(ref.id) } label: {
                                HStack(spacing: 6) {
                                    StatusDot(status: ref.pane.status, agent: ref.pane.agent != nil, size: 7)
                                    Text(ref.title).lineLimit(1)
                                    // the workspace's color
                                    ProjectBar(color: Theme.identity(ref.workspace), height: 12)
                                    if sessions.sessions[ref.id]?.isLive == true {
                                        IconView(.activity, size: 12).foregroundStyle(Theme.live)
                                    }
                                }
                                .font(Typo.sm.weight(.medium))
                                .foregroundStyle(selected ? Theme.fg : Theme.muted)
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(selected ? Theme.accentSoft : Theme.card, in: Capsule())
                                .overlay(Capsule().strokeBorder(selected ? Theme.accent.opacity(0.6) : Theme.border, lineWidth: 1))
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
                Spacer(minLength: Gap.xxl)
                Image(systemName: item.kind == .voice ? "waveform" : "keyboard")
                    .font(Typo.xs).foregroundStyle(Theme.dim)
                Text(item.text)
                    .userBubbleStyle()
                    // not yet in the agent's log (sess__user[data-pending])
                    .opacity(item.final ? 1 : 0.6)
            }
        case .agent:
            AgentMarkdown(text: item.text, dimmed: !item.final)
        case .tool:
            Label(item.text, systemImage: "hammer")
                .font(Typo.monoSmall)
                .foregroundStyle(Theme.muted)
                .lineLimit(1)
        case .info:
            Text(item.text).font(Typo.sm).foregroundStyle(Theme.dim).frame(maxWidth: .infinity)
        }
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

/// omp's footer under the composer: folder · branch *dirty · cost (model and context sit in the composer).
struct StatusLineView: View {
    let line: StatusLine

    static func hasContent(_ line: StatusLine) -> Bool {
        line.folder != nil || line.branch != nil || line.cost != nil
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Gap.m) {
                if let folder = line.folder {
                    Label("…\(folder)", icon: .folder)
                }
                if let branch = line.branch {
                    HStack(spacing: 3) {
                        Image(.branch)
                        Text(branch)
                        if let dirty = line.dirty, dirty > 0 { Text("*\(dirty)").foregroundStyle(Theme.orange) }
                    }
                }
                if let cost = line.cost {
                    Text("$\(cost)")
                }
            }
            .font(Typo.monoXS)
            .foregroundStyle(Theme.dim)
            .padding(.horizontal, Gap.s)
        }
    }
}

/// Landscape: the right half – the live terminal or the uncommitted changes of this chat's repo.
private struct SidePanel: View {
    let ref: AgentRef
    @Environment(HerdrStore.self) private var herdr
    @AppStorage("landscape.panel") private var panel = "terminal"

    private var space: Space? {
        let ws = ref.pane.pane.split(separator: ":").first.map(String.init) ?? ""
        return herdr.spaces[ref.server.id]?.first { $0.id == ws && $0.git != nil }
    }

    var body: some View {
        VStack(spacing: 0) {
            Segmented(label: String(localized: "Ansicht"),
                      options: [(value: "terminal", title: String(localized: "Terminal")),
                                (value: "changes", title: String(localized: "Änderungen"))],
                      selection: $panel)
                .padding(6)
            switch panel {
            case "changes":
                if let space {
                    ChangesTab(server: ref.server, space: space)
                } else {
                    EmptyState(icon: .branch, title: String(localized: "Kein Git-Repo"),
                               text: String(localized: "Dieser Chat arbeitet nicht in einem Git-Repo."))
                        .frame(maxHeight: .infinity)
                }
            default:
                TerminalPanel(ref: ref).id(ref.id)
            }
        }
        .task { if space == nil { await herdr.refreshSpaces([ref.server]) } }
    }
}

/// Starts at the end; growing content no longer drags a reader back down (iOS 18: only the initial
/// position is anchored at the bottom – iOS 17 anchors everything, follow() keeps it in check).
private struct BottomAnchor: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.top, for: .sizeChanges)
        } else {
            content.defaultScrollAnchor(.bottom)
        }
    }
}

/// iOS 18: "following" = within 80 pt of the end.
private struct FollowTracker: ViewModifier {
    @Binding var following: Bool
    @Binding var unseen: Int

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.onScrollGeometryChange(for: Bool.self) { geo in
                // distance from the end of the content to the bottom edge of what you see – the
                // floating composer (bottom inset) covers the last part of the visible rect
                geo.contentSize.height - (geo.visibleRect.maxY - geo.contentInsets.bottom) < 80
            } action: { _, atEnd in
                if atEnd != following { following = atEnd }
                if atEnd { unseen = 0 }
            }
        } else {
            content
        }
    }
}

/// "↓ Neu": back to the end of the chat.
private struct JumpToEnd: View {
    let unseen: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: "arrow.down")
                if unseen > 0 { Text("Neu").font(Typo.sm.weight(.semibold)).foregroundStyle(Theme.accent) }
            }
            .font(Typo.md.weight(.semibold))
            .foregroundStyle(Theme.fg)
            .padding(.horizontal, unseen > 0 ? 12 : 10).padding(.vertical, 9)
            .background(Theme.side, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .padding(.trailing, 14).padding(.bottom, 10)
        .transition(.scale.combined(with: .opacity))
        .accessibilityLabel("Zum Ende springen")
    }
}
