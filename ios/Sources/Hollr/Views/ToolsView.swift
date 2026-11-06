import SwiftUI

struct ServerTool: Decodable, Identifiable, Hashable {
    let name: String
    let title: String
    let version: String?
    let latest: String?
    let updateAvailable: Bool?
    let installed: Bool
    let running: Bool
    let exit: Int?
    let log: String?
    var id: String { name }
}

extension HollrClient {
    /// List tools, or start install/update of one (`hollr gate tools`).
    static func tools(_ server: Server, run name: String? = nil, check: Bool = false) async throws -> [ServerTool] {
        struct R: Decodable { let tools: [ServerTool] }
        var body: [String: Any] = check ? ["op": "check"] : [:]
        if let name { body = ["op": "run", "name": name] }
        body["lang"] = appLanguage
        return try await fs(server, body, as: R.self, command: "tools").tools
    }
}

/// Install / update herdr, omp, Claude Code, Codex and the Hollr server from the phone.
struct ToolsView: View {
    let server: Server
    @State private var tools: [ServerTool] = []
    @State private var error: String?
    @State private var openLogs: Set<String> = []
    @State private var checking = false

    var body: some View {
        List {
            Group {
            if let error {
                Label(error, icon: .alert).font(Typo.sm).foregroundStyle(Theme.warn)
            }
            if !pending.isEmpty {
                Button {
                    Task { for tool in pending { await run(tool.name) } }
                } label: {
                    Label(pending.count == 1 ? String(localized: "1 Werkzeug installieren/aktualisieren")
                          : String(localized: "\(pending.count) Werkzeuge installieren/aktualisieren"),
                          systemImage: "arrow.down.circle")
                }
                .buttonStyle(.hollr(.primary, fullWidth: true))
                .listRowBackground(Theme.bg)
                .listRowInsets(EdgeInsets())
            }
            ForEach(tools) { tool in
                VStack(alignment: .leading, spacing: Gap.s) {
                    HStack(spacing: Gap.m) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tool.title).font(Typo.md.weight(.semibold))
                            versionLine(tool)
                        }
                        Spacer()
                        if tool.running {
                            Spinner(color: Theme.work, size: 16)
                                .accessibilityLabel("Läuft")
                        } else if !tool.installed {
                            Button("Installieren") { Task { await run(tool.name) } }
                                .buttonStyle(.hollr(.primary, small: true))
                        } else if tool.updateAvailable == true {
                            Button("Aktualisieren") { Task { await run(tool.name) } }
                                .buttonStyle(.hollr(.primary, small: true))
                        } else {
                            Menu {
                                Button("Trotzdem neu installieren", systemImage: HIcon.refresh.symbol) { Task { await run(tool.name) } }
                            } label: {
                                Label("Aktuell", icon: .check)
                                    .font(Typo.note)
                                    .foregroundStyle(Theme.green)
                            }
                        }
                    }
                    if let exit = tool.exit, !tool.running {
                        Label(exit == 0 ? "Fertig" : "Fehlgeschlagen (Exit \(exit))", icon: exit == 0 ? .check : .alert)
                            .font(Typo.sm).foregroundStyle(exit == 0 ? Theme.green : Theme.red)
                    }
                    if let log = tool.log {
                        let open = tool.running || openLogs.contains(tool.name)
                        if open {
                            Text(log).font(Typo.monoXS).foregroundStyle(Theme.muted).lineLimit(tool.running ? 6 : 20)
                                .textSelection(.enabled)
                                .padding(.vertical, Gap.s).padding(.horizontal, 10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
                        }
                        if !tool.running {
                            Button(open ? "Protokoll ausblenden" : "Protokoll anzeigen") {
                                withAnimation(.snappy) {
                                    if open { openLogs.remove(tool.name) } else { openLogs.insert(tool.name) }
                                }
                            }
                            .buttonStyle(.hollr(.ghost, small: true))
                            .padding(.leading, -10)
                        }
                    }
                }
                .padding(.vertical, Gap.xs)
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task {
                        checking = true
                        tools = (try? await HollrClient.tools(server, check: true)) ?? tools
                        checking = false
                    }
                } label: {
                    if checking { Spinner(color: Theme.muted, size: 16) } else { Image(.refresh) }
                }
                .accessibilityLabel("Nach Updates suchen")
            }
        }
        .navigationTitle("Werkzeuge")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task {
            // poll while something is installing
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(tools.contains { $0.running } ? 2 : 15))
            }
        }
    }

    /// missing or outdated and not already running
    private var pending: [ServerTool] {
        tools.filter { !$0.running && (!$0.installed || $0.updateAvailable == true) }
    }

    @ViewBuilder private func versionLine(_ tool: ServerTool) -> some View {
        HStack(spacing: 4) {
            Text(tool.installed ? (tool.version ?? String(localized: "installiert")) : String(localized: "nicht installiert"))
            if let latest = tool.latest, tool.updateAvailable == true || !tool.installed {
                Image(systemName: "arrow.right").font(Typo.xs)
                Text(latest).foregroundStyle(Theme.accent)
            }
        }
        .font(Typo.monoSmall).foregroundStyle(Theme.muted)
    }

    private func load() async {
        do {
            tools = try await HollrClient.tools(server)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func run(_ name: String) async {
        do {
            tools = try await HollrClient.tools(server, run: name)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
