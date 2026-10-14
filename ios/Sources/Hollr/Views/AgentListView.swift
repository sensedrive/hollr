import SwiftUI

/// All agents of all servers – like Heeler's Agents tab.
struct AgentListView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions
    @AppStorage("hollr.grouping") private var grouping: Grouping = .status
    @AppStorage("hollr.showShells") private var showShells = false
    var onNewChat: () -> Void = {}

    enum Grouping: String, CaseIterable {
        case status, workspace
        var label: String { self == .status ? "Nach Status" : "Nach Workspace" }
    }

    var body: some View {
        List {
            Group {
            ForEach(store.servers) { server in
                if let error = herdr.errors[server.id] {
                    Label("\(server.label): \(error)", systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote).foregroundStyle(Theme.warn)
                }
            }
            switch grouping {
            case .status:
                let agents = herdr.allAgents(store.servers, includeShells: showShells)
                ForEach(agents) { ref in row(ref, showServer: store.servers.count > 1) }
            case .workspace:
                ForEach(store.servers) { server in
                    ForEach(herdr.trees[server.id] ?? []) { ws in
                        let refs = herdr.agents(on: server).filter {
                            $0.workspace == ws.label && (showShells || $0.pane.agent != nil)
                        }
                        if !refs.isEmpty {
                            Section {
                                ForEach(refs) { row($0, showServer: false) }
                            } header: {
                                Text(store.servers.count > 1 ? "\(server.label) · \(ws.label)" : ws.label)
                            }
                        }
                    }
                }
            }
            if herdr.loaded && herdr.allAgents(store.servers, includeShells: showShells).isEmpty {
                ContentUnavailableView(
                    "Keine Agents", systemImage: "rectangle.split.3x1",
                    description: Text("Starte in herdr eine omp-Session.")
                )
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .overlay { if !herdr.loaded { Skeleton(style: .list, count: 10).background(Theme.bg) } }
        .navigationTitle("Agents")
        .refreshable { await herdr.refresh(store.servers) }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: onNewChat) { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("Neuer Chat")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Sortierung", selection: $grouping) {
                        ForEach(Grouping.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    Toggle("Shells anzeigen", isOn: $showShells)
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                }
            }
        }
    }

    @State private var closing: AgentRef?

    private func row(_ ref: AgentRef, showServer: Bool) -> some View {
        NavigationLink(value: ref.id) {
            AgentRow(ref: ref, showServer: showServer, live: sessions.sessions[ref.id]?.isLive == true)
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
}

struct AgentRow: View {
    let ref: AgentRef
    var showServer = false
    var live = false

    var body: some View {
        HStack(spacing: 12) {
            AgentBadge(pane: ref.pane)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    // workspace (and server) like herdr's sidebar group
                    Text([showServer ? ref.server.label : nil, ref.title == ref.workspace ? nil : ref.workspace]
                        .compactMap { $0 }.joined(separator: " · ").ifEmpty(ref.pane.agentName))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    StatusPill(status: ref.pane.status, isShell: ref.pane.agent == nil)
                }
                HStack(spacing: 6) {
                    // the tab name you gave it in herdr
                    Text(ref.title)
                        .font(.body.weight(.semibold))
                        .lineLimit(2)
                    if live {
                        Image(systemName: "waveform").foregroundStyle(Theme.live).symbolEffect(.variableColor.iterative)
                    } else if ref.pane.live {
                        Image(systemName: "waveform").font(.caption).foregroundStyle(Theme.live.opacity(0.7))
                    }
                }
                // what the agent is working on (omp session title)
                Text(ref.pane.agent == nil ? "Shell · \(ref.pane.folder)" : "\(ref.pane.agentName) · \(ref.pane.title)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 3)
        .opacity(ref.pane.agent == nil ? 0.55 : 1)
    }
}

struct StatusPill: View {
    let status: String
    var isShell = false

    var body: some View {
        if !isShell {
            Text(Theme.statusLabel(status))
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Theme.statusColor(status).opacity(0.18), in: Capsule())
                .foregroundStyle(Theme.statusColor(status))
        }
    }
}

struct AgentBadge: View {
    let pane: Pane

    var body: some View {
        Text(short)
            .font(.system(.caption2, design: .rounded).weight(.bold))
            .foregroundStyle(color)
            .frame(width: 40, height: 40)
            .background(color.opacity(0.16), in: RoundedRectangle(cornerRadius: 10))
    }

    private var short: String {
        switch pane.agent {
        case "omp": return "omp"
        case "claude": return "CC"
        case "codex": return "CX"
        case nil: return "$_"
        case let other?: return String(other.prefix(3))
        }
    }

    private var color: Color {
        switch pane.agent {
        case "omp": return Theme.live
        case "claude": return Color(red: 0.85, green: 0.47, blue: 0.34)
        case nil: return .gray
        default: return Theme.accent
        }
    }
}

extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
