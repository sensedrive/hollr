import SwiftUI
import UIKit

/// Repo browser of a space ("Git & Dateien"): files, uncommitted changes, history graph, branches.
/// A segmented control at the top switches between them, like the desktop git panel.
struct GitPanel: View {
    /// raw values are what the debug key `hollrSpaceTab` selects
    enum Tab: Int, CaseIterable {
        case files = 1, changes, history, branches
        var title: String {
            switch self {
            case .files: return String(localized: "Dateien")
            case .changes: return String(localized: "Änderungen")
            case .history: return String(localized: "Verlauf")
            case .branches: return "Branches"
            }
        }
    }

    let server: Server
    let space: Space
    @State var tab: Tab = .files

    var body: some View {
        Group {
            switch tab {
            case .files: FilesTab(server: server, space: space, path: "")
            case .changes: ChangesTab(server: server, space: space)
            case .history: HistoryTab(server: server, space: space)
            case .branches: BranchesTab(server: server, space: space)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .top, spacing: 0) { bar }
        .background(Theme.bg)
        .navigationTitle(space.label)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var bar: some View {
        let segmented = Segmented(label: String(localized: "Ansicht"),
                                  options: Tab.allCases.map { (value: $0, title: $0.title) },
                                  selection: $tab)
        return ViewThatFits(in: .horizontal) {
            segmented
            ScrollView(.horizontal, showsIndicators: false) { segmented }
        }
        .padding(.horizontal, Gap.l).padding(.vertical, Gap.s)
        .frame(maxWidth: .infinity)
        .background(Theme.bg)
    }
}

// MARK: - Files

struct FilesTab: View {
    let server: Server
    let space: Space
    let path: String
    @State private var entries: [DirEntry]?
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(Theme.warn).listRowBackground(Theme.card) }
            ForEach(entries ?? []) { entry in
                let full = path.isEmpty ? entry.name : "\(path)/\(entry.name)"
                NavigationLink {
                    if entry.dir {
                        FilesTab(server: server, space: space, path: full)
                    } else {
                        FileViewer(server: server, space: space, path: full)
                    }
                } label: {
                    row(entry)
                }
            }
            .listRowBackground(Theme.card)
        }
        .themedList()
        .overlay { if entries == nil && error == nil { Skeleton(style: .iconList, count: 14).background(Theme.bg) } }
        .navigationTitle(path.isEmpty ? space.label : (path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func row(_ entry: DirEntry) -> some View {
        let (symbol, color) = FileIcon.symbol(entry.name, dir: entry.dir)
        return HStack(spacing: Gap.m) {
            Image(systemName: symbol).font(Typo.md.weight(.medium)).foregroundStyle(color).frame(width: 22)
            Text(entry.name).font(Typo.md).lineLimit(1).truncationMode(.middle)
                .foregroundStyle(entry.name.hasPrefix(".") ? Theme.muted : Theme.fg)
            Spacer()
            if let mtime = entry.mtime, mtime > 0 {
                Text(GitStyle.age(mtime)).font(Typo.xs.monospacedDigit()).foregroundStyle(Theme.dim)
            }
        }
    }

    private func load() async {
        do {
            struct R: Decodable { let entries: [DirEntry] }
            entries = try await HollrClient.fs(server, ["op": "ls", "ws": space.id, "path": path], as: R.self).entries
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// File content with line numbers and syntax colors (Markdown rendered).
struct FileViewer: View {
    let server: Server
    let space: Space
    let path: String
    @State private var content: FileContent?
    @State private var error: String?
    @State private var rendered = true
    @AppStorage("diff.wrap") private var wrap = false

    var body: some View {
        Group {
            if let content {
                if content.binary {
                    EmptyState(icon: .file, title: String(localized: "Binärdatei"),
                               text: ByteCountFormatter.string(fromByteCount: Int64(content.size), countStyle: .file))
                } else if isMarkdown && rendered {
                    ScrollView { ScaledMarkdown(text: content.text).padding(Gap.l) }
                } else if wrap {
                    ScrollView { lines(content) }
                } else {
                    ScrollView([.vertical, .horizontal]) { lines(content) }
                }
            } else if let error {
                EmptyState(icon: .alert, title: String(localized: "Fehler"), text: error)
            } else {
                Skeleton(style: .code, count: 30)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isMarkdown {
                Button(rendered ? "Quelltext" : "Vorschau") { rendered.toggle() }
            } else {
                Button { wrap.toggle() } label: { Image(systemName: wrap ? "text.justify.left" : "arrow.turn.down.left") }
                    .accessibilityLabel(wrap ? "Nicht umbrechen" : "Zeilen umbrechen")
            }
        }
        .task {
            do {
                content = try await HollrClient.fs(server, ["op": "read", "ws": space.id, "path": path], as: FileContent.self)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func lines(_ content: FileContent) -> some View {
        let lang = Syntax.language(for: path)
        let all = content.text.split(separator: "\n", omittingEmptySubsequences: false)
        return LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(all.enumerated()), id: \.offset) { n, line in
                DiffLineRow(line: DiffLine(id: n, kind: .context, old: n + 1, new: n + 1, text: String(line)), lang: lang, wrap: wrap)
            }
            if content.truncated {
                Text("… gekürzt (\(ByteCountFormatter.string(fromByteCount: Int64(content.size), countStyle: .file)))")
                    .font(Typo.sm).foregroundStyle(Theme.muted).padding(Gap.l)
            }
        }
        .padding(.vertical, Gap.s)
        .padding(.bottom, Gap.xl)
        .textSelection(.enabled)
    }

    private var isMarkdown: Bool { path.lowercased().hasSuffix(".md") }
}

// MARK: - Changes

struct ChangesTab: View {
    let server: Server
    let space: Space
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions
    @State private var data: ChangesResponse?
    @State private var error: String?
    @State private var busy: String?
    @State private var confirmDiscard: FileChange?
    @State private var commenting: FileChange?
    @State private var comment = ""
    @State private var showCommit = false
    @State private var notice: String?

    /// the space's agent: comments and "write the commit message" go to it
    private var agent: AgentRef? {
        herdr.agents(on: server).first { $0.pane.pane.hasPrefix(space.id + ":") && $0.pane.agent != nil }
    }

    var body: some View {
        List {
            if let data {
                // meta line (space__meta): branch, counts, +/-
                HStack(spacing: 6) {
                    IconView(.branch, size: 13).foregroundStyle(Theme.muted)
                    Text(data.branch).font(Typo.monoSmall).lineLimit(1)
                    Text(summary(data)).font(Typo.sm).foregroundStyle(Theme.muted).lineLimit(1)
                    Spacer()
                    PlusMinus(add: (data.staged + data.unstaged).map(\.add).reduce(0, +),
                              del: (data.staged + data.unstaged).map(\.del).reduce(0, +))
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: Gap.xs, bottom: 0, trailing: Gap.xs))
            }
            if let error { Text(error).foregroundStyle(Theme.warn).listRowBackground(Theme.card) }
            if let data {
                if data.staged.isEmpty && data.unstaged.isEmpty {
                    Text("Alles committet.").foregroundStyle(Theme.muted).listRowBackground(Theme.card)
                }
                if !data.staged.isEmpty { section(String(localized: "Gestaged"), data.staged, staged: true) }
                if !data.unstaged.isEmpty { section(String(localized: "Nicht gestaged"), data.unstaged, staged: false) }
            }
        }
        .themedList()
        .overlay { if data == nil && error == nil { Skeleton(style: .iconList, count: 10).background(Theme.bg) } }
        .safeAreaInset(edge: .bottom, spacing: 0) { reviewBar }
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog("Änderungen an dieser Datei verwerfen?", isPresented: Binding(
            get: { confirmDiscard != nil }, set: { if !$0 { confirmDiscard = nil } }), titleVisibility: .visible,
                            presenting: confirmDiscard) { file in
            Button("Verwerfen", role: .destructive) { Task { await discard(file) } }
        } message: { file in
            Text(file.status == "?" || file.status == "A"
                 ? String(localized: "\(file.name) wird gelöscht – das lässt sich nicht rückgängig machen.")
                 : String(localized: "\(file.name) wird auf den letzten Commit zurückgesetzt."))
        }
        .alert("Kommentar an \(agent?.pane.agentName ?? "den Agent")", isPresented: Binding(
            get: { commenting != nil }, set: { if !$0 { commenting = nil } })) {
            TextField("Was soll sich an der Datei ändern?", text: $comment, axis: .vertical)
            Button("Senden") { sendComment() }
            Button("Abbrechen", role: .cancel) { comment = "" }
        } message: { Text(commenting?.path ?? "") }
        .sheet(isPresented: $showCommit) {
            CommitComposer(server: server, space: space, agent: agent, hasStaged: !(data?.staged.isEmpty ?? true)) { result in
                notice = result
                Task { await load() }
            }
            .presentationDetents([.medium, .large])
        }
    }

    /// Commit / push / PR at the bottom of the changes.
    @ViewBuilder private var reviewBar: some View {
        if let data, !(data.staged.isEmpty && data.unstaged.isEmpty) || notice != nil {
            VStack(spacing: 6) {
                if let notice {
                    Text(notice).font(Typo.sm).foregroundStyle(Theme.muted).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !(data.staged.isEmpty && data.unstaged.isEmpty) {
                    Button { showCommit = true } label: { Label("Commit …", icon: .check) }
                        .buttonStyle(.hollr(.primary, fullWidth: true))
                }
            }
            .padding(.horizontal, Gap.l).padding(.vertical, Gap.s)
            .background(Theme.bg)
            .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
        }
    }

    private func discard(_ file: FileChange) async {
        busy = file.path
        defer { busy = nil }
        do {
            struct R: Decodable { let ok: Bool }
            _ = try await HollrClient.fs(server, ["op": "discard", "ws": space.id, "path": file.path], as: R.self)
            Haptics.notify(.success)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func sendComment() {
        let text = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let file = commenting, let agent, !text.isEmpty else { return }
        sessions.session(for: agent).sendText("Zu \(file.path): \(text)")
        notice = String(localized: "Kommentar an \(agent.title) gesendet.")
        comment = ""
        Haptics.notify(.success)
    }

    private func summary(_ d: ChangesResponse) -> String {
        var parts: [String] = []
        if !d.unstaged.isEmpty { parts.append(String(localized: "\(d.unstaged.count) nicht gestaged")) }
        if !d.staged.isEmpty { parts.append("\(d.staged.count) gestaged") }
        return parts.isEmpty ? "" : "· " + parts.joined(separator: " · ")
    }

    private func section(_ title: String, _ files: [FileChange], staged: Bool) -> some View {
        Section {
            ForEach(files) { file in
                HStack(spacing: Gap.s) {
                    NavigationLink {
                        DiffScreen(server: server, space: space, source: .file(path: file.path, staged: staged), title: file.name)
                    } label: {
                        HStack(spacing: 10) {
                            StatusBadge(status: file.status)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(file.name).font(Typo.monoSmall).lineLimit(1)
                                if !file.dir.isEmpty {
                                    Text(file.dir).font(Typo.monoXS).foregroundStyle(Theme.dim).lineLimit(1).truncationMode(.head)
                                }
                            }
                            Spacer()
                            PlusMinus(add: file.add, del: file.del)
                        }
                    }
                    Button { Task { await toggleStage(file, staged: staged) } } label: {
                        if busy == file.path {
                            Spinner(color: Theme.muted)
                        } else {
                            Image(systemName: staged ? "minus" : "plus")
                        }
                    }
                    .buttonStyle(.icon(size: 32))
                    .accessibilityLabel(staged ? "Unstagen" : "Stagen")
                }
                .listRowBackground(Theme.card)
                .swipeActions(edge: .leading) {
                    Button { Task { await toggleStage(file, staged: staged) } } label: {
                        Label(staged ? "Unstagen" : "Stagen", systemImage: staged ? "minus.circle" : "plus.circle")
                    }
                    .tint(staged ? Theme.muted : Theme.green)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { confirmDiscard = file } label: {
                        Label("Verwerfen", systemImage: "arrow.uturn.backward")
                    }
                    if agent != nil {
                        Button { commenting = file } label: { Label("Kommentar", icon: .message) }
                            .tint(Theme.accent)
                    }
                }
            }
        } header: {
            SectionHeader(title: title, trailing: "\(files.count)")
        }
    }

    private func toggleStage(_ file: FileChange, staged: Bool) async {
        busy = file.path
        defer { busy = nil }
        do {
            struct R: Decodable { let ok: Bool }
            _ = try await HollrClient.fs(server, ["op": staged ? "unstage" : "stage", "ws": space.id, "path": file.path], as: R.self)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func load() async {
        do {
            data = try await HollrClient.fs(server, ["op": "changes", "ws": space.id], as: ChangesResponse.self)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - History

struct HistoryTab: View {
    let server: Server
    let space: Space
    @State private var rows: [GraphRow] = []
    @State private var changes: ChangesSummary?
    @State private var loaded = false
    @State private var error: String?
    @State private var selected: GraphCommit?

    private static let rowHeight: CGFloat = 40

    var body: some View {
        // sideways too: long commit messages stay readable
        ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let error {
                    Text(error).foregroundStyle(Theme.warn).padding(Gap.l)
                        .frame(width: DiffLineRow.screenWidth, alignment: .leading)
                }
                if let changes, changes.files > 0 {
                    NavigationLink { ChangesTab(server: server, space: space) } label: {
                        HStack(spacing: 0) {
                            Canvas { ctx, size in
                                let x = GraphCell.x(0), mid = size.height / 2
                                var p = Path()
                                p.move(to: CGPoint(x: x, y: mid + 6))
                                p.addLine(to: CGPoint(x: x, y: size.height))
                                ctx.stroke(p, with: .color(GitStyle.lanes[0]), lineWidth: 2)
                                ctx.stroke(Path(ellipseIn: CGRect(x: x - 6, y: mid - 6, width: 12, height: 12)),
                                           with: .color(GitStyle.lanes[0]), lineWidth: 2)
                            }
                            .frame(width: GraphCell.x(0) + 16)
                            Text("Nicht committete Änderungen").font(Typo.md).foregroundStyle(Theme.muted).padding(.leading, Gap.xs)
                            Spacer()
                            PlusMinus(add: changes.add, del: changes.del).padding(.trailing, 14)
                        }
                        .frame(width: DiffLineRow.screenWidth, height: Self.rowHeight)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(rows) { row in
                    Button { selected = row.commit } label: {
                        HStack(spacing: 0) {
                            GraphCell(row: row, top: false)
                            Text(row.commit.subject).font(Typo.md).lineLimit(1).fixedSize().padding(.leading, Gap.xs)
                            Spacer(minLength: Gap.m)
                            Text(GitStyle.age(row.commit.at)).font(Typo.xs.monospacedDigit()).foregroundStyle(Theme.dim)
                                .padding(.trailing, 14)
                        }
                        .frame(minWidth: DiffLineRow.screenWidth, minHeight: Self.rowHeight, maxHeight: Self.rowHeight, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.bottom, Gap.xl)
        }
        .background(Theme.bg)
        .overlay { if !loaded && error == nil { Skeleton(style: .graph, count: 16).background(Theme.bg) } }
        .refreshable { await load() }
        .task { if !loaded { await load() } }
        .sheet(item: $selected) { commit in
            NavigationStack { CommitSheet(server: server, space: space, commit: commit) }
                .presentationDetents([.medium, .large])
                .dialogSheet()
        }
    }

    private func load() async {
        do {
            let r = try await HollrClient.fs(server, ["op": "graph", "ws": space.id, "limit": 200], as: GraphResponse.self)
            changes = r.changes
            rows = GraphLayout.rows(r.commits, dirtyTop: r.changes.files > 0)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

struct CommitSheet: View {
    let server: Server
    let space: Space
    let commit: GraphCommit
    @State private var detail: CommitDetail?
    @State private var error: String?
    @State private var copied = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Gap.l) {
                Text(commit.subject).font(Typo.lg)
                if let body = detail?.body, !body.isEmpty {
                    Text(body).font(Typo.md).foregroundStyle(Theme.muted)
                }
                if let detail {
                    VStack(alignment: .leading, spacing: Gap.s) {
                        HStack(alignment: .lastTextBaseline, spacing: Gap.s) {
                            SectionHeader(title: String(localized: "Geänderte Dateien"), trailing: "\(detail.files.count)")
                            PlusMinus(add: detail.files.map(\.add).reduce(0, +), del: detail.files.map(\.del).reduce(0, +))
                        }
                        if detail.merge {
                            FootNote(String(localized: "Merge – zeigt, was der Merge gebracht hat."))
                        }
                        Rows {
                            ForEach(detail.files.prefix(60)) { file in
                                NavigationLink {
                                    DiffScreen(server: server, space: space, source: .commit(hash: commit.hash, path: file.path), title: file.name)
                                } label: {
                                    ChangeRow(status: file.status, path: file.path, add: file.add, del: file.del)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    info(detail)
                } else if let error {
                    Text(error).foregroundStyle(Theme.warn)
                } else {
                    Skeleton(style: .iconList, count: 5).frame(height: 260)
                }
            }
            .padding(Gap.l)
        }
        .background(Theme.side)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: Gap.s) {
                NavigationLink {
                    DiffScreen(server: server, space: space, source: .commit(hash: commit.hash, path: nil), title: String(commit.hash.prefix(8)))
                } label: {
                    Text("Änderungen anzeigen")
                }
                .buttonStyle(.hollr(.primary, fullWidth: true))
                Button {
                    UIPasteboard.general.string = commit.hash
                    copied = true
                } label: {
                    IconView(copied ? .check : .copy, size: 15)
                }
                .buttonStyle(.hollr(.secondary))
                .accessibilityLabel("Commit-Hash kopieren")
            }
            .padding(.horizontal, Gap.l).padding(.vertical, Gap.m)
            .background(Theme.side)
            .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
        }
        .task {
            do {
                detail = try await HollrClient.fs(server, ["op": "commit", "ws": space.id, "hash": commit.hash], as: CommitDetail.self)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func info(_ d: CommitDetail) -> some View {
        VStack(alignment: .leading, spacing: Gap.m) {
            field(String(localized: "Commit")) { Text(d.hash).font(Typo.monoSmall).textSelection(.enabled) }
            field(String(localized: "Autor")) {
                (Text(d.author) + Text(" <\(d.email)>").foregroundStyle(Theme.muted)).font(Typo.md)
            }
            field(String(localized: "Datum")) {
                Text("\(Date(timeIntervalSince1970: d.at / 1000).formatted(date: .numeric, time: .shortened)) · \(RelativeTime.string(d.at))")
                    .font(Typo.md)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }

    private func field(_ label: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(Typo.xs).tracking(0.6).foregroundStyle(Theme.muted)
            content()
        }
    }
}

/// A changed file as one mono line (space__change): kind letter, path, +N −N.
struct ChangeRow: View {
    let status: String
    let path: String
    let add: Int
    let del: Int

    var body: some View {
        HStack(spacing: 10) {
            StatusBadge(status: status)
            Text(path).font(Typo.monoSmall).lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            PlusMinus(add: add, del: del)
        }
        .padding(.vertical, Gap.s).padding(.horizontal, 14)
        .frame(minHeight: Metric.touch)
        .contentShape(Rectangle())
    }
}

// MARK: - Branches

struct BranchesTab: View {
    let server: Server
    let space: Space
    @State private var data: BranchesResponse?
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(Theme.warn).listRowBackground(Theme.card) }
            if let data {
                section(String(localized: "Lokal"), data.local)
                section("Remote", data.remote)
            }
        }
        .themedList()
        .overlay { if data == nil && error == nil { Skeleton(style: .iconList, count: 10).background(Theme.bg) } }
        .refreshable { await load() }
        .task { await load() }
    }

    private func section(_ title: String, _ items: [BranchInfo]) -> some View {
        Section {
            ForEach(items) { b in
                HStack(spacing: Gap.m) {
                    IconView(.branch, size: 15)
                        .foregroundStyle(b.current ? Theme.accent : Theme.dim)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(b.name).font(Typo.mono.weight(b.current ? .semibold : .regular))
                            .lineLimit(1).truncationMode(.middle)
                        Text("\(b.subject) · \(GitStyle.age(b.at))").font(Typo.sm).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    trailing(b)
                }
                .listRowBackground(Theme.card)
            }
        } header: {
            SectionHeader(title: title, trailing: "\(items.count)")
        }
    }

    @ViewBuilder private func trailing(_ b: BranchInfo) -> some View {
        if let pr = b.pr {
            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.pull").font(Typo.xs)
                Text(verbatim: "#\(pr.number)").font(Typo.monoSmall)
                switch pr.checks {
                case "ok": IconView(.check, size: 12).foregroundStyle(Theme.green)
                case "fail": IconView(.x, size: 12).foregroundStyle(Theme.red)
                case "pending": Image(systemName: "clock").font(Typo.xs).foregroundStyle(Theme.yellow)
                default: EmptyView()
                }
            }
            .foregroundStyle(pr.draft ? Theme.muted : Theme.fg)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(Theme.wash(0.08), in: Capsule())
        } else if b.ahead > 0 || b.behind > 0 {
            HStack(spacing: 4) {
                if b.ahead > 0 { Text(verbatim: "↑\(b.ahead)").foregroundStyle(Theme.green) }
                if b.behind > 0 { Text(verbatim: "↓\(b.behind)").foregroundStyle(Theme.yellow) }
            }
            .font(Typo.monoSmall)
        }
    }

    private func load() async {
        do {
            data = try await HollrClient.fs(server, ["op": "branches", "ws": space.id], as: BranchesResponse.self)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Commit dialog: own message, or let the agent write it (and commit) – then push / open a PR.
private struct CommitComposer: View {
    let server: Server
    let space: Space
    let agent: AgentRef?
    let hasStaged: Bool
    let done: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(SessionStore.self) private var sessions
    @State private var message = ""
    @State private var all = true
    @State private var busy = false
    @State private var error: String?
    @State private var committed: String?
    @FocusState private var focused: Bool

    private var canCommit: Bool { !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !busy }

    var body: some View {
        DialogScaffold(icon: .check, title: String(localized: "Commit"), onClose: { dismiss() }) {
            if let committed {
                Label("Committet: \(committed)", icon: .check).foregroundStyle(Theme.live)
                Button { Task { await run("push") } } label: { Label("Pushen", icon: .arrowUp) }
                    .buttonStyle(.hollr(.secondary, fullWidth: true))
                    .disabled(busy)
                Button { Task { await run("pr") } } label: { Label("Pushen und PR öffnen", systemImage: "arrow.triangle.pull") }
                    .buttonStyle(.hollr(.secondary, fullWidth: true))
                    .disabled(busy)
            } else {
                DialogField(label: String(localized: "Commit-Nachricht"),
                            note: hasStaged && !all ? String(localized: "Nur die gestagten Dateien.")
                                                    : String(localized: "Alle Änderungen, auch neue Dateien.")) {
                    TextField("Commit-Nachricht", text: $message, axis: .vertical)
                        .lineLimit(2...6)
                        .focused($focused)
                        .fieldStyle(focused: focused)
                }
                if hasStaged {
                    Toggle("Auch nicht gestagte Änderungen", isOn: $all).font(Typo.md)
                }
                if let agent {
                    Button {
                        sessions.session(for: agent).sendText(
                            "Schau dir die aktuellen Änderungen an und committe sie mit einer passenden, kurzen Commit-Nachricht.")
                        done(String(localized: "\(agent.title) schreibt die Commit-Nachricht und committet."))
                        dismiss()
                    } label: {
                        Label("\(agent.pane.agentName) die Nachricht schreiben lassen", icon: .sparkle)
                    }
                    .buttonStyle(.hollr(.secondary, fullWidth: true))
                }
            }
            if let error {
                Text(error).foregroundStyle(Theme.warn).font(Typo.sm)
            }
        } footer: {
            Button("Schließen") { dismiss() }
                .buttonStyle(.hollr(.secondary))
            if committed == nil {
                Button { Task { await commit() } } label: {
                    if busy { Spinner(color: Theme.onAccent) } else { Label("Committen", icon: .check) }
                }
                .buttonStyle(.hollr(.primary))
                .disabled(!canCommit)
            } else if busy {
                Spinner()
            }
        }
        .dialogSheet()
        .onAppear { focused = true }
    }

    private func commit() async {
        busy = true
        defer { busy = false }
        do {
            struct R: Decodable { let hash: String }
            let r = try await HollrClient.fs(server, ["op": "gitcommit", "ws": space.id, "message": message, "all": all || !hasStaged],
                                             as: R.self, seconds: 60)
            committed = r.hash
            error = nil
            Haptics.notify(.success)
            done(String(localized: "Committet: \(r.hash)"))
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func run(_ op: String) async {
        busy = true
        defer { busy = false }
        do {
            struct R: Decodable { let url: String? }
            let r = try await HollrClient.fs(server, ["op": op, "ws": space.id], as: R.self, seconds: 90)
            Haptics.notify(.success)
            if let url = r.url {
                done(String(localized: "PR: \(url)"))
                if let link = URL(string: url) { await UIApplication.shared.open(link) }
            } else {
                done(String(localized: "Gepusht."))
            }
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
