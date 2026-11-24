import SwiftUI

/// All agents of all servers – like Heeler's Agents tab.
struct AgentListView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions
    @AppStorage("hollr.grouping") private var grouping: Grouping = .status
    @AppStorage("hollr.showShells") private var showShells = false
    var onNewChat: () -> Void = {}
    /// Mac: sidebar of the split view – rows select instead of pushing
    var selection: Binding<String?>? = nil
    /// Mac: open a second chat next to the first
    var openBeside: ((String) -> Void)? = nil

    enum Grouping: String, CaseIterable {
        case status, workspace
        var label: String { self == .status ? "Nach Status" : "Nach Workspace" }
    }

    var body: some View {
        list
            .alert("Fehler", isPresented: Binding(get: { unreadError != nil }, set: { if !$0 { unreadError = nil } })) {
                Button("OK") { unreadError = nil }
            } message: { Text(unreadError ?? "") }
    }

    @ViewBuilder private var list: some View {
        // a selection (Mac sidebar) only where there is one – a constant selection swallowed the taps
        // on the iPhone's navigation links
        if let selection {
            List(selection: selection) { rows }.modifier(ListChrome(onNewChat: onNewChat, grouping: $grouping, showShells: $showShells, loaded: herdr.loaded))
        } else {
            List { rows }.modifier(ListChrome(onNewChat: onNewChat, grouping: $grouping, showShells: $showShells, loaded: herdr.loaded))
        }
    }

    // Every ForEach element is exactly one row or one section, and ids are unique in the whole List: rows that
    // come and go through `if`s next to moving ones made UICollectionView crash on a refresh.
    @ViewBuilder private var rows: some View {
        Group {
            ForEach(store.servers.filter { herdr.errors[$0.id] != nil }) { server in
                Label("\(server.label): \(herdr.errors[server.id] ?? "")", icon: .alert)
                    .font(Typo.note).foregroundStyle(Theme.warn)
            }
            switch grouping {
            case .status:
                let agents = herdr.allAgents(store.servers, includeShells: showShells)
                ForEach(agents) { ref in row(ref, showServer: store.servers.count > 1, showWorkspace: true) }
            case .workspace:
                ForEach(workspaceGroups()) { group in workspaceSection(group) }
            }
            if herdr.loaded && herdr.allAgents(store.servers, includeShells: showShells).isEmpty {
                EmptyState(icon: .terminal, title: String(localized: "Keine Agents"),
                           text: String(localized: "Starte in herdr eine omp-Session."))
            }
        }
        .listRowBackground(Theme.card)
    }

    /// One workspace with sessions (a section), keyed by server and workspace – "w1" exists on every server.
    private struct WorkspaceGroup: Identifiable {
        let id: String
        let title: String
        let label: String
        let refs: [AgentRef]
    }

    // own functions with explicit types: one big nested expression made the Release compiler give
    // up on the CI machines ("unable to type-check this expression in reasonable time")
    private func workspaceGroups() -> [WorkspaceGroup] {
        var out: [WorkspaceGroup] = []
        for server in store.servers {
            for ws in herdr.trees[server.id] ?? [] {
                let refs: [AgentRef] = refs(on: server, in: ws)
                guard !refs.isEmpty else { continue }
                let title: String = store.servers.count > 1 ? "\(server.label) · \(ws.label)" : ws.label
                out.append(WorkspaceGroup(id: "\(server.id.uuidString)|\(ws.id)", title: title, label: ws.label, refs: refs))
            }
        }
        return out
    }

    private func refs(on server: Server, in ws: Workspace) -> [AgentRef] {
        // by id: two workspaces with the same name must not list each other's sessions
        let refs: [AgentRef] = herdr.agents(on: server).filter { ref in
            ref.workspaceId == ws.id && (showShells || ref.pane.agent != nil)
        }
        // the tabs in the order dragged on any device
        return SharedOrder.ordered(refs, saved: herdr.tabOrder(server, ws: ws.id)) { $0.tabId }
    }

    private func workspaceSection(_ group: WorkspaceGroup) -> some View {
        Section {
            ForEach(group.refs) { ref in row(ref, showServer: false, showWorkspace: false) }
        } header: {
            SectionHeader(title: group.title, trailing: "\(group.refs.count)", dot: Theme.identity(group.label))
                .textCase(nil)
        }
    }

    @State private var closing: AgentRef?
    /// „Als ungelesen markieren“ didn't reach the server – undone, shown
    @State private var unreadError: String?

    @ViewBuilder private func rowLink(_ ref: AgentRef, showServer: Bool, showWorkspace: Bool) -> some View {
        let label = AgentRow(ref: ref, showServer: showServer, showWorkspace: showWorkspace, branch: herdr.branch(of: ref),
                             live: sessions.sessions[ref.id]?.isLive == true)
        if selection != nil {
            label.tag(ref.id)
        } else {
            NavigationLink(value: ref.id) { label }
        }
    }

    private func row(_ ref: AgentRef, showServer: Bool, showWorkspace: Bool) -> some View {
        rowLink(ref, showServer: showServer, showWorkspace: showWorkspace)
        .contextMenu {
            if let openBeside {
                Button { openBeside(ref.id) } label: { Label("Rechts daneben öffnen", systemImage: "rectangle.split.2x1") }
            }
            if ref.pane.agent != nil && !herdr.isUnread(ref) {
                Button { markUnread(ref) } label: { Label("Als ungelesen markieren", systemImage: "circle.fill") }
            }
        }
        .swipeActions {
            Button("Schließen", role: .destructive) { closing = ref }
        }
        .confirmationDialog("Chat schließen?", isPresented: Binding(get: { closing?.id == ref.id }, set: { if !$0 { closing = nil } }),
                            titleVisibility: .visible) {
            Button("Schließen", role: .destructive) {
                sessions.sessions[ref.id]?.stop()
                Task {
                    try? await HollrClient.close(ref.server, pane: ref.pane.pane)
                    await herdr.refresh(store.servers)
                }
                closing = nil
            }
        } message: {
            Text("„\(ref.title)“ wird in herdr geschlossen und \(ref.pane.agentName) beendet.")
        }
    }

    private func markUnread(_ ref: AgentRef) {
        Task {
            do { try await herdr.markUnread([ref]) } catch { unreadError = error.localizedDescription }
        }
    }
}

/// One session as a row (molecule WorkRow): agent badge, status dot and name, branch or folder on the right,
/// the status in its colour and what it works on.
struct AgentRow: View {
    let ref: AgentRef
    var showServer = false
    /// the workspace in the status line (off inside a project card or workspace section, which names it already)
    var showWorkspace = true
    /// the space's git branch, when known (else the folder)
    var branch: String? = nil
    var live = false
    /// „vor 12 Min.“ after the status: when the agent last reported (entered its state) – the „Zuletzt“ list
    var showAge = false
    @Environment(HerdrStore.self) private var herdr

    private var isShell: Bool { ref.pane.agent == nil }

    /// a seen result shows as ready, one marked unread as new (on every device)
    private var status: String { herdr.shownStatus(ref) }

    private var state: String { isShell ? String(localized: "Terminal") : Theme.statusLabel(status) }

    /// how long it has been working, from when it entered the state (server time, ms): "seit 12 Min."
    private func workingFor(_ now: Date) -> String? {
        guard status == "working", let since = ref.pane.since else { return nil }
        let s = Int(max(0, now.timeIntervalSince1970 - since / 1000))
        let h = s / 3600, m = (s % 3600) / 60
        if h == 0 && m == 0 { return String(localized: "seit eben") }
        return h > 0
            ? String(localized: "seit \(h) Std. \(m) Min.")
            : String(localized: "seit \(m) Min.")
    }

    /// when it entered its current state, relative: "vor 12 Min." (working agents say how long instead)
    private func age(_ now: Date) -> String? {
        guard showAge, status != "working", let since = ref.pane.since else { return nil }
        let date = Date(timeIntervalSince1970: since / 1000)
        if now.timeIntervalSince(date) < 60 { return String(localized: "gerade eben") }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: now)
    }

    /// server, workspace (like herdr's sidebar group) and what the agent works on (omp session title)
    private var detail: String {
        var parts: [String] = []
        if showServer { parts.append(ref.server.label) }
        if showWorkspace && ref.title != ref.workspace { parts.append(ref.workspace) }
        if !isShell && !ref.pane.title.isEmpty && ref.pane.title != ref.title { parts.append(ref.pane.title) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 10) {
            AgentBadge(pane: ref.pane)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Gap.s) {
                    StatusDot(status: status, agent: !isShell, size: 7, pulse: status == "working")
                    // the tab name you gave it in herdr
                    Text(ref.title).font(Typo.md.weight(.semibold)).lineLimit(1).layoutPriority(1)
                    if live {
                        Image(.activity).font(Typo.xs).foregroundStyle(Theme.live).symbolEffect(.variableColor.iterative)
                    } else if ref.pane.live {
                        Image(.activity).font(Typo.xs).foregroundStyle(Theme.live.opacity(0.7))
                    }
                    Spacer(minLength: Gap.xs)
                    Text(verbatim: branch ?? ref.pane.folder)
                        .font(Typo.monoXS).foregroundStyle(Theme.dim)
                        .lineLimit(1).truncationMode(.middle)
                }
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    let elapsed = workingFor(context.date).map { " \($0)" } ?? ""
                    let ago = age(context.date).map { " · \($0)" } ?? ""
                    (Text(verbatim: state + elapsed).foregroundStyle(isShell ? Theme.muted : Theme.statusColor(status))
                        + Text(verbatim: ago).foregroundStyle(Theme.fg.opacity(0.75))
                        + Text(verbatim: detail.isEmpty ? "" : " · \(detail)").foregroundStyle(Theme.muted))
                        .font(Typo.sm)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .opacity(isShell ? 0.6 : 1)
    }
}

extension HerdrStore {
    /// The git branch of the space a pane runs in, once the spaces are loaded.
    func branch(of ref: AgentRef) -> String? {
        let ws = ref.workspaceId
        return spaces[ref.server.id]?.first { $0.id == ws }?.git?.branch
    }
}

/// Title, toolbar and refresh around the agent list (both list variants).
private struct ListChrome: ViewModifier {
    let onNewChat: () -> Void
    @Binding var grouping: AgentListView.Grouping
    @Binding var showShells: Bool
    let loaded: Bool
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr

    func body(content: Content) -> some View {
        content
            .themedList()
            .overlay { if !loaded { Skeleton(style: .list, count: 10).background(Theme.bg) } }
            .navigationTitle("Agents")
            .refreshable { await herdr.refresh(store.servers, force: true) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: onNewChat) { Image(.plus) }
                        .buttonStyle(.icon())
                        .accessibilityLabel("Neuer Chat")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Sortierung", selection: $grouping) {
                            ForEach(AgentListView.Grouping.allCases, id: \.self) { Text($0.label).tag($0) }
                        }
                        Toggle("Shells anzeigen", isOn: $showShells)
                    } label: {
                        Image(.sliders).foregroundStyle(Theme.muted)
                    }
                    .buttonStyle(.icon())
                    .accessibilityLabel("Ansicht")
                }
            }
    }
}
