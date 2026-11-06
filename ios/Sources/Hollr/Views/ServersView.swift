import SwiftUI

/// Settings → Server & Geräte: every paired server (ServerCard rows), each with its own page, and "Server koppeln".
struct ServersView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    let onPair: () -> Void

    var body: some View {
        List {
            Group {
                Section {
                    ForEach(store.servers) { server in
                        NavigationLink { ServerDetailView(server: server) } label: { ServerRow(server: server) }
                    }
                    Button(action: onPair) {
                        HStack(spacing: Gap.m) {
                            IconView(.plus, size: 17)
                                .frame(width: 38, height: 38)
                                .background(Theme.wash(0.06), in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                            Text("Server koppeln").font(Typo.md.weight(.semibold))
                            Spacer()
                            Image(systemName: "qrcode.viewfinder").foregroundStyle(Theme.dim)
                        }
                        .foregroundStyle(Theme.muted)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } header: {
                    SectionHeader(title: String(localized: "Verbindungen"), trailing: "\(store.servers.count)")
                } footer: {
                    Text("Team: Jede Person koppelt ihr eigenes iPhone mit `hollr pair`.")
                        .font(Typo.sm).foregroundStyle(Theme.dim)
                }
            }
            .listRowBackground(Theme.card)
        }
        .labelStyle(.settings)
        .themedList()
        .navigationTitle("Server & Geräte")
    }
}

/// Connection state of a paired server (ServerCard dot): green connected, orange problem, dim not loaded yet.
private enum ServerState {
    case ok, bad, unknown

    init(error: Bool, loaded: Bool) { self = error ? .bad : loaded ? .ok : .unknown }

    var color: Color {
        switch self {
        case .ok: return Theme.green
        case .bad: return Theme.orange
        case .unknown: return Theme.dim
        }
    }

    var label: String {
        switch self {
        case .ok: return String(localized: "Verbunden")
        case .bad: return String(localized: "Verbindungsproblem")
        case .unknown: return String(localized: "Unbekannt")
        }
    }
}

/// One paired server (molecule ServerCard): rack tile, label, mono address, error or agent count, status dot.
private struct ServerRow: View {
    @Environment(HerdrStore.self) private var herdr
    let server: Server

    var body: some View {
        let state = ServerState(error: herdr.errors[server.id] != nil, loaded: herdr.trees[server.id] != nil)
        HStack(spacing: Gap.m) {
            ServerIcon()
            VStack(alignment: .leading, spacing: 1) {
                Text(server.label).font(Typo.md.weight(.semibold)).lineLimit(1)
                Text(verbatim: server.displayAddress).font(Typo.monoXS).foregroundStyle(Theme.muted).lineLimit(1)
                if let error = herdr.errors[server.id] {
                    Text(error).font(Typo.sm).foregroundStyle(Theme.orange).lineLimit(2)
                } else {
                    HStack(spacing: 6) {
                        let n = herdr.agents(on: server).filter { $0.pane.agent != nil }.count
                        Text("\(n) Agents")
                        if let mode = server.network, mode != .auto {
                            Text(verbatim: "·")
                            Image(systemName: mode == .tailscale ? HIcon.globe.symbol : "wifi")
                            Text(mode.title)
                        }
                    }
                    .font(Typo.xs).foregroundStyle(Theme.dim)
                }
            }
            Spacer(minLength: Gap.s)
            Circle().fill(state.color).frame(width: 9, height: 9)
                .accessibilityLabel(state.label)
        }
        .padding(.vertical, 2)
    }
}

/// The server's rack tile (ServerCard rack): accent icon on an accent wash.
private struct ServerIcon: View {
    var body: some View {
        IconView(.server, size: 17)
            .foregroundStyle(Theme.accent)
            .frame(width: 38, height: 38)
            .background(Theme.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// One server: status at a glance, then server info, tools and this device.
struct ServerDetailView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(\.dismiss) private var dismiss
    let server: Server
    @State private var info: ServerInfo?
    @State private var tools: [ServerTool]?
    @State private var error: String?
    @State private var confirmRemove = false
    @State private var switching = false
    @State private var networkError: String?

    /// the stored server (changes when the connection type is switched)
    private var current: Server { store.servers.first { $0.id == server.id } ?? server }

    private var problems: [ServerInfo.Check] { info?.checks.filter { !$0.ok } ?? [] }
    private var updates: Int { tools?.filter { $0.updateAvailable == true }.count ?? 0 }
    private var missing: Int { tools?.filter { !$0.installed }.count ?? 0 }

    var body: some View {
        List {
            Group {
                Section {
                    let failing = herdr.errors[server.id] != nil || error != nil
                    let state = ServerState(error: failing, loaded: info != nil || herdr.trees[server.id] != nil)
                    HStack(spacing: Gap.m) {
                        ServerIcon()
                        VStack(alignment: .leading, spacing: 1) {
                            Text(info?.host ?? server.label).font(Typo.lg).lineLimit(1)
                            Text(info.map { "\($0.os) · Hollr \($0.hollr)" } ?? server.displayAddress)
                                .font(Typo.monoXS).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: Gap.s)
                        Circle().fill(state.color).frame(width: 9, height: 9)
                            .accessibilityLabel(state.label)
                    }
                    .padding(.vertical, 2)
                    if let error {
                        Label(error, icon: .alert).font(Typo.sm).foregroundStyle(Theme.warn)
                    } else {
                        if info == nil {
                            stats.redacted(reason: .placeholder).shimmer()
                        } else {
                            stats
                        }
                    }
                }
                if let info {
                    SetupChecklist(server: current, checks: info.checks) { await load() }
                }
                Section {
                    NavigationLink { ServerInfoView(server: server) } label: {
                        LabeledContent {
                            if info != nil {
                                Text(problems.isEmpty ? String(localized: "Alles bereit") : String(localized: "\(problems.count) Problem(e)"))
                                    .foregroundStyle(problems.isEmpty ? Theme.green : Theme.warn)
                            }
                        } label: {
                            Label("Server-Info", icon: .cpu)
                        }
                    }
                    NavigationLink { ToolsView(server: server) } label: {
                        LabeledContent {
                            if let tools {
                                Text(updates + missing == 0 ? String(localized: "Aktuell")
                                     : missing > 0 ? String(localized: "\(missing) fehlt") : String(localized: "\(updates) Update(s)"))
                                    .foregroundStyle(updates + missing == 0 ? Theme.green : Theme.accent)
                            }
                        } label: {
                            Label("Werkzeuge", systemImage: "shippingbox")
                        }
                    }
                } footer: {
                    if !problems.isEmpty {
                        Text(problems.map(\.name).joined(separator: " · "))
                            .font(Typo.sm).foregroundStyle(Theme.dim)
                    }
                }
                connection
                Section {
                    LabeledContent {
                        Text(verbatim: server.deviceId).font(Typo.monoSmall).foregroundStyle(Theme.muted).lineLimit(1)
                    } label: { Text("Geräte-ID") }
                    LabeledContent {
                        Text(verbatim: server.displayAddress).font(Typo.monoSmall).foregroundStyle(Theme.muted).lineLimit(1)
                    } label: { Text("Adresse") }
                    Button(role: .destructive) { confirmRemove = true } label: {
                        Label("Server aus Hollr entfernen", icon: .trash)
                            .labelStyle(.titleAndIcon)
                            .foregroundStyle(Theme.red)
                    }
                } header: {
                    SectionHeader(title: String(localized: "Dieses Gerät"))
                }
            }
            .listRowBackground(Theme.card)
        }
        .labelStyle(.settings)
        .themedList()
        .navigationTitle(server.label)
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog(String(localized: "Server aus Hollr entfernen?"), isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Entfernen", role: .destructive) {
                store.remove(server)
                dismiss()
            }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Auf dem Server bleibt der Schlüssel bis `hollr revoke \(server.deviceId)`.")
        }
    }

    // MARK: connection

    private var connection: some View {
        let via = ConnectionInfo.shared.via[current.hostFingerprint]
        let mode = current.network ?? .auto
        return Section {
            Picker(selection: Binding(get: { mode }, set: { new in Task { await switchNetwork(to: new) } })) {
                ForEach(NetworkMode.allCases) { Text($0.title).tag($0) }
            } label: {
                Label("Verbindungsart", systemImage: mode == .tailscale ? HIcon.globe.symbol : "wifi")
            }
            .disabled(switching)
            HStack(spacing: 10) {
                Circle().fill(via != nil ? Theme.green : Theme.orange).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    if let via {
                        Text("Verbunden über \(via)").font(Typo.md)
                        Text(Tailscale.isTailscale(via) ? String(localized: "Tailscale – verschlüsselt, ohne offene Ports") : String(localized: "Direkt über das Netzwerk"))
                            .font(Typo.sm).foregroundStyle(Theme.muted)
                    } else {
                        Text("Nicht erreichbar").font(Typo.md)
                        Text(unreachableHint(mode)).font(Typo.sm).foregroundStyle(Theme.muted)
                    }
                }
                if switching { Spacer(); Spinner(color: Theme.muted, size: 16) }
            }
            DisclosureGroup("Adressen") {
                ForEach(current.addresses, id: \.self) { host in
                    HStack {
                        Text(verbatim: host).font(Typo.monoSmall)
                        Spacer()
                        if Tailscale.isTailscale(host) { Text("Tailscale").font(Typo.xs).foregroundStyle(Theme.muted) }
                    }
                }
            }
            .tint(Theme.dim)
        } header: {
            SectionHeader(title: String(localized: "Verbindung"))
        } footer: {
            Text(networkError ?? mode.explanation)
                .font(Typo.sm)
                .foregroundStyle(networkError == nil ? Theme.dim : Theme.warn)
        }
    }

    private func unreachableHint(_ mode: NetworkMode) -> String {
        if mode == .tailscale || current.addresses.contains(where: Tailscale.isTailscale) {
            if !Tailscale.isActiveOnDevice {
                return String(localized: "Tailscale ist auf dem iPhone aus – Tailscale-App öffnen und verbinden.")
            }
            return String(localized: "Der Rechner ist aus, schläft oder Tailscale läuft dort nicht.")
        }
        return String(localized: "Nur im selben Netzwerk erreichbar – für unterwegs „Tailscale / Fernzugriff“ wählen.")
    }

    /// Re-orders / extends the addresses from what the server reports – no new pairing needed
    /// (same server: the pinned host key still has to match).
    private func switchNetwork(to mode: NetworkMode) async {
        switching = true
        defer { switching = false }
        do {
            let network = try await HollrClient.network(current)
            if mode == .tailscale, network.tailscale.addresses.isEmpty {
                networkError = network.tailscale.installed
                    ? String(localized: "Tailscale läuft auf dem Rechner nicht (Status: \(network.tailscale.state ?? "?")). Dort starten: tailscale up")
                    : String(localized: "Tailscale ist auf dem Rechner nicht installiert. Anleitung: hollr pair --tailscale")
                return
            }
            let addresses = network.addresses(for: mode)
            guard !addresses.isEmpty else { throw HollrError.badResponse }
            store.setNetwork(current, mode: mode, addresses: addresses)
            await SSHPool.shared.invalidate(current)
            networkError = nil
        } catch {
            networkError = String(localized: "Umstellen geht nur, solange der Rechner erreichbar ist: \(error.localizedDescription)")
        }
    }

    private var stats: some View {
        let i = info ?? .placeholder
        let mem = i.memory.total > 0 ? Int(i.memory.used / i.memory.total * 100) : 0
        let disk = i.disks.first.map { $0.total > 0 ? Int($0.used / $0.total * 100) : 0 } ?? 0
        return HStack(spacing: 0) {
            stat(String(localized: "CPU"), i.cpu.map { "\(Int($0)) %" } ?? "–")
            stat(String(localized: "Last"), String(format: "%.1f", i.load.first ?? 0))
            stat(String(localized: "RAM"), "\(mem) %")
            stat(String(localized: "Disk"), "\(disk) %")
            stat(String(localized: "Agents"), "\(herdr.agents(on: server).filter { $0.pane.agent != nil }.count)")
        }
    }

    private func stat(_ title: String, _ value: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(Typo.lg.monospacedDigit())
            Text(title).font(Typo.xs).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
    }

    private func load() async {
        async let i = HollrClient.sysinfo(server)
        async let t = HollrClient.tools(server)
        do {
            info = try await i
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        tools = try? await t
    }
}

/// No server paired yet: brand orb, big title, muted pitch, the three steps and the primary "Server koppeln".
struct WelcomeView: View {
    let onPair: () -> Void

    var body: some View {
        VStack(spacing: Gap.xl) {
            Spacer()
            Orb(level: 0.15, color: Theme.accent, size: 120)
            VStack(spacing: Gap.s + 2) {
                Text("Hollr").font(.largeTitle.weight(.bold))
                Text("Sprich mit omp /live auf deinem Server –\nso, als säßest du davor.")
                    .font(Typo.md)
                    .multilineTextAlignment(.center).foregroundStyle(Theme.muted)
            }
            Spacer()
            Rows {
                Step(n: 1, text: "Auf dem Server: Installer ausführen")
                Step(n: 2, text: "`hollr pair` starten")
                Step(n: 3, text: "QR-Code scannen – fertig")
            }
            Button(action: onPair) {
                Label("Server koppeln", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(.hollr(.primary, fullWidth: true))
        }
        .padding(Gap.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg.ignoresSafeArea())
    }

    private struct Step: View {
        let n: Int
        let text: LocalizedStringKey
        var body: some View {
            HStack(spacing: Gap.m) {
                // numbered tile like the option rows
                Text(verbatim: "\(n)")
                    .font(Typo.monoSmall.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 24, height: 24)
                    .background(Theme.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
                Text(text).font(Typo.md)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 10).padding(.horizontal, 14)
        }
    }
}

/// Visible on every screen while a call is live but you are looking at something else (molecule LivePill).
struct LiveBar: View {
    @Environment(SessionStore.self) private var sessions
    @Binding var path: [String]
    @Binding var tab: RootView.RootTab

    var body: some View {
        if let session = sessions.liveSession, path.last != session.ref.id {
            HStack(spacing: Gap.xs) {
                Button {
                    tab = .agents
                    path = [session.ref.id]
                } label: {
                    HStack(spacing: Gap.s) {
                        LiveDot(color: session.muted ? Theme.warn : Theme.live)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Live · \(session.ref.title)").font(Typo.sm.weight(.semibold)).lineLimit(1)
                            Text(Theme.ompStateLabel(session.ompState)).font(Typo.xs).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Gap.xs)
                    .frame(maxWidth: .infinity, minHeight: Metric.touch)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Zur Sitzung")
                Button { session.toggleMute() } label: {
                    Image(systemName: session.muted ? "mic.slash" : HIcon.mic.symbol).font(.system(size: 14, weight: .medium))
                }
                .buttonStyle(LivePillButtonStyle(active: session.muted))
                .accessibilityLabel(session.muted ? "Mikrofon an" : "Mikrofon aus")
                Button { session.stop() } label: {
                    IconView(.x, size: 14)
                }
                .buttonStyle(LivePillButtonStyle(hang: true))
                .accessibilityLabel("Live beenden")
            }
            .livePillStyle()
            .padding(.horizontal, Gap.m)
            .padding(.bottom, Gap.xs)
        }
    }
}

/// Round 28 pt pill button (live-pill__b) on a 44 pt touch target: muted, text wash when pressed; hang-up turns red.
private struct LivePillButtonStyle: ButtonStyle {
    var hang = false
    var active = false

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        configuration.label
            .foregroundStyle(hang && pressed ? Theme.onAccent : pressed || active ? Theme.fg : Theme.muted)
            .frame(width: 28, height: 28)
            .background(hang && pressed ? Theme.red : pressed || active ? Theme.wash(0.12) : .clear, in: Circle())
            .frame(width: 36, height: Metric.touch)
            .contentShape(Rectangle())
    }
}
