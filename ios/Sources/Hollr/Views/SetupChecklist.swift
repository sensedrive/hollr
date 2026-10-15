import SwiftUI
import UIKit

/// Server › Einrichtung: what is still missing on this computer, each with a fix – install with a
/// tap, restart the watcher, set up push, or a command to copy.
struct SetupChecklist: View {
    let server: Server
    let checks: [ServerInfo.Check]
    let reload: () async -> Void
    @Environment(ServerStore.self) private var store
    @State private var busy: String?
    @State private var message: String?
    @State private var copied: String?
    @State private var pushSource: Server?

    private var problems: [ServerInfo.Check] { checks.filter { !$0.ok } }

    var body: some View {
        Section {
            if problems.isEmpty {
                Label("Alles eingerichtet", systemImage: "checkmark.seal.fill").foregroundStyle(Theme.live)
            }
            ForEach(problems) { check in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.warn)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(check.name).font(.subheadline.weight(.semibold))
                            Text(check.detail).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    fixButton(check)
                }
                .padding(.vertical, 4)
            }
            if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
        } header: {
            Text("Einrichtung · \(checks.count - problems.count)/\(checks.count) bereit")
        }
        .confirmationDialog("Push-Schlüssel übernehmen?", isPresented: Binding(
            get: { pushSource != nil }, set: { if !$0 { pushSource = nil } }), titleVisibility: .visible,
                            presenting: pushSource) { source in
            Button("Von \(source.label) übernehmen") { Task { await copyPushKey(from: source) } }
        } message: { source in
            Text("Der APNs-Schlüssel von \(source.label) wird über die gekoppelte Verbindung auf \(server.label) eingerichtet und in Hollr gespeichert.")
        }
    }

    @ViewBuilder private func fixButton(_ check: ServerInfo.Check) -> some View {
        let action = check.action ?? ""
        if action.hasPrefix("tool:") {
            button(check, String(localized: "Installieren"), "arrow.down.circle") {
                _ = try await HollrClient.tools(server, run: String(action.dropFirst(5)))
                message = String(localized: "Installation läuft – in einer Minute neu prüfen.")
            }
        } else if action == "watch" {
            button(check, String(localized: "Neu starten"), "arrow.clockwise") {
                struct R: Decodable { let ok: Bool? }
                let r = try await HollrClient.fs(server, ["op": "restart-watch"], as: R.self, command: "tools")
                message = r.ok == true ? String(localized: "Wächter läuft wieder.") : String(localized: "Neustart hat nicht geklappt.")
            }
        } else if action == "push" {
            button(check, String(localized: "Push einrichten"), "bell.badge") { try await setUpPush() }
        } else if let fix = check.fix, !fix.isEmpty {
            HStack(spacing: 8) {
                Text(fix).font(.caption.monospaced()).lineLimit(2).textSelection(.enabled)
                Spacer(minLength: 4)
                Button {
                    UIPasteboard.general.string = fix
                    copied = check.id
                } label: {
                    Image(systemName: copied == check.id ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Befehl kopieren")
            }
            .padding(8)
            .background(Theme.fg.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func button(_ check: ServerInfo.Check, _ title: String, _ icon: String,
                        _ run: @escaping () async throws -> Void) -> some View {
        Button {
            Task {
                busy = check.id
                defer { busy = nil }
                do {
                    try await run()
                    Haptics.notify(.success)
                    await reload()
                } catch {
                    message = error.localizedDescription
                }
            }
        } label: {
            HStack(spacing: 6) {
                if busy == check.id { ProgressView().controlSize(.small) } else { Image(systemName: icon) }
                Text(title)
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(busy != nil)
    }

    /// The key is in Hollr: install it here. Otherwise take it from a server that has one (asks first).
    private func setUpPush() async throws {
        let push = PushManager.shared
        if !push.enabled { await push.setEnabled(true) }
        if PushKey.load() != nil {
            push.serverReady[server.id] = nil
            await push.registerEverywhere()
            message = String(localized: "Push eingerichtet.")
            return
        }
        for other in store.servers where other.id != server.id && push.serverReady[other.id] == true {
            pushSource = other
            return
        }
        message = String(localized: "Kein Server mit Push-Schlüssel gefunden – den .p8-Schlüssel einmal unter Einstellungen › Mitteilungen importieren.")
    }

    private func copyPushKey(from source: Server) async {
        busy = "push"
        defer { busy = nil }
        do {
            struct R: Decodable { let key: String; let keyId: String; let teamId: String }
            let r = try await HollrClient.fs(source, ["op": "export"], as: R.self, command: "push")
            try PushKey(pem: r.key, keyId: r.keyId, teamId: r.teamId).save()
            PushManager.shared.serverReady[server.id] = nil
            await PushManager.shared.registerEverywhere()
            message = String(localized: "Push-Schlüssel von \(source.label) übernommen – \(server.label) schickt jetzt Mitteilungen.")
            Haptics.notify(.success)
            await reload()
        } catch {
            message = error.localizedDescription
        }
    }
}
