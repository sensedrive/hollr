import SwiftUI

/// Create a herdr space: a folder, or a git worktree (new branch) of a repo space.
struct NewSpaceView: View {
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(\.dismiss) private var dismiss
    var preselectedRepo: Space?

    enum Kind: String, CaseIterable { case worktree, folder }

    @State private var kind: Kind = .worktree
    @State private var serverId: UUID?
    @State private var repoId: String = ""
    @State private var branch = ""
    @State private var base = ""
    @State private var folder = "~/projects/"
    @State private var label = ""
    @State private var agent = "omp"
    @State private var busy = false
    @State private var error: String?

    private var server: Server? { store.servers.first { $0.id == serverId } ?? store.servers.first }
    private var repos: [Space] {
        (server.map { herdr.spaces[$0.id] ?? [] } ?? []).filter { !$0.isWorktree && $0.git != nil }
    }

    var body: some View {
        NavigationStack {
            Form {
            Group {
                Picker("Art", selection: $kind) {
                    Text("Worktree").tag(Kind.worktree)
                    Text("Ordner").tag(Kind.folder)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)

                if store.servers.count > 1 {
                    Picker("Server", selection: Binding(get: { server?.id }, set: { serverId = $0 })) {
                        ForEach(store.servers) { Text($0.label).tag(Optional($0.id)) }
                    }
                }

                if kind == .worktree {
                    Section {
                        Picker("Repo", selection: $repoId) {
                            ForEach(repos) { Text("\($0.label) (\($0.git?.branch ?? "?"))").tag($0.id) }
                        }
                        TextField("Neuer Branch, z. B. feature/PROJ-123-login", text: $branch)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .font(.system(.body, design: .monospaced))
                        TextField("Basis (leer = aktueller Branch)", text: $base)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .font(.system(.body, design: .monospaced))
                    } header: {
                        Text("Git-Worktree")
                    } footer: {
                        Text("herdr legt einen eigenen Arbeitsordner mit neuem Branch an – parallel zu main, ohne dass sich Agents in die Quere kommen.")
                    }
                } else {
                    Section {
                        TextField("Ordner auf dem Server", text: $folder)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .font(.system(.body, design: .monospaced))
                    } header: {
                        Text("Ordner")
                    } footer: {
                        Text("Wird angelegt, falls er noch nicht existiert.")
                    }
                }

                Section("Space") {
                    TextField("Name (optional)", text: $label)
                    Picker("Agent starten", selection: $agent) {
                        Text("omp").tag("omp")
                        Text("Claude Code").tag("claude")
                        Text("Codex").tag("codex")
                        Text("Keiner (Shell)").tag("")
                    }
                }
                if let error { Section { Text(error).foregroundStyle(Theme.warn) } }
            }
            .listRowBackground(Theme.card)
        }.themedList()
            .navigationTitle("Neuer Space")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else { Button("Anlegen", action: create).bold().disabled(!valid) }
                }
            }
            .task {
                if let preselectedRepo { repoId = preselectedRepo.id }
                if repos.isEmpty { await herdr.refreshSpaces(store.servers) }
                if repoId.isEmpty { repoId = repos.first?.id ?? "" }
                if repos.isEmpty { kind = .folder }
            }
        }
    }

    private var valid: Bool {
        kind == .folder ? !folder.trimmingCharacters(in: .whitespaces).isEmpty
            : !repoId.isEmpty && !branch.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func create() {
        guard let server else { return }
        busy = true
        error = nil
        var body: [String: Any] = ["label": label, "agent": agent]
        if kind == .worktree {
            body["op"] = "worktree"
            body["ws"] = repoId
            body["branch"] = branch.trimmingCharacters(in: .whitespaces)
            if !base.trimmingCharacters(in: .whitespaces).isEmpty { body["base"] = base.trimmingCharacters(in: .whitespaces) }
        } else {
            body["op"] = "create"
            body["cwd"] = folder.trimmingCharacters(in: .whitespaces)
        }
        Task {
            do {
                try await HollrClient.space(server, body)
                await herdr.refreshSpaces(store.servers)
                await herdr.refresh(store.servers)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

/// Close a space (worktrees can also be deleted from disk).
struct CloseSpaceModifier: ViewModifier {
    let server: Server
    @Binding var space: Space?
    var onClosed: () -> Void = {}

    func body(content: Content) -> some View {
        content.sheet(item: $space) { space in
            NavigationStack {
                CloseSpaceSheet(server: server, space: space) {
                    self.space = nil
                    onClosed()
                }
            }
            .presentationDetents([.large])
        }
    }
}

private struct SpaceCloseInfo: Decodable {
    let root: String
    let isWorktree: Bool
    let git: Bool
    let branch: String?
    let changed: Int
    let add: Int
    let del: Int
    let unpushed: Int
    let remoteBranch: Bool
    let defaultBranch: Bool
    let agents: Int
    let linkedWorktrees: Int?
    let canDeleteFolder: Bool
}

/// Close a space with all options: keep files, remove the worktree (with or without its branch,
/// locally and on origin) or delete a plain folder – showing first what would be lost.
struct CloseSpaceSheet: View {
    enum Option: Hashable { case close, removeWorktree, removeWorktreeAndBranch, deleteFolder }

    let server: Server
    let space: Space
    let onDone: () -> Void
    @Environment(HerdrStore.self) private var herdr
    @Environment(ServerStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var info: SpaceCloseInfo?
    @State private var option: Option = .close
    @State private var deleteRemote = false
    @State private var discard = false
    @State private var confirmText = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Group {
                Section {
                    LabeledContent("Ordner") { Text(info?.root ?? space.root).font(.caption.monospaced()).lineLimit(2) }
                    if let branch = info?.branch {
                        LabeledContent("Branch") { Text(branch).font(.caption.monospaced()) }
                    }
                    if let info {
                        if info.changed > 0 {
                            NavigationLink { GitPanel(server: server, space: space, showAgents: false, tab: .changes) } label: {
                                HStack {
                                    Label("\(info.changed) ungespeicherte Änderung(en)", systemImage: "exclamationmark.triangle.fill")
                                        .foregroundStyle(Theme.warn)
                                    Spacer()
                                    PlusMinus(add: info.add, del: info.del)
                                }
                            }
                        }
                        if info.unpushed > 0 {
                            NavigationLink { GitPanel(server: server, space: space, showAgents: false, tab: .history) } label: {
                                Label("\(info.unpushed) Commit(s) nicht gepusht", systemImage: "arrow.up.circle.fill")
                                    .foregroundStyle(Theme.warn)
                            }
                        }
                        if info.agents > 0 {
                            Label("\(info.agents) Sitzung(en) werden beendet", systemImage: "waveform").foregroundStyle(.secondary)
                        }
                        if info.git {
                            NavigationLink { GitPanel(server: server, space: space, showAgents: false, tab: .changes) } label: {
                                Label("Änderungen, Verlauf und Branches ansehen", systemImage: "arrow.triangle.branch")
                            }
                        }
                    } else {
                        Text("Prüfe Space …").redacted(reason: .placeholder)
                    }
                }
                Section("Was soll passieren?") {
                    choice(.close, String(localized: "Nur schließen"), String(localized: "Sitzungen beenden, Dateien und Branch bleiben."))
                    if info?.isWorktree == true {
                        choice(.removeWorktree, String(localized: "Worktree entfernen"), String(localized: "Ordner wird gelöscht, der Branch bleibt."))
                        if let branch = info?.branch, info?.defaultBranch == false {
                            choice(.removeWorktreeAndBranch, String(localized: "Worktree und Branch löschen"), String(localized: "Ordner und Branch „\(branch)“ werden gelöscht."))
                        }
                    }
                    if info?.canDeleteFolder == true {
                        choice(.deleteFolder, String(localized: "Ordner komplett löschen"), String(localized: "Alles in \(info?.root ?? "") wird endgültig gelöscht."))
                    } else if let info, !info.isWorktree, (info.linkedWorktrees ?? 0) > 0 {
                        Text("Ordner löschen ist gesperrt: \(info.linkedWorktrees ?? 0) Worktree(s) hängen an diesem Repo.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if option == .removeWorktreeAndBranch, info?.remoteBranch == true {
                    Section {
                        Toggle("Auch auf origin löschen", isOn: $deleteRemote)
                    } footer: {
                        Text("Löscht den Branch zusätzlich im entfernten Repository (z. B. GitHub).")
                    }
                }
                if (option == .removeWorktree || option == .removeWorktreeAndBranch), (info?.changed ?? 0) > 0 {
                    Section {
                        Toggle("Ungespeicherte Änderungen verwerfen", isOn: $discard)
                    } footer: {
                        Text("Ohne diesen Haken bricht das Entfernen ab, solange Änderungen offen sind.")
                    }
                }
                if destructive {
                    Section {
                        TextField(space.label, text: $confirmText)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    } header: {
                        Text("Zur Bestätigung „\(space.label)“ eingeben")
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(Theme.warn) }
                }
            }
            .listRowBackground(Theme.card)
        }
        .themedList()
        .navigationTitle("„\(space.label)“ schließen")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                if busy {
                    ProgressView()
                } else {
                    Button(destructive ? String(localized: "Löschen") : String(localized: "Schließen"), role: .destructive) { Task { await run() } }
                        .bold()
                        .disabled(info == nil || (destructive && confirmText != space.label))
                }
            }
        }
        .task {
            info = try? await HollrClient.fs(server, ["op": "info", "ws": space.id], as: SpaceCloseInfo.self, command: "space")
        }
    }

    private var destructive: Bool { option != .close }

    private func choice(_ value: Option, _ title: String, _ detail: String) -> some View {
        Button { option = value } label: {
            HStack(spacing: 12) {
                Image(systemName: option == value ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(value == .close ? Theme.accent : Omp.error)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(.primary)
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func run() async {
        busy = true
        error = nil
        defer { busy = false }
        var body: [String: Any] = ["op": "close", "ws": space.id]
        switch option {
        case .close: break
        case .removeWorktree:
            body["removeWorktree"] = true
        case .removeWorktreeAndBranch:
            body["removeWorktree"] = true
            body["deleteBranch"] = true
            body["deleteRemote"] = deleteRemote
        case .deleteFolder:
            body["deleteFolder"] = true
        }
        if discard { body["force"] = true }
        do {
            try await HollrClient.space(server, body)
            await herdr.refreshSpaces(store.servers)
            await herdr.refresh(store.servers)
            onDone()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
