import SwiftUI

/// Open a new session (organism NewSessionDialog): server, agent (omp / Claude / ChatGPT-Codex) or a plain
/// terminal, model, and where it runs.
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
    @State private var pickModel = false
    @FocusState private var field: Field?

    private enum Field { case folder, label }

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
        DialogScaffold(icon: .plus, title: String(localized: "Neue Sitzung"), onClose: { dismiss() }) {
            if store.servers.count > 1 {
                DialogField(label: String(localized: "Server")) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Segmented(label: String(localized: "Server"),
                                  options: store.servers.map { (value: Optional($0.id), title: $0.label) },
                                  selection: Binding(get: { server?.id }, set: { serverId = $0 }),
                                  boxed: true)
                    }
                }
            }
            DialogField(label: String(localized: "Was")) {
                VStack(spacing: 6) {
                    ForEach(Self.agents, id: \.kind) { agent in kindRow(agent) }
                }
            }
            if kind != "shell", server != nil {
                DialogField(label: String(localized: "Modell"),
                            note: String(localized: "Mit Suche, zuletzt genutzten Modellen und \(kind == "omp" ? "Thinking" : "Effort")-Stufe.")) {
                    Button { pickModel = true } label: {
                        Label([model ?? String(localized: "Standard"), level].compactMap { $0 }.joined(separator: " · "), icon: .cpu)
                            .truncationMode(.middle)
                    }
                    .buttonStyle(.hollr())
                    .accessibilityLabel("Modell")
                    .accessibilityValue([model ?? String(localized: "Standard"), level].compactMap { $0 }.joined(separator: " · "))
                }
            }
            DialogField(label: String(localized: "Wo"), note: whereNote) {
                Menu {
                    Picker("Workspace", selection: $workspace) {
                        Text("Kein Projekt (Home)").tag(Self.home)
                        Text("Neuer Workspace").tag(Self.newWorkspace)
                        ForEach(server.map { herdr.trees[$0.id] ?? [] } ?? []) { ws in
                            Text(ws.label).tag(ws.id)
                        }
                    }
                } label: {
                    HStack(spacing: Gap.s) {
                        Text(workspaceTitle).foregroundStyle(Theme.fg).lineLimit(1)
                        Spacer(minLength: Gap.s)
                        IconView(.chevronDown, size: 13).foregroundStyle(Theme.dim)
                    }
                    .fieldStyle()
                    .contentShape(Rectangle())
                }
                .accessibilityLabel("Workspace")
                .accessibilityValue(workspaceTitle)
                if workspace == Self.newWorkspace {
                    TextField("Ordner auf dem Server, z. B. ~/projects/my-app", text: $folder,
                              prompt: Text("Ordner auf dem Server, z. B. ~/projects/my-app").foregroundStyle(Theme.dim))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($field, equals: .folder)
                        .fieldStyle(focused: field == .folder)
                        .font(Typo.mono)
                }
                TextField("Name (optional)", text: $label, prompt: Text("Name (optional)").foregroundStyle(Theme.dim))
                    .focused($field, equals: .label)
                    .fieldStyle(focused: field == .label)
            }
            if let error {
                Label(error, icon: .alert).font(Typo.sm).foregroundStyle(Theme.warn)
            }
        } footer: {
            Button("Abbrechen") { dismiss() }.buttonStyle(.hollr())
            Button(action: create) {
                HStack(spacing: 6) {
                    if busy { Spinner(color: Theme.onAccent, size: 13) }
                    Text("Öffnen")
                }
            }
            .buttonStyle(.hollr(.primary))
            .disabled(busy)
        }
        .dialogSheet()
        .onChange(of: kind) { _, _ in model = nil; level = nil }
        .sheet(isPresented: $pickModel) {
            if let server {
                ModelPicker(server: server, kind: kind, model: $model, level: $level)
                    .dialogSheet()
                    .presentationDetents([.large])
            }
        }
        .task(id: server?.id) {
            guard let server else { return }
            installed = (try? await HollrClient.kinds(server)) ?? []
            if !installed.isEmpty, !installed.contains(kind) { kind = installed[0] }
        }
    }

    /// One agent to choose (nsd__kind): badge, name, note – or install it when it is missing.
    private func kindRow(_ agent: (kind: String, name: String, note: String)) -> some View {
        let available = installed.isEmpty || installed.contains(agent.kind)
        return Button {
            kind = agent.kind
        } label: {
            ChoiceRow(selected: kind == agent.kind && available) {
                AgentBadge(agent: agent.kind == "shell" ? nil : agent.kind)
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.name).font(Typo.md).foregroundStyle(available ? Theme.fg : Theme.muted)
                    Text(available ? agent.note : installing == agent.kind ? String(localized: "wird installiert …") : String(localized: "auf \(server?.label ?? "dem Server") nicht installiert"))
                        .font(Typo.sm).foregroundStyle(Theme.dim)
                }
                Spacer(minLength: Gap.s)
                if kind == agent.kind && available { IconView(.check, size: 14).foregroundStyle(Theme.accent) }
                if !available {
                    if installing == agent.kind {
                        Spinner(color: Theme.accent)
                    } else {
                        Button("Installieren") { install(agent.kind) }
                            .buttonStyle(.hollr(small: true))
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!available && installing != nil)
    }

    private var workspaceTitle: String {
        switch workspace {
        case Self.home: return String(localized: "Kein Projekt (Home)")
        case Self.newWorkspace: return String(localized: "Neuer Workspace")
        default:
            guard let server else { return workspace }
            return herdr.trees[server.id]?.first { ws in ws.id == workspace }?.label ?? workspace
        }
    }

    private var whereNote: String {
        workspace == Self.home
            ? String(localized: "Startet im Home-Verzeichnis von \(server?.user ?? "dir") – ohne Projekt.")
            : workspace == Self.newWorkspace
            ? String(localized: "Leer = Home-Verzeichnis. Ordner mit ~ werden auf dem Server aufgelöst.")
            : String(localized: "Öffnet als neuer Tab im Ordner dieses Workspaces.")
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
