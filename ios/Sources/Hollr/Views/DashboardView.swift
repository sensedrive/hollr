import SwiftUI

/// Home: active sessions with live previews, usage limits, connections (Moshi-style).
struct DashboardView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions
    let onPair: () -> Void
    let onNew: () -> Void
    @Binding var sheetAgent: String?
    @Environment(MySessions.self) private var mySessions
    @State private var confirmRemove: Server?
    @Environment(\.openInBrowser) private var openInBrowser

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                limitsStrip
                sessionsSection
                connectionsSection
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 30)
        }
        .navigationTitle("Hollr")
        .themedPage()
        .onChange(of: herdr.trees) { _, trees in
            // forget sessions that were closed elsewhere
            let loaded = Set(trees.keys).filter { herdr.errors[$0] == nil }
            let alive = Set(herdr.allAgents(store.servers, includeShells: true).map(\.id))
            mySessions.prune(alive: alive, loadedServers: loaded)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: onNew) { Image(systemName: "plus") }
                    .accessibilityLabel("Neue Sitzung")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { openInBrowser() } label: { Image(systemName: "globe") }
                    .accessibilityLabel("Browser")
            }
        }
        .refreshable {
            await herdr.refresh(store.servers)
            await herdr.refreshUsage(store.servers, force: true)
        }
        .task { await herdr.refreshUsage(store.servers) }
        .confirmationDialog("Server aus Hollr entfernen?", isPresented: .constant(confirmRemove != nil),
                            titleVisibility: .visible, presenting: confirmRemove) { server in
            Button("Entfernen", role: .destructive) { store.remove(server); confirmRemove = nil }
            Button("Abbrechen", role: .cancel) { confirmRemove = nil }
        } message: { server in
            Text("Auf dem Server bleibt der Schlüssel bis `hollr revoke \(server.deviceId)`.")
        }
    }

    // MARK: Sessions

    private var liveIds: Set<String> { Set(sessions.sessions.filter { $0.value.isLive }.map(\.key)) }

    /// Only the sessions you opened in Hollr, grouped by machine.
    @ViewBuilder private var sessionsSection: some View {
        let mine = mySessions.ids.compactMap { herdr.ref(id: $0, servers: store.servers) }
        if mine.isEmpty && !herdr.loaded && !mySessions.ids.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                SkeletonBar(width: 120, height: 12)
                Skeleton(style: .cards, count: 1).frame(height: 200)
            }
            .shimmer()
        } else if mine.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: String(localized: "Sitzungen"), trailing: nil)
                Text("Hier erscheinen die Sitzungen, die du in Hollr öffnest oder startest – Agents und Terminals, nach Maschine sortiert.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Button(action: onNew) {
                    Label("Neue Sitzung", systemImage: "plus").frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        ForEach(store.servers) { server in
            let refs = mine.filter { $0.server.id == server.id }
            if !refs.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Circle().fill(herdr.errors[server.id] == nil ? Theme.live : Theme.warn).frame(width: 7, height: 7)
                        SectionHeader(title: server.label, trailing: "\(refs.count)")
                    }
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(refs) { ref in
                            SessionCard(ref: ref, live: liveIds.contains(ref.id)) { sheetAgent = ref.id }
                                .contextMenu {
                                    Button { mySessions.remove(ref.id) } label: {
                                        Label("Aus der Übersicht nehmen", systemImage: "eye.slash")
                                    }
                                    Button(role: .destructive) { closeSession(ref) } label: {
                                        Label("Sitzung beenden", systemImage: "xmark.circle")
                                    }
                                }
                        }
                    }
                }
            }
        }
    }

    private func closeSession(_ ref: AgentRef) {
        Task {
            try? await HollrClient.close(ref.server, pane: ref.pane.pane)
            mySessions.remove(ref.id)
            await herdr.refresh(store.servers)
        }
    }

    // MARK: Limits

    @State private var showLimits = false

    private var quietCaps: [UsageCapacity] {
        var all: [UsageCapacity] = []
        for server in store.servers { all += herdr.capacity[server.id] ?? [] }
        let providers: Set<String> = ["anthropic", "openai-codex"]
        return all.filter { cap in
            let mainMeter = cap.meter == nil || cap.meter == "chat"
            return mainMeter && providers.contains(cap.provider)
        }
    }

    /// one quiet line: "Claude 5h 2% 7d 64%  ChatGPT 5h 1% 7d 5%" (pooled over all accounts)
    @ViewBuilder private var limitsStrip: some View {
        let caps = quietCaps
        if !caps.isEmpty {
            Button { showLimits = true } label: { LimitsLine(caps: caps) }
            .buttonStyle(.plain)
            .sheet(isPresented: $showLimits) {
                LimitsSheet()
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    // MARK: Connections

    private var connectionsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: String(localized: "Verbindungen"), trailing: nil)
            ForEach(store.servers) { server in
                NavigationLink { ServerInfoView(server: server) } label: {
                HStack(spacing: 14) {
                    Image(systemName: "server.rack")
                        .font(.title3).foregroundStyle(Theme.accent)
                        .frame(width: 40, height: 40)
                        .background(Theme.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(server.label).font(.headline)
                        Text(server.displayAddress).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Circle().fill(herdr.errors[server.id] == nil ? Theme.live : Theme.warn).frame(width: 9, height: 9)
                    Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
                }
                .padding(14)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .contextMenu {
                    Button("Entfernen", role: .destructive) { confirmRemove = server }
                }
                }
                .buttonStyle(.plain)
            }
            Button(action: onPair) {
                Label("Server koppeln", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.bordered)
        }
    }
}

struct SectionHeader: View {
    let title: String
    let trailing: String?

    var body: some View {
        HStack {
            Text(title.uppercased()).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
            Spacer()
            if let trailing { Text(trailing).font(.footnote).foregroundStyle(.tertiary) }
        }
        .padding(.top, 6)
    }
}

/// Card with a tiny live terminal preview of the agent's screen.
struct SessionCard: View {
    let ref: AgentRef
    let live: Bool
    let onOpen: () -> Void
    @State private var preview = ""

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 8) {
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Omp.successBg)
                    if preview.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(0..<7, id: \.self) { i in SkeletonBar(width: CGFloat([90, 120, 70, 110, 60, 100, 80][i]), height: 6) }
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                        .shimmer()
                    }
                    Text(preview.isEmpty ? " " : preview)
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(Omp.muted)
                        .lineLimit(16)
                        .padding(8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                        .clipped()
                    HStack(spacing: 5) {
                        Circle().fill(Theme.statusColor(ref.pane.status)).frame(width: 7, height: 7)
                        Text(ref.pane.agentName).font(.caption2.weight(.bold))
                        if live { Image(systemName: "waveform").font(.caption2).foregroundStyle(Theme.live) }
                    }
                    .padding(.horizontal, 7).padding(.vertical, 4)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(8)
                }
                .frame(height: 150)
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(ref.pane.status == "blocked" ? Theme.warn : Omp.border, lineWidth: ref.pane.status == "blocked" ? 1.5 : 0.8))
                Text(ref.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                let status = ref.pane.agent == nil ? String(localized: "Terminal") : Theme.statusLabel(ref.pane.status)
                Text(ref.title == ref.workspace ? status : "\(ref.workspace) · \(status)")
                    .font(.caption).foregroundStyle(Theme.statusColor(ref.pane.status)).lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .task(id: ref.id) {
            while !Task.isCancelled {
                if let text = try? await HollrClient.screen(ref.server, pane: ref.pane.pane, lines: 30) {
                    preview = AgentSession.cleanScreen(text)
                }
                try? await Task.sleep(for: .seconds(ref.pane.status == "working" ? 4 : 15))
            }
        }
    }
}

struct LimitBar: View {
    let limit: UsageLimit

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(limit.label.replacingOccurrences(of: "Claude ", with: "")).font(.caption)
                Spacer()
                Text("\(Int((limit.used * 100).rounded())) %").font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(color)
                if let reset = limit.resetsAt {
                    Text("· \(RelativeTime.countdown(reset))").font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.fg.opacity(0.08))
                    Capsule().fill(color).frame(width: max(4, geo.size.width * limit.used))
                }
            }
            .frame(height: 6)
        }
    }

    private var color: Color {
        limit.used > 0.85 ? Omp.error : limit.used > 0.6 ? Omp.warning : Omp.success
    }
}

/// Per-account details behind the quiet limits line.
struct LimitsSheet: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @State private var loading = false
    @State private var updated: Date?

    var body: some View {
        // several servers report the same accounts: one row per limit (the highest value wins)
        let limits = Dictionary(grouping: store.servers.flatMap { herdr.usage[$0.id] ?? [] }, by: \.id)
            .compactMap { $0.value.max { $0.used < $1.used } }
            .sorted { ($0.label, $0.window) < ($1.label, $1.window) }
        NavigationStack {
            List {
            Group {
                Section {
                    NavigationLink { UsageHistoryView() } label: {
                        HStack {
                            Label("Verlauf & Statistik", systemImage: "chart.xyaxis.line")
                            Spacer()
                            Text("Beta").font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Theme.accent.opacity(0.2), in: Capsule()).foregroundStyle(Theme.accent)
                        }
                    }
                }
                ForEach(Dictionary(grouping: limits, by: \.providerName).sorted { $0.key < $1.key }, id: \.key) { provider, items in
                    Section(provider) {
                        ForEach(Dictionary(grouping: items, by: { $0.account ?? "" }).sorted { $0.key < $1.key }, id: \.key) { account, rows in
                            VStack(alignment: .leading, spacing: 8) {
                                if Set(items.compactMap(\.account)).count > 1 {
                                    Text("Konto \(account)").font(.caption).foregroundStyle(.secondary)
                                }
                                ForEach(rows) { LimitBar(limit: $0) }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            }
            .listRowBackground(Theme.card)
        }.themedList()
            .navigationTitle("Nutzungslimits")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await reload() } } label: {
                        if loading { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                    }
                    .disabled(loading)
                    .accessibilityLabel("Aktualisieren")
                }
                ToolbarItem(placement: .bottomBar) {
                    if let updated {
                        Text("Stand \(updated.formatted(date: .omitted, time: .shortened))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .refreshable { await reload() }
            // fresh numbers every time the sheet opens (the providers' APIs, not the 2-min cache)
            .task { await reload() }
        }
    }

    private func reload() async {
        loading = true
        await herdr.refreshUsage(store.servers, force: true)
        updated = .now
        loading = false
    }
}

private struct LimitsLine: View {
    let caps: [UsageCapacity]

    private var groups: [(provider: String, rows: [UsageCapacity])] {
        Dictionary(grouping: caps, by: \.provider).map { ($0.key, $0.value) }.sorted { $0.provider < $1.provider }
    }

    var body: some View {
        HStack(spacing: 14) {
            ForEach(groups, id: \.provider) { group in
                HStack(spacing: 5) {
                    Text(UsageLimit.name(group.provider)).foregroundStyle(.secondary)
                    ForEach(group.rows) { cap in CapText(cap: cap) }
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .font(.caption.monospacedDigit())
        .lineLimit(1)
    }
}

private struct CapText: View {
    let cap: UsageCapacity

    var body: some View {
        let percent = Int((cap.used * 100).rounded())
        let color: Color = cap.used > 0.85 ? Omp.error : cap.used > 0.6 ? Omp.warning : .secondary
        Text("\(cap.window) \(percent)%").foregroundStyle(color)
    }
}
