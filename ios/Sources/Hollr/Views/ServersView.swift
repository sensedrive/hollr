import SwiftUI

struct ServersView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    let onPair: () -> Void
    @State private var confirmRemove: Server?

    var body: some View {
        List {
            Group {
            Section {
                ForEach(store.servers) { server in
                    HStack(spacing: 14) {
                        Image(systemName: "server.rack")
                            .font(.title3)
                            .foregroundStyle(Theme.accent)
                            .frame(width: 36, height: 36)
                            .background(Theme.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: 9))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(server.label).font(.headline)
                            Text(server.displayAddress).font(.caption).foregroundStyle(.secondary)
                            if let error = herdr.errors[server.id] {
                                Text(error).font(.caption2).foregroundStyle(Theme.warn)
                            } else {
                                let n = herdr.agents(on: server).filter { $0.pane.agent != nil }.count
                                Text("\(n) Agents · Gerät \(server.deviceId)").font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                    .swipeActions {
                        Button("Entfernen", role: .destructive) { confirmRemove = server }
                    }
                }
            } footer: {
                Text("Team: Jede Person koppelt ihr eigenes iPhone mit `hollr pair`. Entfernen auf dem Server mit `hollr revoke <name>`.")
            }
            Section {
                Button(action: onPair) { Label("Server koppeln", systemImage: "qrcode.viewfinder") }
            }
            Section("Über") {
                LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")
                LabeledContent("Build", value: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?")
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .navigationTitle("Server")
        .confirmationDialog(
            String(localized: "Server aus Hollr entfernen?"), isPresented: .constant(confirmRemove != nil), titleVisibility: .visible,
            presenting: confirmRemove
        ) { server in
            Button("Entfernen", role: .destructive) { store.remove(server); confirmRemove = nil }
            Button("Abbrechen", role: .cancel) { confirmRemove = nil }
        } message: { server in
            Text("Auf dem Server bleibt der Schlüssel bis `hollr revoke \(server.deviceId)`.")
        }
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
