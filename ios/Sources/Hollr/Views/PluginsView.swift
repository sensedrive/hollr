import SwiftUI

extension HollrClient {
    struct PluginInfo: Decodable, Identifiable, Hashable {
        let id: String
        let name: String
        let description: String?
        let version: String?
        /// gate commands the app relays for the plugin page (manifest `host.gate`)
        let host: Host?
        let error: String?

        struct Host: Decodable, Hashable { let gate: [String] }
    }

    /// A relayed gate call: any JSON answer, handed back to the plugin page as it came.
    static func pluginGate(_ server: Server, command: String, stdin: [String: Any]) async throws -> Any {
        try await fs(server, stdin, as: AnyJSON.self, command: command).value
    }

    /// Plugins linked on the server (`hollr plugin link`).
    static func plugins(_ server: Server) async throws -> [PluginInfo] {
        struct R: Decodable { let plugins: [PluginInfo] }
        return try await fs(server, ["op": "list"], as: R.self, command: "plugins").plugins
    }

    /// Starts the plugin's web UI on the server if needed; the URL carries the access token in its fragment.
    static func openPlugin(_ server: Server, id: String) async throws -> URL {
        struct R: Decodable { let port: Int; let url: String }
        let r = try await fs(server, ["op": "open", "id": id], as: R.self, command: "plugins", seconds: 20)
        guard let url = URL(string: r.url) else { throw HollrError.badResponse }
        return url
    }
}

typealias PluginInfo = HollrClient.PluginInfo

/// Any JSON value, for answers the app passes through without knowing their shape.
struct AnyJSON: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = NSNull() }
        else if let b = try? c.decode(Bool.self) { value = b }
        else if let n = try? c.decode(Double.self) { value = n }
        else if let s = try? c.decode(String.self) { value = s }
        else if let a = try? c.decode([AnyJSON].self) { value = a.map(\.value) }
        else { value = try c.decode([String: AnyJSON].self).mapValues(\.value) }
    }
}

/// A message from a plugin page to the app (host relay): validated here, the trust boundary, so it is tested.
enum PluginHostRequest: Equatable {
    case servers(id: String)
    case gate(id: String, server: String, command: String, stdin: [String: AnyHashable])
    case openSession(server: String, pane: String)
    /// a request with an id that can't be served – answered with an error so the page doesn't hang
    case reject(id: String, error: String)

    static func parse(_ body: Any, allowed: [String]) -> PluginHostRequest? {
        guard let m = body as? [String: Any], (m["hollr"] as? NSNumber)?.intValue == 1 else { return nil }
        func str(_ key: String, max: Int = 200) -> String? {
            guard let v = m[key] as? String, !v.isEmpty, v.count <= max else { return nil }
            return v
        }
        let type = m["type"] as? String
        if type == "open-session" {
            guard let server = str("server"), let pane = str("pane", max: 100) else { return nil }
            return .openSession(server: server, pane: pane)
        }
        guard let id = str("id", max: 100) else { return nil }
        if type == "servers" { return .servers(id: id) }
        guard type == "gate" else { return nil }
        guard let server = str("server"), let command = str("command", max: 40) else {
            return .reject(id: id, error: "Ungültige Anfrage")
        }
        guard allowed.contains(command) else {
            return .reject(id: id, error: "Gate-Befehl \(command) ist für dieses Plugin nicht freigegeben")
        }
        let raw = m["stdin"] ?? [String: Any]()
        guard let stdin = raw as? [String: Any], let hashable = stdin as? [String: AnyHashable] else {
            return .reject(id: id, error: "stdin muss ein Objekt sein")
        }
        return .gate(id: id, server: server, command: command, stdin: hashable)
    }
}

struct PluginRoute: Hashable {
    let server: Server
    let plugin: PluginInfo
}

/// The plugins of every paired server; a plugin opens its own web UI (PluginView).
struct PluginsView: View {
    @Environment(ServerStore.self) private var store
    @State private var loads: [Server.ID: Load] = [:]

    private enum Load {
        case loaded([PluginInfo])
        case tooOld
        case failed(String)
    }

    var body: some View {
        List {
            ForEach(store.servers) { server in
                Section {
                    rows(server)
                } header: {
                    SectionHeader(title: server.label, dot: dot(loads[server.id]))
                }
            }
        }
        .themedList()
        .navigationTitle("Plugins")
        .task { await reload() }
        .refreshable { await reload() }
    }

    @ViewBuilder private func rows(_ server: Server) -> some View {
        switch loads[server.id] {
        case nil:
            Text("Lade …").foregroundStyle(Theme.muted).listRowBackground(Theme.card)
        case .tooOld:
            FootNote(String(localized: "Hollr auf diesem Server ist zu alt für Plugins – in Werkzeuge aktualisieren."))
        case let .failed(message):
            FootNote(message)
        case let .loaded(plugins) where plugins.isEmpty:
            FootNote(String(localized: "Keine Plugins. Auf dem Server: hollr plugin link <ordner>"))
        case let .loaded(plugins):
            // ids unique in the whole List: the same plugin can be linked on several servers
            ForEach(plugins.map { PluginItem(id: "\(server.id.uuidString)|\($0.id)", plugin: $0) }) { item in
                if item.plugin.error == nil {
                    NavigationLink(value: PluginRoute(server: server, plugin: item.plugin)) { PluginRow(plugin: item.plugin) }
                        .listRowBackground(Theme.card)
                } else {
                    PluginRow(plugin: item.plugin).listRowBackground(Theme.card)
                }
            }
        }
    }

    private struct PluginItem: Identifiable {
        let id: String
        let plugin: PluginInfo
    }

    private func dot(_ load: Load?) -> Color {
        switch load {
        case nil: return Theme.dim
        case .loaded: return Theme.live
        case .tooOld, .failed: return Theme.red
        }
    }

    private func reload() async {
        await withTaskGroup(of: (Server.ID, Load).self) { group in
            for server in store.servers {
                group.addTask {
                    do {
                        return (server.id, .loaded(try await HollrClient.plugins(server)))
                    } catch HollrError.server("not_allowed") {
                        return (server.id, .tooOld)
                    } catch {
                        return (server.id, .failed(error.localizedDescription))
                    }
                }
            }
            for await (id, load) in group { loads[id] = load }
        }
    }
}

private struct PluginRow: View {
    let plugin: PluginInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(plugin.name).font(Typo.md).foregroundStyle(plugin.error == nil ? Theme.fg : Theme.dim)
            if let error = plugin.error {
                Text(error).font(Typo.sm).foregroundStyle(Theme.red)
            } else if let description = plugin.description {
                Text(description).font(Typo.sm).foregroundStyle(Theme.muted)
            }
        }
        .padding(.vertical, 2)
    }
}

/// A plugin's web UI, embedded through the SSH tunnel. Its URL carries a token: not kept in the recent list,
/// links to public pages open in Safari.
struct PluginView: View {
    let server: Server
    let plugin: PluginInfo
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @State private var model = BrowserModel(start: nil, remembers: false, popupsOutside: true, hostBridge: true)
    @State private var openError: String?
    @State private var opening = false

    var body: some View {
        Group {
            if let message = openError ?? model.error {
                EmptyState(icon: .alert, title: String(localized: "Plugin nicht erreichbar"), text: message) {
                    Button(String(localized: "Erneut versuchen")) { Task { await open() } }
                        .buttonStyle(.hollr(.primary, small: true))
                }
                .frame(maxHeight: .infinity)
            } else {
                WebViewHost(model: model)
            }
        }
        .themedPage()
        .navigationTitle(plugin.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await open() } } label: {
                    if opening { Spinner(color: Theme.muted, size: 16) } else { Image(.refresh) }
                }
                .buttonStyle(.icon())
                .disabled(opening)
                .accessibilityLabel("Neu laden")
            }
        }
        .task {
            model.onHostMessage = { body in handleHost(body) }
            model.configure(servers: [server])
            await open()
        }
    }

    /// Host relay (contract B): servers, allowlisted gate calls (in parallel, answered by id), opening a session.
    private func handleHost(_ body: Any) {
        guard let request = PluginHostRequest.parse(body, allowed: plugin.host?.gate ?? []) else { return }
        let model = model
        func reply(_ id: String, _ result: Result<Any, Error>) {
            switch result {
            case let .success(data): model.replyToHost(["hollr": 1, "id": id, "ok": true, "data": data])
            case let .failure(error): model.replyToHost(["hollr": 1, "id": id, "ok": false, "error": error.localizedDescription])
            }
        }
        switch request {
        case let .openSession(serverId, pane):
            guard let target = store.servers.first(where: { $0.id.uuidString == serverId }) else { return }
            PushManager.shared.openRequest = (target.hostFingerprint, pane)
        case let .reject(id, error):
            model.replyToHost(["hollr": 1, "id": id, "ok": false, "error": error])
        case let .servers(id):
            let list: [[String: Any]] = store.servers.map {
                ["id": $0.id.uuidString, "label": $0.label, "self": $0.id == server.id, "online": herdr.errors[$0.id] == nil]
            }
            reply(id, .success(list))
        case let .gate(id, serverId, command, stdin):
            guard let target = store.servers.first(where: { $0.id.uuidString == serverId }) else {
                return model.replyToHost(["hollr": 1, "id": id, "ok": false, "error": "Unbekannter Server"])
            }
            Task {
                do {
                    reply(id, .success(try await HollrClient.pluginGate(target, command: command, stdin: stdin)))
                } catch {
                    reply(id, .failure(error))
                }
            }
        }
    }

    private func open() async {
        opening = true
        defer { opening = false }
        openError = nil
        do {
            model.open(try await HollrClient.openPlugin(server, id: plugin.id))
        } catch {
            openError = error.localizedDescription
        }
    }
}
