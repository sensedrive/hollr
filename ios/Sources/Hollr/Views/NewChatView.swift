import SwiftUI

/// Opens a plain terminal tab on the server – start omp, Claude Code, etc. inside it.
struct NewChatView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(\.dismiss) private var dismiss
    let onCreated: (Server, String) -> Void

    @State private var serverId: UUID?
    @State private var workspace: String = Self.home
    @State private var folder = ""
    @State private var label = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var field: Field?

    private enum Field { case folder, label }

    private static let newWorkspace = "__new__"
    private static let home = "__home__"

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
            Text(String(localized: "Öffnet ein Terminal. omp, Claude Code oder Codex startest du dort selbst."))
                .font(Typo.sm).foregroundStyle(Theme.dim)
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
                TextField("Tab-Name (optional)", text: $label, prompt: Text("Tab-Name (optional)").foregroundStyle(Theme.dim))
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
            ? String(localized: "Terminal im Home-Verzeichnis von \(server?.user ?? "dir"). Dort omp, Claude Code usw. starten.")
            : workspace == Self.newWorkspace
            ? String(localized: "Leer = Home-Verzeichnis. Ordner mit ~ werden auf dem Server aufgelöst.")
            : String(localized: "Neuer Tab in diesem Workspace – Agent startest du im Terminal.")
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
                let pane = try await HollrClient.newChat(server, kind: "shell", workspace: ws, cwd: ws == nil ? cwd : nil,
                                                         label: name.isEmpty ? String(localized: "Terminal") : name,
                                                         model: nil, level: nil)
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
