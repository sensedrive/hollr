import SwiftUI

extension HollrClient {
    struct PluginInfo: Decodable, Identifiable, Hashable {
        let id: String
        let name: String
        let description: String?
        let version: String?
        let error: String?
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
            ForEach(plugins) { plugin in
                if plugin.error == nil {
                    NavigationLink(value: PluginRoute(server: server, plugin: plugin)) { PluginRow(plugin: plugin) }
                        .listRowBackground(Theme.card)
                } else {
                    PluginRow(plugin: plugin).listRowBackground(Theme.card)
                }
            }
        }
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
    @State private var model = BrowserModel(start: nil, remembers: false, popupsOutside: true)
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
            model.configure(servers: [server])
            await open()
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
