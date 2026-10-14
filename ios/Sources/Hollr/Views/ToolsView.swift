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
            if let error { Text(error).foregroundStyle(Theme.warn) }
            if !pending.isEmpty {
                Button {
                    Task { for tool in pending { await run(tool.name) } }
                } label: {
                    Label(pending.count == 1 ? String(localized: "1 Werkzeug installieren/aktualisieren")
                          : String(localized: "\(pending.count) Werkzeuge installieren/aktualisieren"),
                          systemImage: "arrow.down.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            ForEach(tools) { tool in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tool.title)
                            versionLine(tool)
                        }
                        Spacer()
                        if tool.running {
                            ProgressView()
                        } else if !tool.installed {
                            Button("Installieren") { Task { await run(tool.name) } }
                                .buttonStyle(.borderedProminent)
                        } else if tool.updateAvailable == true {
                            Button("Aktualisieren") { Task { await run(tool.name) } }
                                .buttonStyle(.borderedProminent)
                        } else {
                            Menu {
                                Button("Trotzdem neu installieren") { Task { await run(tool.name) } }
                            } label: {
                                Label("Aktuell", systemImage: "checkmark.seal.fill").font(.subheadline)
                                    .foregroundStyle(Theme.live)
                            }
                        }
                    }
                    if let exit = tool.exit, !tool.running {
                        Label(exit == 0 ? "Fertig" : "Fehlgeschlagen (Exit \(exit))",
                              systemImage: exit == 0 ? "checkmark.circle.fill" : "xmark.octagon.fill")
                            .font(.caption).foregroundStyle(exit == 0 ? Theme.live : Theme.warn)
                    }
                    if let log = tool.log {
                        let open = tool.running || openLogs.contains(tool.name)
                        if open {
                            Text(log).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(tool.running ? 6 : 20)
                                .textSelection(.enabled)
                        }
                        if !tool.running {
                            Button(open ? "Protokoll ausblenden" : "Protokoll anzeigen") {
                                withAnimation(.snappy) {
                                    if open { openLogs.remove(tool.name) } else { openLogs.insert(tool.name) }
                                }
                            }
                            .font(.caption)
                            .buttonStyle(.borderless)
                        }
                    }
                }
                .padding(.vertical, 4)
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
                    if checking { ProgressView() } else { Image(systemName: "arrow.triangle.2.circlepath") }
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
                Image(systemName: "arrow.right").font(.caption2)
                Text(latest).foregroundStyle(Theme.accent)
            }
        }
        .font(.caption.monospaced()).foregroundStyle(.secondary)
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
