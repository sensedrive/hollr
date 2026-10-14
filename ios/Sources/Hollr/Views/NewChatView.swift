import SwiftUI

/// Open a new session: agent (omp / Claude / ChatGPT-Codex) or a plain terminal, and where it runs.
struct NewChatView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(\.dismiss) private var dismiss
    let onCreated: (Server, String) -> Void

    @State private var serverId: UUID?
    @State private var kind = "omp"
    @State private var installed: [String] = []
    @State private var workspace: String = Self.home
    @State private var folder = ""
    @State private var label = ""
    @State private var busy = false
    @State private var error: String?
    @State private var installing: String?
    @State private var model: String?
    @State private var level: String?

    private static let newWorkspace = "__new__"
    /// no project: a new workspace in the home directory
    private static let home = "__home__"

    static let agents: [(kind: String, name: String, note: String)] = [
        ("omp", "omp", String(localized: "Oh My Pi – mit Live-Sprachmodus")),
        ("claude", "Claude Code", "Text-Chat"),
        ("codex", "ChatGPT (Codex)", "Text-Chat"),
        ("shell", String(localized: "Terminal"), String(localized: "Shell ohne Agent")),
    ]

    private var server: Server? { store.servers.first { $0.id == serverId } ?? store.servers.first }

    var body: some View {
        NavigationStack {
            Form {
            Group {
                if store.servers.count > 1 {
                    Picker("Server", selection: Binding(get: { server?.id }, set: { serverId = $0 })) {
                        ForEach(store.servers) { Text($0.label).tag(Optional($0.id)) }
                    }
                }
                Section("Was") {
                    ForEach(Self.agents, id: \.kind) { agent in
                        let available = installed.isEmpty || installed.contains(agent.kind)
                        Button {
                            kind = agent.kind
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(agent.name).foregroundStyle(available ? .primary : .secondary)
                                    Text(available ? agent.note : installing == agent.kind ? String(localized: "wird installiert …") : String(localized: "auf \(server?.label ?? "dem Server") nicht installiert"))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if kind == agent.kind && available { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                                if !available {
                                    if installing == agent.kind {
                                        ProgressView()
                                    } else {
                                        Button("Installieren") { install(agent.kind) }
                                            .buttonStyle(.bordered).tint(Theme.accent).font(.subheadline)
                                    }
                                }
                            }
                        }
                        .disabled(!available && installing != nil)
                    }
                }
                if kind != "shell", let server {
                    Section {
                        NavigationLink {
                            ModelPicker(server: server, kind: kind, model: $model, level: $level)
                        } label: {
                            LabeledContent("Modell") {
                                Text([model ?? String(localized: "Standard"), level].compactMap { $0 }.joined(separator: " · "))
                                    .lineLimit(1).truncationMode(.middle)
                            }
                        }
                    } footer: {
                        Text("Mit Suche, zuletzt genutzten Modellen und \(kind == "omp" ? "Thinking" : "Effort")-Stufe.")
                    }
                    .onChange(of: kind) { _, _ in model = nil; level = nil }
                }
                Section {
                    Picker("Workspace", selection: $workspace) {
                        Text("Kein Projekt (Home)").tag(Self.home)
                        Text("Neuer Workspace").tag(Self.newWorkspace)
                        ForEach(server.map { herdr.trees[$0.id] ?? [] } ?? []) { ws in
                            Text(ws.label).tag(ws.id)
                        }
                    }
                    if workspace == Self.newWorkspace {
                        TextField("Ordner auf dem Server, z. B. ~/projects/my-app", text: $folder)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.system(.body, design: .monospaced))
                    }
                    TextField("Name (optional)", text: $label)
                } header: {
                    Text("Wo")
                } footer: {
                    Text(workspace == Self.home
                         ? String(localized: "Startet im Home-Verzeichnis von \(server?.user ?? "dir") – ohne Projekt.")
                         : workspace == Self.newWorkspace
                         ? String(localized: "Leer = Home-Verzeichnis. Ordner mit ~ werden auf dem Server aufgelöst.")
                         : String(localized: "Öffnet als neuer Tab im Ordner dieses Workspaces."))
                }
                if let error {
                    Section { Text(error).foregroundStyle(Theme.warn) }
                }
            }
            .listRowBackground(Theme.card)
        }.themedList()
            .navigationTitle("Neue Sitzung")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else { Button("Öffnen", action: create).bold() }
                }
            }
            .task(id: server?.id) {
                guard let server else { return }
                installed = (try? await HollrClient.kinds(server)) ?? []
                if !installed.isEmpty, !installed.contains(kind) { kind = installed[0] }
            }
        }
    }

    /// Installs a missing agent on the server, then selects it.
    private func install(_ agent: String) {
        guard let server else { return }
        installing = agent
        error = nil
        Task {
            do {
                _ = try await HollrClient.tools(server, run: agent)
                for _ in 0..<150 {
                    try await Task.sleep(for: .seconds(2))
                    let tool = try await HollrClient.tools(server).first { $0.name == agent }
                    if tool?.running == false {
                        if tool?.exit == 0 {
                            installed = (try? await HollrClient.kinds(server)) ?? installed
                            kind = agent
                        } else {
                            error = "Installation fehlgeschlagen: \(tool?.log?.split(separator: "\n").last.map(String.init) ?? "")"
                        }
                        break
                    }
                }
            } catch {
                self.error = error.localizedDescription
            }
            installing = nil
        }
    }

    private func create() {
        guard let server else { return }
        busy = true
        error = nil
        let ws = workspace == Self.newWorkspace || workspace == Self.home ? nil : workspace
        var cwd = workspace == Self.home ? "" : folder.trimmingCharacters(in: .whitespaces)
        if cwd.hasPrefix("~") { cwd = "/home/\(server.user)" + cwd.dropFirst() }
        if server.user == "root", cwd.hasPrefix("/home/root") { cwd = "/root" + cwd.dropFirst("/home/root".count) }
        let name = label.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                let pane = try await HollrClient.newChat(server, kind: kind, workspace: ws, cwd: ws == nil ? cwd : nil,
                                                         label: name.isEmpty ? (Self.agents.first { $0.kind == kind }?.name ?? kind) : name,
                                                         model: kind == "shell" ? nil : model, level: kind == "shell" ? nil : level)
                await herdr.refresh(store.servers)
                onCreated(server, pane)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
