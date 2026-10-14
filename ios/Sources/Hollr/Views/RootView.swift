import SwiftUI
#if DEBUG
import WhisperKit
#endif

struct RootView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions
    @Environment(\.scenePhase) private var scenePhase
    @Binding var pairing: PairingRequest?
    @State private var tab: RootTab = .home
    @State private var sheetAgent: String?
    @State private var spacesPath = NavigationPath()
    @State private var agentPath: [String] = []
    @State private var newChat = false
    @Environment(MySessions.self) private var mySessions

    enum RootTab { case home, spaces, agents, settings }

    var body: some View {
        Group {
            if store.servers.isEmpty {
                WelcomeView { pairing = PairingRequest() }
            } else {
                TabView(selection: $tab) {
                    NavigationStack {
                        DashboardView(onPair: { pairing = PairingRequest() }, onNew: { newChat = true }, sheetAgent: $sheetAgent)
                    }
                    .safeAreaInset(edge: .bottom) { LiveBar(path: $agentPath, tab: $tab) }
                    .tabItem { Label("Übersicht", systemImage: "square.grid.2x2") }
                    .tag(RootTab.home)

                    NavigationStack(path: $spacesPath) {
                        SpacesView()
                            .navigationDestination(for: String.self) { id in AgentDetailView(agentId: id, path: .constant([id])) }
                    }
                    .tabItem { Label("Spaces", systemImage: "square.stack.3d.up") }
                    .tag(RootTab.spaces)

                    NavigationStack(path: $agentPath) {
                        AgentListView(onNewChat: { newChat = true })
                            .navigationDestination(for: String.self) { id in AgentDetailView(agentId: id, path: $agentPath) }
                    }
                    .safeAreaInset(edge: .bottom) { LiveBar(path: $agentPath, tab: $tab) }
                    .tabItem { Label("Agents", systemImage: "waveform.circle") }
                    .tag(RootTab.agents)

                    NavigationStack { SettingsView(onPair: { pairing = PairingRequest() }) }
                        .tabItem { Label("Einstellungen", systemImage: "gearshape") }
                        .tag(RootTab.settings)
                }
                // tapped push notification → open that agent
                .onChange(of: PushManager.shared.openRequest?.pane) { _, pane in
                    guard let pane, let request = PushManager.shared.openRequest else { return }
                    PushManager.shared.openRequest = nil
                    let server = store.servers.first { $0.hostFingerprint == request.fp } ?? store.servers.first
                    if let server { sheetAgent = "\(server.id.uuidString)|\(pane)" }
                }
                .task { PushManager.shared.start(servers: store.servers) }
                .onChange(of: store.servers) { _, servers in
                    PushManager.shared.updateServers(servers)
                    herdr.startFeeds(servers)
                }
                .sheet(item: Binding(get: { sheetAgent.map(SheetID.init) }, set: { sheetAgent = $0?.id })) { item in
                    AgentSheet(agentId: item.id)
                        .presentationDetents([.fraction(0.82), .large])
                        .presentationDragIndicator(.visible)
                        .presentationBackground(Theme.bg)
                }
            }
        }
        .sheet(isPresented: $newChat) {
            NewChatView { server, pane in
                // new sessions open as sheet over the dashboard, like tapping a card
                let id = "\(server.id.uuidString)|\(pane)"
                mySessions.touch(id)
                tab = .home
                Task {
                    try? await Task.sleep(for: .milliseconds(450))
                    sheetAgent = id
                }
            }
        }
        .sheet(item: $pairing) { request in
            PairView(initialLink: request.link) { pairing = nil }
                .environment(store)
        }
        .task(id: scenePhase) {
            // keep herdr state fresh while the app is in the foreground: the live feed pushes
            // changes; polling stays as a slow safety net (fast only while a feed is down)
            guard scenePhase == .active else {
                herdr.stopFeeds()
                return
            }
            herdr.startFeeds(store.servers)
            while scenePhase == .active, !Task.isCancelled {
                await herdr.refresh(store.servers)
                let allLive = store.servers.allSatisfy { herdr.live.contains($0.id) }
                try? await Task.sleep(for: .seconds(allLive ? 30 : 5))
            }
        }
        #if DEBUG
        .task {
            let d = UserDefaults.standard
            switch d.string(forKey: "hollrTab") {
            case "settings", "speech": tab = .settings
            case "spaces": tab = .spaces
            case "agents": tab = .agents
            default: break
            }
            if d.string(forKey: "hollrOpen") != nil || d.string(forKey: "hollrLive") != nil { tab = .agents }
            if d.bool(forKey: "hollrSpaceTest"), let server = store.servers.first {
                do {
                    let created = try await HollrClient.space(server, ["op": "create", "cwd": "/tmp/hollr-apptest", "label": "App Test", "agent": "omp"])
                    await herdr.refreshSpaces(store.servers)
                    let listed = herdr.spaces[server.id]?.contains { $0.id == created.ws } ?? false
                    HollrLog.info("space-test: created \(created.ws ?? "-") pane \(created.pane ?? "-") listed=\(listed)")
                    try await Task.sleep(for: .seconds(3))
                    try await HollrClient.space(server, ["op": "close", "ws": created.ws ?? ""])
                    await herdr.refreshSpaces(store.servers)
                    let still = herdr.spaces[server.id]?.contains { $0.id == created.ws } ?? false
                    HollrLog.info("space-test: closed, still listed=\(still)")
                } catch {
                    HollrLog.error("space-test: \(error)")
                }
            }
            if let ws = d.string(forKey: "hollrSpace"), let server = store.servers.first {
                tab = .spaces
                await herdr.refreshSpaces(store.servers)
                if let space = herdr.spaces[server.id]?.first(where: { $0.id == ws }) {
                    spacesPath.append(SpaceRoute(server: server, space: space))
                }
            }
            if let pane = d.string(forKey: "hollrSheetPane"), let server = store.servers.first {
                try? await Task.sleep(for: .seconds(2))
                sheetAgent = "\(server.id.uuidString)|\(pane)"
            }
            if d.string(forKey: "hollrSheet") == "newchat" { newChat = true }
            if d.string(forKey: "hollrSheet") == "pair" { pairing = PairingRequest() }
            if let clip = d.string(forKey: "hollrDictate") {
                let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(clip)
                let settings = DictationSettings()
                if let engine = d.string(forKey: "hollrEngine").flatMap(DictationSettings.Engine.init(rawValue:)) { settings.engine = engine }
                if let lang = d.string(forKey: "hollrLang") { settings.language = lang }
                if let model = d.string(forKey: "hollrModel") {
                    if settings.engine == .whisper { settings.whisperModel = model } else { settings.parakeetModel = model }
                }
                if settings.engine == .parakeet, !ParakeetCache.isDownloaded(settings.parakeetModel) {
                    HollrLog.info("dictate-test: downloading parakeet \(settings.parakeetModel)")
                    do {
                        try await ParakeetCache.shared.download(model: settings.parakeetModel, boost: settings.parakeetBoost) { _ in }
                    } catch { HollrLog.error("dictate-test: parakeet download failed \(error)") }
                }
                if settings.engine == .whisper, !settings.whisperReady {
                    HollrLog.info("dictate-test: downloading \(settings.whisperModel)")
                    do {
                        let folder = try await WhisperKit.download(variant: settings.whisperModel, downloadBase: ModelManager.whisperBase)
                        settings.downloaded[settings.whisperModel] = folder.path
                        HollrLog.info("dictate-test: model at \(folder.path)")
                    } catch {
                        HollrLog.error("dictate-test: download failed \(error)")
                    }
                }
                let started = Date()
                let terms = d.string(forKey: "hollrTerms")?.split(separator: ",").map(String.init) ?? []
                let text = await Dictator().testWithFile(url, settings: settings, context: DictationContext(terms: terms))
                HollrLog.info("dictate-test (\(settings.engine.rawValue)): \"\(text)\" in \(Int(Date().timeIntervalSince(started)))s")
            }
            await DebugLaunch.run(store: store, herdr: herdr, sessions: sessions, pairing: $pairing, path: $agentPath)
        }
        #endif
    }
}

#if DEBUG
/// Test hooks for simulator/device runs (not in release builds):
///   -hollrPair <hollr://pair?c=…>   pair without the system "open in" dialog
///   -hollrOpen <pane>               open this agent (first server)
///   -hollrLive <pane>               open it and start live
///   -hollrClip <file.wav>           feed this file (app Documents) instead of the mic
///   -hollrScript "mute@20,unmute@25,leave@30,back@40,stop@50"   timed UI actions (seconds)
enum DebugLaunch {
    @MainActor
    static func run(store: ServerStore, herdr: HerdrStore, sessions: SessionStore,
                    pairing: Binding<PairingRequest?>, path: Binding<[String]>) async {
        let defaults = UserDefaults.standard
        if let link = defaults.string(forKey: "hollrPair") {
            pairing.wrappedValue = PairingRequest(link: link)
            return
        }
        guard let pane = defaults.string(forKey: "hollrLive") ?? defaults.string(forKey: "hollrOpen"),
              let server = store.servers.first else { return }
        await herdr.refresh(store.servers)
        guard let ref = herdr.agents(on: server).first(where: { $0.pane.pane == pane }) else { return }
        path.wrappedValue = [ref.id]
        guard let script = defaults.string(forKey: "hollrScript") else { return }
        let start = Date()
        for step in script.split(separator: ",") {
            let parts = step.split(separator: "@")
            guard parts.count == 2, let at = Double(parts[1]) else { continue }
            let wait = at - Date().timeIntervalSince(start)
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            let session = sessions.session(for: ref)
            HollrLog.info("script: \(parts[0]) (phase \(session.phase), omp \(session.ompState ?? "-"), items \(session.items.count))")
            switch parts[0] {
            case "mute", "unmute": session.toggleMute()
            case "leave": path.wrappedValue = []
            case "back": path.wrappedValue = [ref.id]
            case "stop": session.stop()
            case "new":
                if let pane = try? await HollrClient.newChat(server, kind: "omp", workspace: ref.pane.pane.components(separatedBy: ":").first,
                                                              cwd: nil, label: "Hollr Testchat") {
                    await herdr.refresh(store.servers)
                    path.wrappedValue = ["\(server.id.uuidString)|\(pane)"]
                    HollrLog.info("script: new chat \(pane)")
                }
            case "closechat":
                if let id = path.wrappedValue.last, let pane = id.split(separator: "|").last {
                    try? await HollrClient.close(server, pane: String(pane))
                    path.wrappedValue = []
                    await herdr.refresh(store.servers)
                    HollrLog.info("script: closed \(pane), still listed: \(herdr.agents(on: server).contains { $0.pane.pane == String(pane) })")
                }
            case "type": session.sendText(defaults.string(forKey: "hollrTypeText") ?? "Antworte nur mit dem Wort OK.")
            default: break
            }
        }
    }
}
#endif

struct SheetID: Identifiable {
    let id: String
}

/// An agent opened from the dashboard, shown as a bottom sheet (Moshi-style).
struct AgentSheet: View {
    let agentId: String
    @State private var path: [String] = []

    var body: some View {
        NavigationStack {
            AgentDetailView(agentId: path.last ?? agentId, path: $path)
        }
    }
}

struct PairingRequest: Identifiable {
    let id = UUID()
    var link: String?
}
