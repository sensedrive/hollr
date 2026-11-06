import SwiftUI

struct SpaceRoute: Hashable {
    let server: Server
    let space: Space
}

/// The most urgent state among a space's agent panes (waits for you → new result → working → ready);
/// herdr's own space state when no agent runs there.
private func urgentStatus(of space: Space, in refs: [AgentRef]) -> String {
    refs.filter { $0.pane.pane.hasPrefix(space.id + ":") && $0.pane.agent != nil }
        .min { $0.statusRank < $1.statusRank }?.pane.status ?? space.status
}

/// herdr's spaces per server (SpacesSidebar): repos with their worktrees nested below, standalone workspaces.
struct SpacesView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @State private var newSpace = UserDefaults.standard.string(forKey: "hollrSheet") == "newspace"
    @State private var closing: Space?
    @State private var closingServer: Server?

    var body: some View {
        List {
            ForEach(store.servers) { server in
                let spaces = herdr.spaces[server.id] ?? []
                let refs = herdr.agents(on: server)
                Section {
                    if herdr.spaces[server.id] == nil {
                        ForEach(0..<5, id: \.self) { i in
                            HStack(spacing: 10) {
                                SkeletonBar(width: CGFloat([170, 220, 140, 200, 160][i]), height: 14)
                                Spacer()
                                SkeletonBar(width: 36, height: 10)
                            }
                            .padding(.vertical, Gap.xs)
                            .shimmer()
                        }
                        .listRowBackground(Theme.card)
                    }
                    ForEach(Self.group(spaces), id: \.key) { group in
                        ForEach(group.spaces) { space in
                            NavigationLink(value: SpaceRoute(server: server, space: space)) {
                                SpaceRow(space: space, status: urgentStatus(of: space, in: refs), nested: space.id != group.key)
                            }
                            .swipeActions {
                                Button(role: .destructive) {
                                    closingServer = server
                                    closing = space
                                } label: {
                                    Label("Schließen", icon: .x)
                                }
                            }
                        }
                    }
                    .listRowBackground(Theme.card)
                    if spaces.isEmpty { Text("Lade …").foregroundStyle(Theme.muted).listRowBackground(Theme.card) }
                } header: {
                    SectionHeader(title: server.label, dot: serverColor(server))
                }
            }
        }
        .themedList()
        .navigationTitle("Spaces")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { newSpace = true } label: { Image(.plus) }
                    .buttonStyle(.icon())
                    .accessibilityLabel("Neuer Space")
            }
        }
        .sheet(isPresented: $newSpace) { NewSpaceView() }
        .modifier(CloseSpaceModifier(server: closingServer ?? store.servers.first ?? Server.placeholder, space: $closing))
        .navigationDestination(for: SpaceRoute.self) { SpaceDetailView(server: $0.server, space: $0.space) }
        .refreshable { await herdr.refreshSpaces(store.servers) }
        .task {
            while !Task.isCancelled {
                await herdr.refreshSpaces(store.servers)
                // the live feed refreshes spaces on every change; this is the safety net – also for git
                // state changed outside any session (a pull in the IDE), which herdr doesn't report
                let allLive = store.servers.allSatisfy { herdr.live.contains($0.id) }
                try? await Task.sleep(for: .seconds(allLive ? 30 : 10))
            }
        }
    }

    /// server status dot: green once its spaces loaded, red on an error, grey while connecting
    private func serverColor(_ server: Server) -> Color {
        if herdr.errors[server.id] != nil { return Theme.red }
        return herdr.spaces[server.id] == nil ? Theme.dim : Theme.live
    }

    /// repo main checkout first, its worktrees nested below; other workspaces standalone
    static func group(_ spaces: [Space]) -> [(key: String, spaces: [Space])] {
        var groups: [(key: String, spaces: [Space])] = []
        for space in spaces where !space.isWorktree {
            let worktrees = spaces.filter { $0.isWorktree && $0.repo != nil && $0.repo == space.repo }
            groups.append((space.id, [space] + worktrees))
        }
        let placed = Set(groups.flatMap { $0.spaces.map(\.id) })
        for orphan in spaces where !placed.contains(orphan.id) { groups.append((orphan.id, [orphan])) }
        return groups
    }
}

/// One space in the list (molecule SpaceRow): a dot only while something happens (working / waits / new result),
/// the name, the git state quietly on the right; worktrees indented with a muted name.
struct SpaceRow: View {
    let space: Space
    let status: String
    let nested: Bool

    var body: some View {
        let state = PaneState(status: status)
        HStack(spacing: 10) {
            Group {
                if state == .working || state == .blocked || state == .result {
                    StatusDot(state, size: 7, pulse: state == .working)
                }
            }
            .frame(width: 9)
            Text(space.label)
                .font(nested ? Typo.note : Typo.md)
                .foregroundStyle(nested ? Theme.muted : Theme.fg)
                .lineLimit(1)
            Spacer(minLength: Gap.s)
            if let git = space.git, git.dirty > 0 || git.ahead > 0 || git.behind > 0 {
                HStack(spacing: 6) {
                    if git.dirty > 0 { Text(verbatim: "*\(git.dirty)") }
                    if git.ahead > 0 { Text(verbatim: "↑\(git.ahead)") }
                    if git.behind > 0 { Text(verbatim: "↓\(git.behind)") }
                }
                .font(Typo.monoXS)
                .foregroundStyle(Theme.dim)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(String(localized: "\(git.dirty) geändert, \(git.ahead) voraus, \(git.behind) zurück"))
            }
        }
        .padding(.leading, nested ? 19 : 0)
        .accessibilityElement(children: .combine)
    }
}

/// One space (screen Space): head with Git & Dateien and Worktree anlegen, meta line, its sessions, worktrees and
/// uncommitted changes.
struct SpaceDetailView: View {
    let server: Server
    let space: Space
    @State private var closing: Space?
    @State private var newWorktree = false
    @State private var git: GitPanel.Tab?
    @State private var openedDebugTab = false
    @State private var changes: ChangesResponse?
    @State private var changesError: String?
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions
    @Environment(\.dismiss) private var dismiss

    private static let changesShown = 8

    /// the space as herdr reports it now (its git state changes while the page is open)
    private var current: Space { herdr.spaces[server.id]?.first { $0.id == space.id } ?? space }
    private var allRefs: [AgentRef] { herdr.agents(on: server) }
    private var refs: [AgentRef] { allRefs.filter { $0.pane.pane.hasPrefix(space.id + ":") } }
    private var worktrees: [Space] {
        guard !current.isWorktree, let repo = current.repo else { return [] }
        return (herdr.spaces[server.id] ?? []).filter { $0.isWorktree && $0.repo == repo }
    }

    /// uncommitted files, each once (unstaged first – that's what an agent just changed)
    private var changedFiles: [(file: FileChange, staged: Bool)] {
        guard let changes else { return [] }
        var seen = Set<String>()
        return (changes.unstaged.map { (file: $0, staged: false) } + changes.staged.map { (file: $0, staged: true) })
            .filter { seen.insert($0.file.path).inserted }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Gap.m) {
                actions
                meta
                SectionHeader(title: String(localized: "Sitzungen"), trailing: "\(refs.count)")
                sessionList
                if !worktrees.isEmpty {
                    SectionHeader(title: String(localized: "Worktrees"), trailing: "\(worktrees.count)")
                    Rows {
                        ForEach(worktrees) { worktree in
                            NavigationLink(value: SpaceRoute(server: server, space: worktree)) {
                                WorktreeRow(space: worktree, status: urgentStatus(of: worktree, in: allRefs))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if let git = current.git { changesSection(branch: git.branch) }
            }
            .padding(.horizontal, Gap.l)
            .padding(.bottom, Gap.xl)
        }
        .themedPage()
        .navigationTitle(current.label)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(role: .destructive) { closing = current } label: {
                        Label(current.isWorktree ? "Schließen / Worktree löschen …" : "Space schließen …", icon: .trash)
                    }
                } label: { Image(.more).foregroundStyle(Theme.muted) }
                .accessibilityLabel("Mehr")
            }
        }
        .navigationDestination(item: $git) { GitPanel(server: server, space: current, tab: $0) }
        .sheet(isPresented: $newWorktree) { NewSpaceView(preselectedRepo: current) }
        .modifier(CloseSpaceModifier(server: server, space: $closing, onClosed: { dismiss() }))
        .refreshable {
            await herdr.refreshSpaces([server])
            await loadChanges()
        }
        .task(id: current.git) { await loadChanges() }
        .onAppear {
            // debug: open the git panel on a tab right away
            guard !openedDebugTab else { return }
            openedDebugTab = true
            git = GitPanel.Tab(rawValue: UserDefaults.standard.integer(forKey: "hollrSpaceTab"))
        }
    }

    private var actions: some View {
        HStack(spacing: Gap.s) {
            Button { git = (current.git?.dirty ?? 0) > 0 ? .changes : .files } label: {
                Label("Git & Dateien", icon: .branch)
            }
            .buttonStyle(.hollr(.secondary))
            if !current.isWorktree && current.git != nil {
                Button { newWorktree = true } label: { Label("Worktree anlegen", icon: .plus) }
                    .buttonStyle(.hollr(.primary))
            }
        }
    }

    /// branch · changes, server, path (space__meta); the last commit below
    private var meta: some View {
        VStack(alignment: .leading, spacing: Gap.xs) {
            MetaFlow {
                if let git = current.git {
                    HStack(spacing: 6) {
                        IconView(.branch, size: 13)
                        Text(gitSummary(git))
                    }
                }
                HStack(spacing: 6) {
                    IconView(.server, size: 13)
                    Text(server.label)
                }
                Text(current.root).font(Typo.monoSmall).lineLimit(2).truncationMode(.head)
            }
            .font(Typo.sm)
            .foregroundStyle(Theme.muted)
            if let commit = current.git?.lastCommit {
                Text("\(commit.subject) · \(RelativeTime.string(commit.at))")
                    .font(Typo.sm).foregroundStyle(Theme.dim).lineLimit(1)
            }
        }
    }

    private func gitSummary(_ git: GitSummary) -> String {
        [git.branch,
         git.dirty > 0 ? String(localized: "\(git.dirty) geändert") : nil,
         git.ahead > 0 ? String(localized: "\(git.ahead) voraus") : nil,
         git.behind > 0 ? String(localized: "\(git.behind) zurück") : nil]
            .compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder private var sessionList: some View {
        if refs.isEmpty {
            Text("Keine Panes").font(Typo.md).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardStyle()
        } else {
            VStack(spacing: 0) {
                ForEach(refs) { ref in
                    NavigationLink(value: ref.id) {
                        SpaceSessionRow(ref: ref, branch: current.git?.branch, live: sessions.sessions[ref.id]?.isLive == true)
                    }
                    .buttonStyle(.plain)
                }
            }
            .cardStyle(padding: EdgeInsets(top: Gap.xs, leading: Gap.xs, bottom: Gap.xs, trailing: Gap.xs))
        }
    }

    @ViewBuilder private func changesSection(branch: String) -> some View {
        let files = changedFiles
        SectionHeader(title: String(localized: "Änderungen auf \(branch)"), trailing: changes.map { _ in "\(files.count)" })
        if let changesError, changes == nil {
            Text(changesError).font(Typo.sm).foregroundStyle(Theme.warn)
        } else if changes == nil {
            Rows {
                ForEach(0..<3, id: \.self) { i in
                    HStack(spacing: 10) {
                        SkeletonBar(width: 10, height: 10)
                        SkeletonBar(width: CGFloat([200, 140, 170][i]), height: 10)
                        Spacer()
                    }
                    .padding(.vertical, Gap.s).padding(.horizontal, 14)
                    .frame(minHeight: Metric.touch)
                    .shimmer()
                }
            }
        } else if files.isEmpty {
            Text("Alles committet.").font(Typo.md).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardStyle()
        } else {
            Rows {
                ForEach(files.prefix(Self.changesShown), id: \.file.path) { item in
                    NavigationLink {
                        DiffScreen(server: server, space: current, source: .file(path: item.file.path, staged: item.staged),
                                   title: item.file.name)
                    } label: {
                        ChangeRow(status: item.file.status, path: item.file.path, add: item.file.add, del: item.file.del)
                    }
                    .buttonStyle(.plain)
                }
                if files.count > Self.changesShown {
                    Button { git = .changes } label: {
                        HStack {
                            Text("Alle \(files.count) Änderungen ansehen").font(Typo.note)
                            Spacer()
                            IconView(.chevronRight, size: 14).foregroundStyle(Theme.dim)
                        }
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 14)
                        .frame(minHeight: Metric.touch)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func loadChanges() async {
        guard current.git != nil else { return }
        do {
            changes = try await HollrClient.fs(server, ["op": "changes", "ws": space.id], as: ChangesResponse.self)
            changesError = nil
        } catch {
            changesError = error.localizedDescription
        }
    }
}

/// A session of the space (molecule WorkRow): agent badge, status dot + name, branch, coloured state + detail.
private struct SpaceSessionRow: View {
    let ref: AgentRef
    let branch: String?
    let live: Bool

    var body: some View {
        let shell = ref.pane.agent == nil
        let detail = ref.pane.title.trimmingCharacters(in: .whitespaces)
        HStack(spacing: 10) {
            AgentBadge(pane: ref.pane)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Gap.s) {
                    StatusDot(status: ref.pane.status, agent: !shell, size: 7, pulse: ref.pane.status == "working")
                    Text(ref.title).font(Typo.md.weight(.semibold)).lineLimit(1)
                    if live {
                        IconView(.activity, size: 12).foregroundStyle(Theme.live).symbolEffect(.variableColor.iterative)
                    } else if ref.pane.live {
                        IconView(.activity, size: 11).foregroundStyle(Theme.live.opacity(0.7))
                    }
                    Spacer(minLength: Gap.xs)
                    if let branch {
                        Text(branch).font(Typo.monoXS).foregroundStyle(Theme.dim).lineLimit(1).truncationMode(.middle)
                    }
                }
                Group {
                    if shell {
                        Text("Terminal").foregroundStyle(Theme.muted)
                    } else if detail.isEmpty || detail == ref.title {
                        Text(Theme.statusLabel(ref.pane.status)).foregroundStyle(Theme.statusColor(ref.pane.status))
                    } else {
                        Text(Theme.statusLabel(ref.pane.status)).foregroundStyle(Theme.statusColor(ref.pane.status))
                            + Text(verbatim: " · \(detail)").foregroundStyle(Theme.muted)
                    }
                }
                .font(Typo.sm)
                .lineLimit(1)
            }
        }
        .padding(Gap.s)
        .frame(minHeight: Metric.touch)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A worktree of the repo (space__wt): status dot, name, branch dim, chevron.
private struct WorktreeRow: View {
    let space: Space
    let status: String

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(status: status, size: 7, pulse: status == "working").frame(width: 9)
            Group {
                if let branch = space.git?.branch {
                    Text(space.label).font(Typo.md.weight(.semibold))
                        + Text(verbatim: " \(branch)").font(Typo.sm).foregroundStyle(Theme.dim)
                } else {
                    Text(space.label).font(Typo.md.weight(.semibold))
                }
            }
            .lineLimit(1)
            Spacer(minLength: Gap.s)
            IconView(.chevronRight, size: 15).foregroundStyle(Theme.dim)
        }
        .padding(.vertical, 10).padding(.horizontal, 14)
        .frame(minHeight: Metric.touch)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Items side by side, wrapping onto the next line when the width runs out (flex-wrap of space__meta).
private struct MetaFlow: Layout {
    var spacing: CGFloat = Gap.l
    var lineSpacing: CGFloat = Gap.xs

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let frames = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = frames.map(\.maxX).max() ?? 0
        let height = frames.map(\.maxY).max() ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (frame, view) in zip(arrange(width: bounds.width, subviews: subviews), subviews) {
            view.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                       proposal: ProposedViewSize(frame.size))
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [CGRect] {
        var frames: [CGRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0
        for view in subviews {
            var size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
            size.width = min(size.width, width)
            if x > 0, x + size.width > width {
                x = 0
                y += line + lineSpacing
                line = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            line = max(line, size.height)
        }
        return frames
    }
}
