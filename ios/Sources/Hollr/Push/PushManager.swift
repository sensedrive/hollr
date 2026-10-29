import SwiftUI
import UIKit
import UserNotifications

/// Push notifications for agent activity. The phone registers its APNs token with every
/// paired server; the server's `hollr watch` sends straight to Apple – no relay.
@Observable @MainActor
final class PushManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushManager()

    enum Kind: String, CaseIterable, Identifiable {
        case waiting, done, error, activity
        var id: String { rawValue }
        var title: String {
            switch self {
            case .waiting: return String(localized: "Fragen & Bestätigungen")
            case .done: return String(localized: "Aufgabe fertig")
            case .error: return String(localized: "Fehler")
            case .activity: return String(localized: "Live-Aktivität auf dem Sperrbildschirm")
            }
        }
    }

    var enabled = UserDefaults.standard.bool(forKey: "push.enabled")
    var authorized: UNAuthorizationStatus = .notDetermined
    /// APNs token – kept, so answering from a notification works right after a background launch
    var token: String? = UserDefaults.standard.string(forKey: "push.token")
    /// per server: nil = unknown, true = APNs key set up on the server
    var serverReady: [UUID: Bool] = [:]
    var lastResult: String?
    /// set when a notification is tapped: open this agent
    var openRequest: (fp: String, pane: String)?
    /// Shortcut / Siri "Live starten": open this agent and start /live
    var liveRequest: (fp: String, pane: String)?
    /// the agent currently on screen (no banner for it)
    var visibleAgentId: String?

    private var servers: [Server] = []
    /// launched in the background (notification answer, Live Activity token): no UI has loaded the servers
    private var knownServers: [Server] { servers.isEmpty ? ServerStore().servers : servers }

    func wants(_ kind: Kind) -> Bool {
        UserDefaults.standard.object(forKey: "push.\(kind.rawValue)") as? Bool ?? true
    }

    func set(_ kind: Kind, _ on: Bool) {
        UserDefaults.standard.set(on, forKey: "push.\(kind.rawValue)")
        Task { await registerEverywhere() }
    }

    func start(servers: [Server]) {
        self.servers = servers
        UNUserNotificationCenter.current().delegate = self
        Task {
            authorized = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            if enabled && authorized == .authorized { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func updateServers(_ servers: [Server]) {
        self.servers = servers
        Task { await registerEverywhere() }
    }

    func setEnabled(_ on: Bool) async {
        enabled = on
        UserDefaults.standard.set(on, forKey: "push.enabled")
        if on {
            let granted = (try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge, .timeSensitive])) ?? false
            authorized = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        } else {
            for server in servers {
                if let token { _ = try? await call(server, ["op": "unregister", "token": token]) }
            }
        }
    }

    func didRegister(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: "push.token")
        Task { await registerEverywhere() }
    }

    private var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    func registerEverywhere() async {
        guard enabled, let token else { return }
        let prefs = Dictionary(uniqueKeysWithValues: Kind.allCases.map { ($0.rawValue, wants($0)) })
        for server in knownServers {
            do {
                // first: give servers without APNs key the team key from the keychain
                if serverReady[server.id] != true, let key = PushKey.load() {
                    _ = try? await call(server, ["op": "setup", "key": key.pem, "keyId": key.keyId, "teamId": key.teamId,
                                                 "bundleId": Bundle.main.bundleIdentifier ?? "app.hollr.ios"])
                }
                var body: [String: Any] = [
                    "op": "register", "token": token, "env": environment,
                    "name": UIDevice.current.name, "prefs": prefs, "lang": HollrClient.appLanguage,
                ]
                if let start = LiveActivities.startToken { body["liveStart"] = start }
                let r = try await call(server, body)
                serverReady[server.id] = r.configured ?? false
            } catch {
                HollrLog.error("push register \(server.label): \(error)")
            }
        }
    }

    var hasKey: Bool { PushKey.load() != nil }

    /// Imports the .p8 once; then every server gets it automatically.
    func importKey(from url: URL, keyId: String, teamId: String) async throws {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let pem = try String(contentsOf: url, encoding: .utf8)
        guard pem.contains("BEGIN PRIVATE KEY") else { throw HollrError.server(String(localized: "Das ist keine APNs-Schlüsseldatei (.p8).")) }
        try PushKey(pem: pem, keyId: keyId, teamId: teamId).save()
        serverReady = [:]
        await registerEverywhere()
    }

    func sendTest() async {
        lastResult = nil
        var parts: [String] = []
        for server in servers {
            do {
                let r = try await call(server, ["op": "test"])
                parts.append(r.configured == true ? "\(server.label): \(r.sent ?? 0) gesendet" : String(localized: "\(server.label): Push nicht eingerichtet"))
            } catch {
                parts.append("\(server.label): \(error.localizedDescription)")
            }
        }
        lastResult = parts.joined(separator: "\n")
    }

    /// A Live Activity got its update token (nil = it ended): the server it belongs to needs it.
    func reportActivity(fp: String, pane: String, token activity: String?) async {
        guard let token, let server = knownServers.first(where: { $0.hostFingerprint == fp }) else { return }
        do {
            _ = try await call(server, ["op": "activity", "token": token, "pane": pane, "activity": activity ?? NSNull()])
        } catch {
            HollrLog.error("live activity token \(server.label): \(error)")
        }
    }

    // MARK: Answering from the notification

    static let replyAction = "hollr.reply"
    static let openAction = "hollr.open"

    /// Buttons under a notification. Questions get one button per option from the content extension
    /// (the options differ every time); the static set is the fallback.
    static func registerCategories() {
        let reply = UNTextInputNotificationAction(
            identifier: replyAction, title: String(localized: "Antworten …"), options: [.authenticationRequired],
            textInputButtonTitle: String(localized: "Senden"), textInputPlaceholder: String(localized: "Nachricht an den Agent")
        )
        let more = UNTextInputNotificationAction(
            identifier: replyAction, title: String(localized: "Weiter …"), options: [.authenticationRequired],
            textInputButtonTitle: String(localized: "Senden"), textInputPlaceholder: String(localized: "Nächster Auftrag")
        )
        let open = UNNotificationAction(identifier: openAction, title: String(localized: "Öffnen"), options: [.foreground])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "HOLLR_ASK", actions: [reply, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "HOLLR_WAITING", actions: [reply, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "HOLLR_DONE", actions: [more, open], intentIdentifiers: []),
        ])
    }

    /// Runs the answer on the server (the app may have been launched in the background just for this).
    private func answer(_ response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let pane = info["pane"] as? String, let fp = info["fp"] as? String,
              let server = knownServers.first(where: { $0.hostFingerprint == fp }) else { return }
        let action = response.actionIdentifier
        do {
            if action == Self.replyAction, let text = (response as? UNTextInputNotificationResponse)?.userText
                .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                try await HollrClient.prompt(server, pane: pane, text: text)
                HollrLog.info("push: replied to \(pane)")
            } else if action.hasPrefix("opt."), let index = Int(action.dropFirst(4)) {
                // the server types the keys (omp's cursor starts on the recommended option)
                try await HollrClient.answer(server, pane: pane, ask: info["ask"] as? String, picks: [AskPick(options: [index])])
                HollrLog.info("push: picked option \(index) for \(pane)")
            }
        } catch {
            HollrLog.error("push answer \(pane): \(error)")
            // say so – the user believes it was sent
            let content = UNMutableNotificationContent()
            content.title = String(localized: "Antwort nicht gesendet")
            content.body = error.localizedDescription
            content.userInfo = info
            content.categoryIdentifier = response.notification.request.content.categoryIdentifier
            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    private struct Reply: Decodable {
        let configured: Bool?
        let sent: Int?
        let error: String?
    }

    private func call(_ server: Server, _ body: [String: Any]) async throws -> Reply {
        try await HollrClient.fs(server, body, as: Reply.self, command: "push")
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let info = notification.request.content.userInfo
        let pane = info["pane"] as? String
        let visible = await MainActor.run { visibleAgentId }
        if let pane, let visible, visible.hasSuffix("|\(pane)") { return [] }
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let pane = info["pane"] as? String else { return }
        let fp = info["fp"] as? String ?? ""
        switch response.actionIdentifier {
        case UNNotificationDefaultActionIdentifier, Self.openAction:
            await MainActor.run { openRequest = (fp, pane) }
        case UNNotificationDismissActionIdentifier:
            break
        default:
            await answer(response)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    /// Also runs for background launches (notification answers, Live Activity tokens): the delegate and
    /// the categories must be in place before any UI exists.
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated {
            UNUserNotificationCenter.current().delegate = PushManager.shared
            PushManager.registerCategories()
            LiveActivities.start()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushManager.shared.didRegister(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        HollrLog.error("push: \(error)")
        Task { @MainActor in PushManager.shared.lastResult = "Registrierung fehlgeschlagen: \(error.localizedDescription)" }
    }
}

/// Settings → Mitteilungen
struct PushSettingsView: View {
    @Environment(ServerStore.self) private var store
    @State private var push = PushManager.shared
    @State private var testing = false
    @State private var importing = false
    @State private var pendingURL: URL?
    @State private var keyId = ""
    @State private var teamId = PushKey.buildTeam
    @State private var keyError: String?

    private func saveKey() async {
        guard let url = pendingURL else { return }
        do {
            try await push.importKey(from: url, keyId: keyId, teamId: teamId)
            pendingURL = nil
            keyError = nil
        } catch {
            keyError = error.localizedDescription
        }
    }

    var body: some View {
        List {
            Group {
            Section {
                Toggle("Mitteilungen", isOn: Binding(get: { push.enabled }, set: { on in Task { await push.setEnabled(on) } }))
                if push.authorized == .denied {
                    Button("In den iOS-Einstellungen erlauben") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            } footer: {
                Text("Dein Server meldet sich direkt über Apple, wenn ein Agent auf dich wartet, fertig ist oder mit einem Fehler stoppt.")
            }
            if push.enabled {
                Section("Melden, wenn …") {
                    ForEach(PushManager.Kind.allCases) { kind in
                        Toggle(kind.title, isOn: Binding(get: { push.wants(kind) }, set: { push.set(kind, $0) }))
                    }
                }
                Section {
                    ForEach(store.servers) { server in
                        LabeledContent(server.label) {
                            switch push.serverReady[server.id] {
                            case true?: Label("bereit", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.live)
                            case false?: Text("Schlüssel fehlt").foregroundStyle(Theme.warn)
                            case nil: Text(push.token == nil ? String(localized: "warte auf iOS") : String(localized: "…")).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button {
                        testing = true
                        Task { await push.sendTest(); testing = false }
                    } label: {
                        if testing { ProgressView() } else { Text("Test-Mitteilung senden") }
                    }
                    if let result = push.lastResult {
                        Text(result).font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Server")
                }
                Section {
                    Button { importing = true } label: {
                        Label(push.hasKey ? String(localized: "Anderen APNs-Schlüssel importieren …") : String(localized: "APNs-Schlüssel importieren (.p8) …"),
                              systemImage: "key.fill")
                    }
                    if pendingURL != nil {
                        TextField("Key-ID (10 Zeichen)", text: $keyId).textInputAutocapitalization(.characters).autocorrectionDisabled()
                        TextField("Team-ID", text: $teamId).textInputAutocapitalization(.characters).autocorrectionDisabled()
                        Button("Speichern und auf Server übertragen") { Task { await saveKey() } }
                            .disabled(keyId.count != 10 || teamId.count != 10)
                    }
                    if let keyError { Text(keyError).font(.footnote).foregroundStyle(Theme.warn) }
                } header: {
                    Text("Schlüssel")
                } footer: {
                    Text(push.hasKey
                         ? String(localized: "Der Schlüssel liegt im Schlüsselbund dieses iPhones. Neue Server bekommen ihn automatisch.")
                         : String(localized: "Einmal fürs Team: developer.apple.com → Keys → „+“ → Apple Push Notifications service. Die .p8 hier importieren – Hollr richtet damit alle Server ein."))
                }
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .fileImporter(isPresented: $importing, allowedContentTypes: [.data, .item]) { result in
            if case let .success(url) = result {
                pendingURL = url
                keyId = PushKey.keyId(fromFilename: url.lastPathComponent) ?? ""
                if teamId.isEmpty { teamId = PushKey.buildTeam }
            }
        }
        .navigationTitle("Mitteilungen")
        .task { await push.registerEverywhere() }
    }
}
