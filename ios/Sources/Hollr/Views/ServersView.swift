import SwiftUI

/// Settings → Server & Geräte: every paired server, each with its own page.
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
                } footer: {
                    Text("Team: Jede Person koppelt ihr eigenes iPhone mit `hollr pair`.")
                }
                Section {
                    Button(action: onPair) { Label("Server koppeln", systemImage: "qrcode.viewfinder") }
                }
            }
            .listRowBackground(Theme.card)
        }.themedList()
        .navigationTitle("Server & Geräte")
    }
}

private struct ServerRow: View {
    @Environment(HerdrStore.self) private var herdr
    let server: Server

    var body: some View {
        HStack(spacing: 14) {
            ServerIcon(error: herdr.errors[server.id] != nil)
            VStack(alignment: .leading, spacing: 2) {
                Text(server.label).font(.headline)
                Text(server.displayAddress).font(.caption).foregroundStyle(.secondary)
                if let mode = server.network, mode != .auto {
                    Label(mode.title, systemImage: mode == .tailscale ? "globe" : "wifi")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let error = herdr.errors[server.id] {
                    Text(error).font(.caption2).foregroundStyle(Theme.warn).lineLimit(2)
                } else {
                    let n = herdr.agents(on: server).filter { $0.pane.agent != nil }.count
                    Text("\(n) Agents").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private struct ServerIcon: View {
    let error: Bool
    var body: some View {
        Image(systemName: "server.rack")
            .font(.title3)
            .foregroundStyle(Theme.accent)
            .frame(width: 36, height: 36)
            .background(Theme.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: 9))
            .overlay(alignment: .bottomTrailing) {
                Circle().fill(error ? Theme.warn : Theme.live).frame(width: 9, height: 9)
                    .overlay(Circle().stroke(Theme.card, lineWidth: 2))
                    .offset(x: 2, y: 2)
            }
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
                    HStack(spacing: 14) {
                        ServerIcon(error: herdr.errors[server.id] != nil || error != nil)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(info?.host ?? server.label).font(.headline)
                            Text(info.map { "\($0.os) · Hollr \($0.hollr)" } ?? server.displayAddress)
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    if let error {
                        Text(error).font(.caption).foregroundStyle(Theme.warn)
                    } else {
                        if info == nil {
                            stats.redacted(reason: .placeholder).shimmer()
                        } else {
                            stats
                        }
                    }
                }
                Section {
                    NavigationLink { ServerInfoView(server: server) } label: {
                        LabeledContent {
                            if info != nil {
                                Text(problems.isEmpty ? String(localized: "Alles bereit") : String(localized: "\(problems.count) Problem(e)"))
                                    .foregroundStyle(problems.isEmpty ? Theme.live : Theme.warn)
                            }
                        } label: {
                            Label("Server-Info", systemImage: "gauge.with.dots.needle.67percent")
                        }
                    }
                    NavigationLink { ToolsView(server: server) } label: {
                        LabeledContent {
                            if let tools {
                                Text(updates + missing == 0 ? String(localized: "Aktuell")
                                     : missing > 0 ? String(localized: "\(missing) fehlt") : String(localized: "\(updates) Update(s)"))
                                    .foregroundStyle(updates + missing == 0 ? Theme.live : Theme.accent)
                            }
                        } label: {
                            Label("Werkzeuge", systemImage: "shippingbox")
                        }
                    }
                } footer: {
                    if !problems.isEmpty {
                        Text(problems.map(\.name).joined(separator: " · "))
                    }
                }
                connection
                Section("Dieses Gerät") {
                    LabeledContent("Geräte-ID", value: server.deviceId)
                    LabeledContent("Adresse", value: server.displayAddress)
                    Button("Server aus Hollr entfernen", role: .destructive) { confirmRemove = true }
                }
            }
            .listRowBackground(Theme.card)
        }.themedList()
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
                Label("Verbindungsart", systemImage: mode == .tailscale ? "globe" : "wifi")
            }
            .disabled(switching)
            HStack(spacing: 10) {
                Circle().fill(via != nil ? Theme.live : Theme.warn).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    if let via {
                        Text("Verbunden über \(via)")
                        Text(Tailscale.isTailscale(via) ? String(localized: "Tailscale – verschlüsselt, ohne offene Ports") : String(localized: "Direkt über das Netzwerk"))
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Nicht erreichbar")
                        Text(unreachableHint(mode)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if switching { Spacer(); ProgressView() }
            }
            DisclosureGroup("Adressen") {
                ForEach(current.addresses, id: \.self) { host in
                    HStack {
                        Text(host).font(.caption.monospaced())
                        Spacer()
                        if Tailscale.isTailscale(host) { Text("Tailscale").font(.caption2).foregroundStyle(.secondary) }
                    }
                }
            }
        } header: {
            Text("Verbindung")
        } footer: {
            Text(networkError ?? mode.explanation)
                .foregroundStyle(networkError == nil ? Color.secondary : Theme.warn)
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
            Text(value).font(.headline.monospacedDigit())
            Text(title).font(.caption2).foregroundStyle(.secondary)
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

struct WelcomeView: View {
    let onPair: () -> Void

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            Orb(level: 0.15, color: Theme.accent, size: 150)
            VStack(spacing: 10) {
                Text("Hollr").font(.system(size: 40, weight: .bold, design: .rounded))
                Text("Sprich mit omp /live auf deinem Server –\nso, als säßest du davor.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .leading, spacing: 12) {
                Step(n: 1, text: "Auf dem Server: Installer ausführen")
                Step(n: 2, text: "`hollr pair` starten")
                Step(n: 3, text: "QR-Code scannen – fertig")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 16))
            Button(action: onPair) {
                Label("Server koppeln", systemImage: "qrcode.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(24)
    }

    private struct Step: View {
        let n: Int
        let text: LocalizedStringKey
        var body: some View {
            HStack(spacing: 12) {
                Text("\(n)")
                    .font(.footnote.bold())
                    .frame(width: 24, height: 24)
                    .background(Theme.accent.opacity(0.25), in: Circle())
                Text(text).font(.subheadline)
            }
        }
    }
}

/// Visible on every screen while a call is live but you are looking at something else.
struct LiveBar: View {
    @Environment(SessionStore.self) private var sessions
    @Binding var path: [String]
    @Binding var tab: RootView.RootTab

    var body: some View {
        if let session = sessions.liveSession, path.last != session.ref.id {
            HStack(spacing: 12) {
                Circle().fill(session.muted ? Theme.warn : Theme.live).frame(width: 10, height: 10)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.ref.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("Live · \(Theme.ompStateLabel(session.ompState))").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { session.toggleMute() } label: {
                    Image(systemName: session.muted ? "mic.slash.fill" : "mic.fill")
                        .frame(width: 36, height: 36)
                        .background(Theme.card, in: Circle())
                }
                Button { session.stop() } label: {
                    Image(systemName: "phone.down.fill")
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Color.red, in: Circle())
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
            .padding(.horizontal, 12)
            .padding(.bottom, 4)
            .contentShape(Rectangle())
            .onTapGesture {
                tab = .agents
                path = [session.ref.id]
            }
        }
    }
}
