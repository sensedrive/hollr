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
    @State private var browsing = false
    @State private var repoId: String = ""
    @State private var branch = ""
    @State private var base = ""
    @State private var folder = "~/projects/"
    @State private var label = ""
    @State private var agent = "omp"
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case branch, base, folder, label }

    private var server: Server? { store.servers.first { $0.id == serverId } ?? store.servers.first }
    private var repos: [Space] {
        (server.map { herdr.spaces[$0.id] ?? [] } ?? []).filter { !$0.isWorktree && $0.git != nil }
    }

    var body: some View {
        DialogScaffold(icon: .folder, title: String(localized: "Neuer Space"), onClose: { dismiss() }) {
            Segmented(label: String(localized: "Art"),
                      options: [(value: Kind.worktree, title: String(localized: "Worktree")),
                                (value: Kind.folder, title: String(localized: "Ordner"))],
                      selection: $kind, boxed: true)

            if store.servers.count > 1 {
                DialogField(label: String(localized: "Server")) {
                    MenuField(title: server?.label ?? "",
                              options: store.servers.map { (value: Optional($0.id), title: $0.label) },
                              selection: Binding(get: { server?.id }, set: { serverId = $0 }))
                }
            }

            if kind == .worktree {
                DialogField(label: String(localized: "Repo")) {
                    MenuField(title: repos.first { $0.id == repoId }.map(repoTitle) ?? "",
                              options: repos.map { (value: $0.id, title: repoTitle($0)) },
                              selection: $repoId)
                }
                DialogField(label: String(localized: "Branch")) {
                    TextField("Neuer Branch, z. B. feature/PROJ-123-login", text: $branch)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .branch)
                        .font(Typo.mono)
                        .fieldStyle(focused: focus == .branch)
                }
                DialogField(label: String(localized: "Basis"),
                            note: String(localized: "herdr legt einen eigenen Arbeitsordner mit neuem Branch an – parallel zu main, ohne dass sich Agents in die Quere kommen.")) {
                    TextField("Basis (leer = aktueller Branch)", text: $base)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .base)
                        .font(Typo.mono)
                        .fieldStyle(focused: focus == .base)
                }
            } else {
                DialogField(label: String(localized: "Ordner auf dem Server"),
                            note: String(localized: "Wird angelegt, falls er noch nicht existiert.")) {
                    HStack(spacing: Gap.s) {
                        TextField("Ordner auf dem Server", text: $folder)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .focused($focus, equals: .folder)
                            .font(Typo.mono)
                            .fieldStyle(focused: focus == .folder)
                        Button { browsing = true } label: { Label("Durchsuchen …", icon: .folder) }
                            .buttonStyle(.hollr(.secondary))
                            .accessibilityLabel("Ordner auf dem Server durchsuchen")
                            .disabled(server == nil)
                    }
                }
            }

            DialogField(label: String(localized: "Name")) {
                TextField("Name (optional)", text: $label)
                    .focused($focus, equals: .label)
                    .fieldStyle(focused: focus == .label)
            }
            DialogField(label: String(localized: "Agent starten")) {
                MenuField(title: Self.agents.first { $0.value == agent }?.title ?? "",
                          options: Self.agents, selection: $agent)
            }
            if let error { Text(error).font(Typo.sm).foregroundStyle(Theme.warn) }
        } footer: {
            Button("Abbrechen") { dismiss() }
                .buttonStyle(.hollr(.secondary))
            Button(action: create) {
                if busy { Spinner(color: Theme.onAccent) } else { Text("Anlegen") }
            }
            .buttonStyle(.hollr(.primary))
            .disabled(!valid || busy)
        }
        .dialogSheet()
        .task {
            if let preselectedRepo { repoId = preselectedRepo.id }
            if repos.isEmpty { await herdr.refreshSpaces(store.servers) }
            if repoId.isEmpty { repoId = repos.first?.id ?? "" }
            if repos.isEmpty { kind = .folder }
        }
        .sheet(isPresented: $browsing) {
            if let server {
                FolderPicker(server: server, start: folder.hasSuffix("/") ? String(folder.dropLast()) : folder) { chosen in
                    folder = chosen
                    // name the space after the folder unless one was typed
                    if label.trimmingCharacters(in: .whitespaces).isEmpty {
                        label = chosen.split(separator: "/").last.map(String.init) ?? ""
                    }
                }
            }
        }
    }

    private static let agents: [(value: String, title: String)] = [
        ("omp", "omp"), ("claude", "Claude Code"), ("codex", "Codex"), ("", String(localized: "Keiner (Shell)")),
    ]

    private func repoTitle(_ repo: Space) -> String { "\(repo.label) (\(repo.git?.branch ?? "?"))" }

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
            .dialogSheet()
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
    /// the folder is gone: only closing is possible (older servers don't send it)
    let missing: Bool?
    /// worktree spaces that close with this repo's main space (herdr's group)
    let group: [Member]?

    struct Member: Decodable, Hashable {
        let ws: String
        let label: String
        let root: String
        let agents: Int
        let missing: Bool
    }
}

/// Close a space with all options: keep files, remove the worktree (with or without its branch,
/// locally and on origin) or delete a plain folder – showing first what would be lost. A repo's main
/// space closes together with its worktree spaces (listed first); a space whose folder is gone can only be closed.
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
    @FocusState private var confirmFocused: Bool

    var body: some View {
        DialogScaffold(icon: .trash, tone: .danger, title: String(localized: "„\(space.label)“ schließen"),
                       onClose: { dismiss() }) {
            facts
            VStack(alignment: .leading, spacing: Gap.s) {
                Text("Was soll passieren?").font(Typo.sm.weight(.semibold)).foregroundStyle(Theme.muted)
                choice(.close, String(localized: "Nur schließen"), String(localized: "Sitzungen beenden, Dateien und Branch bleiben."))
                if info?.isWorktree == true, info?.missing != true {
                    choice(.removeWorktree, String(localized: "Worktree entfernen"), String(localized: "Ordner wird gelöscht, der Branch bleibt."))
                    if let branch = info?.branch, info?.defaultBranch == false {
                        choice(.removeWorktreeAndBranch, String(localized: "Worktree und Branch löschen"), String(localized: "Ordner und Branch „\(branch)“ werden gelöscht."))
                    }
                }
                if info?.canDeleteFolder == true {
                    choice(.deleteFolder, String(localized: "Ordner komplett löschen"), String(localized: "Alles in \(info?.root ?? "") wird endgültig gelöscht."))
                } else if let info, !info.isWorktree, (info.linkedWorktrees ?? 0) > 0 {
                    Text("Ordner löschen ist gesperrt: \(info.linkedWorktrees ?? 0) Worktree(s) hängen an diesem Repo.")
                        .font(Typo.sm).foregroundStyle(Theme.dim)
                }
            }
            if option == .removeWorktreeAndBranch, info?.remoteBranch == true {
                toggleRow(String(localized: "Auch auf origin löschen"),
                          note: String(localized: "Löscht den Branch zusätzlich im entfernten Repository (z. B. GitHub)."),
                          isOn: $deleteRemote)
            }
            if (option == .removeWorktree || option == .removeWorktreeAndBranch), (info?.changed ?? 0) > 0 {
                toggleRow(String(localized: "Ungespeicherte Änderungen verwerfen"),
                          note: String(localized: "Ohne diesen Haken bricht das Entfernen ab, solange Änderungen offen sind."),
                          isOn: $discard)
            }
            if destructive {
                DialogField(label: String(localized: "Zur Bestätigung „\(space.label)“ eingeben")) {
                    TextField(space.label, text: $confirmText)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($confirmFocused)
                        .fieldStyle(focused: confirmFocused)
                }
            }
            if let error {
                Text(error).font(Typo.sm).foregroundStyle(Theme.warn)
            }
        } footer: {
            Button("Abbrechen") { dismiss() }
                .buttonStyle(.hollr(.secondary))
            Button { Task { await run() } } label: {
                if busy {
                    Spinner(color: Theme.red)
                } else {
                    Text(destructive ? String(localized: "Löschen")
                         : group.isEmpty ? String(localized: "Schließen") : String(localized: "\(group.count + 1) Spaces schließen"))
                }
            }
            .buttonStyle(.hollr(.danger))
            .disabled(busy || info == nil || (destructive && confirmText != space.label))
        }
        .toolbar(.hidden, for: .navigationBar)
        .task {
            info = try? await HollrClient.fs(server, ["op": "info", "ws": space.id], as: SpaceCloseInfo.self, command: "space")
        }
    }

    /// What hangs on the space (close__facts): folder, branch, open changes and commits, sessions.
    private var facts: some View {
        VStack(alignment: .leading, spacing: 6) {
            fact(.folder) { Text(info?.root ?? space.root).font(Typo.monoSmall).lineLimit(2) }
            if let branch = info?.branch {
                fact(.branch) { Text(branch).font(Typo.monoSmall) }
            }
            if let info {
                if info.changed > 0 {
                    NavigationLink { GitPanel(server: server, space: space, tab: .changes) } label: {
                        fact(.alert, tint: Theme.warn, link: true) {
                            Text("\(info.changed) ungespeicherte Änderung(en)")
                            Spacer(minLength: Gap.xs)
                            PlusMinus(add: info.add, del: info.del)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if info.unpushed > 0 {
                    NavigationLink { GitPanel(server: server, space: space, tab: .history) } label: {
                        fact(.alert, tint: Theme.warn, link: true) { Text("\(info.unpushed) Commit(s) nicht gepusht") }
                    }
                    .buttonStyle(.plain)
                }
                if info.agents > 0 {
                    fact(.message) { Text("\(info.agents) Sitzung(en) werden beendet") }
                }
                if info.missing == true {
                    fact(.alert, tint: Theme.warn) { Text("Der Ordner fehlt – der Space lässt sich nur noch schließen.") }
                }
                if !group.isEmpty {
                    Text("Schließt mit: \(group.count) Worktree-Space(s)").font(Typo.sm.weight(.semibold)).foregroundStyle(Theme.muted)
                    ForEach(group, id: \.ws) { g in
                        fact(.folder, tint: g.missing ? Theme.warn : Theme.fg) {
                            Text(g.label).lineLimit(1)
                            Spacer(minLength: Gap.xs)
                            Text(g.missing ? String(localized: "Ordner fehlt") : g.root).font(Typo.monoSmall).lineLimit(1)
                        }
                    }
                }
                if info.git {
                    NavigationLink { GitPanel(server: server, space: space, tab: .changes) } label: {
                        fact(.branch, tint: Theme.accent, link: true) { Text("Änderungen, Verlauf und Branches ansehen") }
                    }
                    .buttonStyle(.plain)
                }
            } else {
                Text("Prüfe Space …").redacted(reason: .placeholder)
            }
        }
        .font(Typo.note)
        .padding(.vertical, 10).padding(.horizontal, Gap.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.row, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
    }

    private func fact<Content: View>(_ icon: HIcon, tint: Color = Theme.fg, link: Bool = false,
                                     @ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: Gap.s) {
            IconView(icon, size: 14)
            content()
            if link {
                Spacer(minLength: Gap.xs)
                IconView(.chevronRight, size: 12).foregroundStyle(Theme.dim)
            }
        }
        .foregroundStyle(tint)
        .frame(minHeight: link ? Metric.touch : 0)
        .contentShape(Rectangle())
    }

    private var destructive: Bool { option != .close }
    private var group: [SpaceCloseInfo.Member] { info?.group ?? [] }

    private func choice(_ value: Option, _ title: String, _ detail: String) -> some View {
        Button { option = value } label: {
            ChoiceRow(selected: option == value) {
                Image(systemName: option == value ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(value == .close ? Theme.accent : Theme.red)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Typo.md).foregroundStyle(Theme.fg)
                    Text(detail).font(Typo.sm).foregroundStyle(Theme.muted)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func toggleRow(_ title: String, note: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Typo.md)
                Text(note).font(Typo.sm).foregroundStyle(Theme.dim)
            }
        }
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
        if !group.isEmpty { body["group"] = true }
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

/// A choice in a dialog as a field (dlg-input select): the current value with a chevron, a system menu to pick.
private struct MenuField<Value: Hashable>: View {
    let title: String
    let options: [(value: Value, title: String)]
    @Binding var selection: Value

    var body: some View {
        Menu {
            Picker(selection: $selection) {
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    Text(option.title).tag(option.value)
                }
            } label: { EmptyView() }
        } label: {
            HStack(spacing: Gap.s) {
                Text(title).foregroundStyle(Theme.fg).lineLimit(1)
                Spacer(minLength: Gap.s)
                Image(systemName: "chevron.up.chevron.down").font(Typo.xs).foregroundStyle(Theme.dim)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .fieldStyle()
            .contentShape(Rectangle())
        }
    }
}
