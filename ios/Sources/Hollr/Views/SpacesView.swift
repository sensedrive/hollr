import MarkdownUI
import SwiftUI

struct SpaceRoute: Hashable {
    let server: Server
    let space: Space
}

/// herdr's "spaces" sidebar: repos with main + worktrees, standalone workspaces.
struct SpacesView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @State private var newSpace = UserDefaults.standard.string(forKey: "hollrSheet") == "newspace"
    @State private var closing: Space?
    @State private var closingServer: Server?

    var body: some View {
        List {
            Group {
            ForEach(store.servers) { server in
                let spaces = herdr.spaces[server.id] ?? []
                let groups = Self.group(spaces)
                Section {
                    if herdr.spaces[server.id] == nil {
                        ForEach(0..<5, id: \.self) { i in
                            VStack(alignment: .leading, spacing: 7) {
                                SkeletonBar(width: CGFloat([170, 220, 140, 200, 160][i]), height: 14)
                                SkeletonBar(width: CGFloat([120, 90, 150, 110, 80][i]), height: 10)
                            }
                            .padding(.vertical, 4)
                            .shimmer()
                        }
                    }
                    ForEach(groups, id: \.key) { group in
                        ForEach(Array(group.spaces.enumerated()), id: \.element.id) { index, space in
                            NavigationLink(value: SpaceRoute(server: server, space: space)) {
                                SpaceRow(space: space, nested: group.key != space.id && index > 0,
                                         last: index == group.spaces.count - 1)
                            }
                            .swipeActions {
                                Button("Schließen", role: .destructive) {
                                    closingServer = server
                                    closing = space
                                }
                            }
                        }
                    }
                    if spaces.isEmpty { Text("Lade …").foregroundStyle(.secondary) }
                } header: {
                    if store.servers.count > 1 { Text(server.label) }
                }
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .navigationTitle("Spaces")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { newSpace = true } label: { Image(systemName: "plus") }
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
                try? await Task.sleep(for: .seconds(10))
            }
        }
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

struct SpaceRow: View {
    let space: Space
    let nested: Bool
    let last: Bool

    var body: some View {
        HStack(spacing: 10) {
            if nested {
                Text(last ? "└─" : "├─").font(Omp.mono).foregroundStyle(Omp.border)
            }
            Circle()
                .strokeBorder(Theme.statusColor(space.status), lineWidth: 1.5)
                .background(Circle().fill(space.status == "working" ? Theme.work : .clear))
                .frame(width: 11, height: 11)
            VStack(alignment: .leading, spacing: 3) {
                Text(space.label).font(nested ? .body : .body.weight(.semibold)).lineLimit(1)
                if let git = space.git {
                    HStack(spacing: 6) {
                        Label(git.branch, systemImage: "arrow.triangle.branch").labelStyle(.titleAndIcon)
                            .foregroundStyle(Omp.custom)
                        if git.dirty > 0 { Text("*\(git.dirty)").foregroundStyle(Omp.warning) }
                        if git.ahead > 0 { Text("↑\(git.ahead)").foregroundStyle(Omp.success) }
                        if git.behind > 0 { Text("↓\(git.behind)").foregroundStyle(Omp.error) }
                    }
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    if let commit = git.lastCommit {
                        Text("\(commit.subject) · \(RelativeTime.string(commit.at))")
                            .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                    }
                } else {
                    Text(space.folder).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct SpaceDetailView: View {
    let server: Server
    let space: Space
    @State private var closing: Space?
    @State private var newWorktree = false
    @Environment(HerdrStore.self) private var herdr
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        GitPanel(server: server, space: space, showAgents: true,
                 tab: GitPanel.Tab(rawValue: UserDefaults.standard.integer(forKey: "hollrSpaceTab")) ?? .agents)
        // the panel has its own bottom bar
        .toolbar(.hidden, for: .tabBar)
        .navigationTitle(space.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if !space.isWorktree && space.git != nil {
                        Button { newWorktree = true } label: { Label("Neuer Worktree …", systemImage: "arrow.triangle.branch") }
                    }
                    Button(role: .destructive) { closing = space } label: {
                        Label(space.isWorktree ? "Schließen / Worktree löschen …" : "Space schließen …", systemImage: "xmark.circle")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .sheet(isPresented: $newWorktree) { NewSpaceView(preselectedRepo: space) }
        .modifier(CloseSpaceModifier(server: server, space: $closing, onClosed: { dismiss() }))
    }
}

struct SpaceAgentsList: View {
    let server: Server
    let space: Space
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions

    var body: some View {
        let refs = herdr.agents(on: server).filter { $0.pane.pane.hasPrefix(space.id + ":") }
        List {
            Group {
            ForEach(refs) { ref in
                NavigationLink(value: ref.id) {
                    AgentRow(ref: ref, live: sessions.sessions[ref.id]?.isLive == true)
                }
            }
            if refs.isEmpty {
                ContentUnavailableView("Keine Panes", systemImage: "rectangle.split.3x1")
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
    }
}

// MARK: - Git
