import SwiftUI

/// Übersicht (screens/Uebersicht): usage limits, "Braucht dich" as focus cards, "Läuft gerade" grouped by project.
/// Connections live in Einstellungen → Server.
struct DashboardView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions
    @Environment(MySessions.self) private var mySessions
    @Environment(Inbox.self) private var inbox
    @Environment(\.openInBrowser) private var openInBrowser
    let onNew: () -> Void
    @Binding var sheetAgent: String?
    @State private var workFilter: WorkFilter = .all
    @State private var reloading = false
    @State private var showLimits = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Gap.xl) {
                limitsStrip
                InboxSection { sheetAgent = $0 }
                workingSection
            }
            .padding(.horizontal, Gap.l)
            .padding(.bottom, Gap.xxl)
        }
        #if DEBUG
        // screenshots of "Läuft gerade" (-hollrScrollBottom YES)
        .defaultScrollAnchor(UserDefaults.standard.bool(forKey: "hollrScrollBottom") ? .bottom : .top)
        #endif
        .navigationTitle("Übersicht")
        .navigationBarTitleDisplayMode(.large)
        .themedPage()
        // what waits for you – on every herdr change (the live feed makes this immediate)
        .task(id: herdr.trees) { await inbox.update(herdr.allAgents(store.servers, includeShells: false)) }
        .onChange(of: herdr.trees) { _, trees in
            // forget sessions that were closed elsewhere
            let loaded = Set(trees.keys).filter { herdr.errors[$0] == nil }
            let alive = Set(herdr.allAgents(store.servers, includeShells: true).map(\.id))
            mySessions.prune(alive: alive, loadedServers: loaded)
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { openInBrowser() } label: { Image(.globe) }
                    .buttonStyle(.icon())
                    .accessibilityLabel("Browser")
                Button { Task { await reload() } } label: {
                    if reloading { Spinner(color: Theme.muted) } else { Image(.refresh) }
                }
                .buttonStyle(.icon())
                .disabled(reloading)
                .accessibilityLabel("Aktualisieren")
                Button(action: onNew) { Label("Neue Sitzung", icon: .plus) }
                    .buttonStyle(.hollr(.primary, small: true))
            }
        }
        .refreshable { await refreshAll() }
        .task {
            await herdr.refreshUsage(store.servers)
            // branches for the cards and rows
            if store.servers.contains(where: { herdr.spaces[$0.id] == nil }) { await herdr.refreshSpaces(store.servers) }
        }
    }

    private func refreshAll() async {
        await herdr.refresh(store.servers, force: true)
        await herdr.refreshUsage(store.servers, force: true)
    }

    private func reload() async {
        reloading = true
        await refreshAll()
        reloading = false
    }

    // MARK: Läuft gerade

    /// Alle / Arbeitet (working or waiting) / Neu (new result)
    enum WorkFilter: Hashable {
        case all, busy, new

        func includes(_ ref: AgentRef) -> Bool {
            switch self {
            case .all: return true
            case .busy: return ref.pane.status == "working" || ref.pane.status == "blocked"
            case .new: return ref.pane.status == "done"
            }
        }
    }

    /// One workspace on one server with its sessions (organism ProjectCard).
    private struct WorkProject: Identifiable {
        let id: String
        let name: String
        let server: Server
        var refs: [AgentRef]
    }

    private var liveIds: Set<String> { Set(sessions.sessions.filter { $0.value.isLive }.map(\.key)) }

    /// What's going on: the sessions you opened in Hollr plus every agent that works, waits or just finished.
    private var workRefs: [AgentRef] {
        let mine = Set(mySessions.ids)
        return herdr.allAgents(store.servers, includeShells: true).filter { ref in
            mine.contains(ref.id) || (ref.pane.agent != nil && ["working", "blocked", "done"].contains(ref.pane.status))
        }
    }

    /// grouped per workspace and server, in the agents' order (needs-you first)
    private func projects(_ refs: [AgentRef]) -> [WorkProject] {
        var order: [String] = []
        var byKey: [String: WorkProject] = [:]
        for ref in refs {
            let key = "\(ref.server.id.uuidString)|\(ref.workspace)"
            if byKey[key] == nil {
                order.append(key)
                byKey[key] = WorkProject(id: key, name: ref.workspace, server: ref.server, refs: [])
            }
            byKey[key]?.refs.append(ref)
        }
        return order.compactMap { byKey[$0] }
    }

    private var filterOptions: [(value: WorkFilter, title: String)] {
        [(value: .all, title: String(localized: "Alle")),
         (value: .busy, title: String(localized: "Arbeitet")),
         (value: .new, title: String(localized: "Neu"))]
    }

    @ViewBuilder private var workingSection: some View {
        let refs = workRefs
        VStack(alignment: .leading, spacing: Gap.m) {
            SectionHeader(title: String(localized: "Läuft gerade"), trailing: refs.isEmpty ? nil : "\(refs.count)")
            if !refs.isEmpty {
                Segmented(label: String(localized: "Filter"), options: filterOptions, selection: $workFilter, boxed: true)
                let shown = projects(refs.filter(workFilter.includes))
                if shown.isEmpty {
                    Text("Nichts mit diesem Filter.")
                        .font(Typo.sm).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .cardStyle()
                }
                let live = liveIds
                ForEach(shown) { project in projectCard(project, live: live) }
            } else if !herdr.loaded {
                skeleton
            } else {
                emptyCard
            }
        }
    }

    private func projectCard(_ project: WorkProject, live: Set<String>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            projectHead(project)
            ForEach(project.refs) { ref in workRow(ref, live: live.contains(ref.id)) }
        }
        .cardStyle(padding: EdgeInsets(top: Gap.s, leading: Gap.s, bottom: Gap.s, trailing: Gap.s), radius: Radius.xl)
    }

    /// colour bar, name, server (when several are paired), counts per state in their colours
    private func projectHead(_ project: WorkProject) -> some View {
        let states: [PaneState] = [.working, .blocked, .result]
        let counts: [(state: PaneState, count: Int)] = states.map { state in
            (state: state, count: project.refs.filter { PaneState(status: $0.pane.status, agent: $0.pane.agent != nil) == state }.count)
        }
        return HStack(spacing: Gap.s) {
            ProjectBar(color: Theme.identity(project.name), height: 15)
            Text(project.name).font(Typo.lg).lineLimit(1).layoutPriority(1)
            if store.servers.count > 1 {
                Text(project.server.label).font(Typo.sm).foregroundStyle(Theme.dim).lineLimit(1)
            }
            Spacer(minLength: Gap.xs)
            ForEach(counts.filter { $0.count > 0 }, id: \.state) { item in
                Text(verbatim: "\(item.count) \(item.state.label)")
                    .font(Typo.sm).foregroundStyle(item.state.color)
                    .lineLimit(1).fixedSize()
            }
        }
        .padding(.horizontal, 6).padding(.top, 2).padding(.bottom, 6)
    }

    private func workRow(_ ref: AgentRef, live: Bool) -> some View {
        Button { sheetAgent = ref.id } label: {
            AgentRow(ref: ref, showWorkspace: false, branch: herdr.branch(of: ref), live: live)
                .padding(Gap.s)
                .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        }
        .buttonStyle(WorkRowButtonStyle())
        .zoomSource(ref.id)
        .contextMenu {
            if mySessions.ids.contains(ref.id) {
                Button { mySessions.remove(ref.id) } label: {
                    Label("Aus der Übersicht nehmen", systemImage: "eye.slash")
                }
            }
            Button(role: .destructive) { closeSession(ref) } label: {
                Label("Sitzung beenden", systemImage: "xmark.circle")
            }
        }
    }

    private var skeleton: some View {
        VStack(alignment: .leading, spacing: Gap.m) {
            SkeletonBar(width: 120, height: 13)
            ForEach(0..<3, id: \.self) { i in
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Theme.wash(0.09)).frame(width: 28, height: 28)
                    VStack(alignment: .leading, spacing: 6) {
                        SkeletonBar(width: CGFloat([150, 190, 120][i]), height: 12)
                        SkeletonBar(width: CGFloat([90, 130, 70][i]), height: 9)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(radius: Radius.xl)
        .shimmer()
        .accessibilityElement()
        .accessibilityLabel("Lädt")
    }

    private var emptyCard: some View {
        VStack(alignment: .leading, spacing: Gap.m) {
            Text("Gerade läuft keine Sitzung. Starte eine neue oder öffne eine im Tab „Agents“.")
                .font(Typo.md).foregroundStyle(Theme.muted)
            Button(action: onNew) { Label("Neue Sitzung", icon: .plus) }
                .buttonStyle(.hollr(.primary))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(padding: EdgeInsets(top: Gap.l, leading: Gap.l, bottom: Gap.l, trailing: Gap.l), radius: Radius.xl)
    }

    private func closeSession(_ ref: AgentRef) {
        Task {
            try? await HollrClient.close(ref.server, pane: ref.pane.pane)
            mySessions.remove(ref.id)
            await herdr.refresh(store.servers)
        }
    }

    // MARK: Limits

    private var quietCaps: [UsageCapacity] {
        var all: [UsageCapacity] = []
        for server in store.servers { all += herdr.capacity[server.id] ?? [] }
        let providers: Set<String> = ["anthropic", "openai-codex"]
        let main = all.filter { cap in
            let mainMeter = cap.meter == nil || cap.meter == "chat"
            return mainMeter && providers.contains(cap.provider)
        }
        return Self.pooled(main)
    }

    /// One value per provider and window: several servers (and the same login on each) report the
    /// same limit – the line shows the fullest one, in a stable order (5h before 7d).
    static func pooled(_ caps: [UsageCapacity]) -> [UsageCapacity] {
        var best: [String: UsageCapacity] = [:]
        var order: [String] = []
        for cap in caps {
            let key = "\(cap.provider)|\(cap.window)"
            if let current = best[key] {
                if cap.used > current.used { best[key] = cap }
            } else {
                best[key] = cap
                order.append(key)
            }
        }
        return order.compactMap { best[$0] }.sorted {
            ($0.provider, Self.windowRank($0.window)) < ($1.provider, Self.windowRank($1.window))
        }
    }

    private static func windowRank(_ window: String) -> Int {
        let digits = Int(window.prefix { $0.isNumber }) ?? 0
        let unit = window.drop { $0.isNumber }
        let hours = unit.hasPrefix("h") ? 1 : unit.hasPrefix("d") ? 24 : unit.hasPrefix("w") ? 168 : 720
        return digits * hours
    }

    /// one quiet line (dash__limits): "Claude 5h ▬ 2% 7d ▬ 64%  ChatGPT …" (pooled over all accounts)
    @ViewBuilder private var limitsStrip: some View {
        let caps = quietCaps
        if !caps.isEmpty {
            Button { showLimits = true } label: { LimitsLine(caps: caps) }
                .buttonStyle(.plain)
                .sheet(isPresented: $showLimits) {
                    LimitsSheet()
                        .presentationDetents([.medium, .large])
                        .dialogSheet()
                }
        }
    }
}

/// usage colour like the desktop app: red above 85 %, orange above 60 %, else green (quiet: muted)
private func usedColor(_ used: Double, quiet: Bool = false) -> Color {
    used > 0.85 ? Theme.red : used > 0.6 ? Theme.orange : quiet ? Theme.muted : Theme.green
}

/// A work row's tap feedback: a text wash behind the row while pressed (work-row:hover).
private struct WorkRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.wash(0.05) : .clear,
                        in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
    }
}

/// One limit in the sheet: window, percent in its colour, meter, reset countdown.
private struct LimitBar: View {
    let limit: UsageLimit

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: Gap.s) {
                Text(limit.label.replacingOccurrences(of: "Claude ", with: "")).font(Typo.md)
                Spacer(minLength: Gap.s)
                Text(verbatim: "\(Int((limit.used * 100).rounded())) %")
                    .font(Typo.sm.monospacedDigit().weight(.semibold))
                    .foregroundStyle(usedColor(limit.used))
            }
            GeometryReader { geo in
                ProgressMeter(value: limit.used, width: geo.size.width, height: 6, color: usedColor(limit.used))
            }
            .frame(height: 6)
            if let reset = limit.resetsAt {
                Text("zurückgesetzt \(RelativeTime.countdown(reset))")
                    .font(Typo.xs.monospacedDigit()).foregroundStyle(Theme.dim)
            }
        }
    }
}

/// Per-account details behind the quiet limits line (organism LimitsDialog).
struct LimitsSheet: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(\.dismiss) private var dismiss
    @State private var loading = false
    @State private var updated: Date?

    /// several servers report the same accounts: one row per limit (the highest value wins)
    private var limits: [UsageLimit] {
        let all: [UsageLimit] = store.servers.flatMap { herdr.usage[$0.id] ?? [] }
        let best: [UsageLimit] = Dictionary(grouping: all, by: \.id).compactMap { $0.value.max { $0.used < $1.used } }
        return best.sorted { ($0.label, $0.window) < ($1.label, $1.window) }
    }

    private var providers: [(name: String, items: [UsageLimit])] {
        Dictionary(grouping: limits, by: \.providerName).map { ($0.key, $0.value) }.sorted { $0.name < $1.name }
    }

    // split up: as one expression the Release compiler took >500 ms to type-check it
    /// one card per provider and account ("Claude · martin@…")
    private func providerCards(_ provider: String, _ items: [UsageLimit]) -> some View {
        let accounts: [(String, [UsageLimit])] = Dictionary(grouping: items, by: { $0.account ?? "" })
            .map { ($0.key, $0.value) }.sorted { $0.0 < $1.0 }
        return ForEach(accounts, id: \.0) { account, rows in
            VStack(alignment: .leading, spacing: Gap.m) {
                Text(account.isEmpty ? provider : "\(provider) · \(account)")
                    .font(Typo.md.weight(.semibold)).lineLimit(1).truncationMode(.middle)
                ForEach(rows) { LimitBar(limit: $0) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardStyle()
        }
    }

    private var historyRow: some View {
        HStack(spacing: Gap.s) {
            Label("Verlauf & Statistik", systemImage: "chart.xyaxis.line").font(Typo.md).foregroundStyle(Theme.fg)
            Spacer(minLength: Gap.s)
            Text("Beta")
                .font(Typo.xs.weight(.semibold)).foregroundStyle(Theme.accent)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.accentSoft, in: Capsule())
            Image(.chevronRight).font(Typo.xs.weight(.semibold)).foregroundStyle(Theme.dim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .cardStyle()
    }

    var body: some View {
        NavigationStack {
            DialogScaffold(icon: .activity, title: String(localized: "Nutzungslimits"), onClose: { dismiss() }) {
                NavigationLink { UsageHistoryView() } label: { historyRow }
                    .buttonStyle(.plain)
                ForEach(providers, id: \.name) { provider in providerCards(provider.name, provider.items) }
            } footer: {
                if let updated {
                    Text("Stand \(updated.formatted(date: .omitted, time: .shortened))")
                        .font(Typo.sm).foregroundStyle(Theme.dim)
                }
                Spacer(minLength: 0)
                Button { Task { await reload() } } label: {
                    HStack(spacing: 6) {
                        if loading { Spinner(color: Theme.muted, size: 13) } else { IconView(.refresh, size: 14) }
                        Text("Aktualisieren")
                    }
                }
                .buttonStyle(.hollr(.secondary, small: true))
                .disabled(loading)
                Button("Fertig") { dismiss() }
                    .buttonStyle(.hollr(.primary, small: true))
            }
            .toolbar(.hidden, for: .navigationBar)
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

/// The quiet limits line (dash__limits): provider muted, window dim, a small meter, percent in its colour.
private struct LimitsLine: View {
    let caps: [UsageCapacity]

    private var groups: [(provider: String, rows: [UsageCapacity])] {
        Dictionary(grouping: caps, by: \.provider).map { ($0.key, $0.value) }.sorted { $0.provider < $1.provider }
    }

    /// The widest version that fits: one line with meters → one provider per line → "C 5h 43 7d 53" – never "ChatG…".
    var body: some View {
        HStack(spacing: Gap.s) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Gap.l) {
                    ForEach(groups, id: \.provider) { providerGroup($0, meters: true) }
                }
                VStack(alignment: .leading, spacing: Gap.s) {
                    ForEach(groups, id: \.provider) { providerGroup($0, meters: true) }
                }
                HStack(spacing: Gap.s) {
                    ForEach(groups, id: \.provider) { providerGroup($0, meters: false) }
                }
            }
            Spacer(minLength: 0)
            Image(.chevronRight).font(Typo.xs.weight(.semibold)).foregroundStyle(Theme.dim)
        }
        .font(Typo.sm.monospacedDigit())
        .padding(.vertical, Gap.s)
        .contentShape(Rectangle())
    }

    /// with meters: "Claude 5h ▬ 72%"; without: "C 5h 72"
    private func providerGroup(_ group: (provider: String, rows: [UsageCapacity]), meters: Bool) -> some View {
        let name = UsageLimit.name(group.provider)
        return HStack(spacing: meters ? Gap.m : Gap.xs) {
            Text(verbatim: meters ? name : String(name.prefix(1))).foregroundStyle(Theme.muted)
            ForEach(group.rows) { cap in CapText(cap: cap, meter: meters) }
        }
        .lineLimit(1)
        .fixedSize()
    }
}

private struct CapText: View {
    let cap: UsageCapacity
    var meter = true

    var body: some View {
        let value = Int((cap.used * 100).rounded())
        HStack(spacing: 6) {
            Text(verbatim: cap.window).foregroundStyle(Theme.dim)
            if meter { ProgressMeter(value: cap.used, width: 36, height: 4, color: usedColor(cap.used)) }
            Text(verbatim: meter ? "\(value)%" : "\(value)").foregroundStyle(usedColor(cap.used, quiet: true))
        }
        .accessibilityElement(children: .combine)
    }
}
