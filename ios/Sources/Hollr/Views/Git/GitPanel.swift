import SwiftUI
import UIKit

/// Moshi-style repo browser: files, uncommitted changes, history graph, branches.
/// A floating capsule switches between them (plus the space's agents when shown in Spaces).
struct GitPanel: View {
    enum Tab: Int, CaseIterable {
        case agents, files, changes, history, branches
        var icon: String {
            switch self {
            case .agents: return "waveform"
            case .files: return "list.bullet.indent"
            case .changes: return "doc.badge.plus"
            case .history: return "clock.arrow.circlepath"
            case .branches: return "arrow.triangle.branch"
            }
        }
        var title: String {
            switch self {
            case .agents: return "Agents"
            case .files: return String(localized: "Dateien")
            case .changes: return String(localized: "Änderungen")
            case .history: return String(localized: "Verlauf")
            case .branches: return "Branches"
            }
        }
    }

    let server: Server
    let space: Space
    var showAgents = true
    @State var tab: Tab = .files

    var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                switch tab {
                case .agents: SpaceAgentsList(server: server, space: space)
                case .files: FilesTab(server: server, space: space, path: "")
                case .changes: ChangesTab(server: server, space: space)
                case .history: HistoryTab(server: server, space: space)
                case .branches: BranchesTab(server: server, space: space)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            bar
        }
        .background(GitStyle.background)
    }

    private var bar: some View {
        HStack(spacing: 4) {
            ForEach(Tab.allCases.filter { showAgents || $0 != .agents }, id: \.self) { t in
                Button { withAnimation(.snappy) { tab = t } } label: {
                    Image(systemName: t.icon)
                        .font(.title3)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(tab == t ? Theme.fg.opacity(0.16) : .clear, in: Capsule())
                        .foregroundStyle(tab == t ? .primary : .secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(t.title)
            }
        }
        .padding(5)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(Theme.fg.opacity(0.1)))
        .padding(.horizontal, 22)
        .padding(.bottom, 6)
    }
}

private struct PanelHeader: View {
    let icon: String
    let title: String
    var trailing: AnyView? = nil

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.title3)
            Text(title).font(.title2.weight(.semibold)).lineLimit(1)
            Spacer()
            trailing
        }
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 6)
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
            Group {
            if path.isEmpty {
                Section {
                    PanelHeader(icon: "list.bullet.indent", title: space.repo ?? space.label)
                        .listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
            }
            if let error { Text(error).foregroundStyle(Theme.warn) }
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
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            Color.clear.frame(height: 60).listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .overlay { if entries == nil && error == nil { Skeleton(style: .iconList, count: 14).background(GitStyle.background) } }
        .navigationTitle(path.isEmpty ? "" : (path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func row(_ entry: DirEntry) -> some View {
        let (symbol, color) = FileIcon.symbol(entry.name, dir: entry.dir)
        return HStack(spacing: 14) {
            Image(systemName: symbol).foregroundStyle(color).frame(width: 26)
            Text(entry.name).lineLimit(1).truncationMode(.middle)
                .foregroundStyle(entry.name.hasPrefix(".") ? .secondary : .primary)
            Spacer()
            if let mtime = entry.mtime, mtime > 0 {
                Text(GitStyle.age(mtime)).font(.footnote).foregroundStyle(.tertiary)
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
                    ContentUnavailableView("Binärdatei", systemImage: "doc",
                                           description: Text(ByteCountFormatter.string(fromByteCount: Int64(content.size), countStyle: .file)))
                } else if isMarkdown && rendered {
                    ScrollView { ScaledMarkdown(text: content.text).padding() }
                } else if wrap {
                    ScrollView { lines(content) }
                } else {
                    ScrollView([.vertical, .horizontal]) { lines(content) }
                }
            } else if let error {
                ContentUnavailableView("Fehler", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                Skeleton(style: .code, count: 30)
            }
        }
        .background(GitStyle.background)
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isMarkdown {
                Button(rendered ? "Quelltext" : "Vorschau") { rendered.toggle() }
            } else {
                Button { wrap.toggle() } label: { Image(systemName: wrap ? "text.justify.left" : "arrow.turn.down.left") }
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
                    .font(.footnote).foregroundStyle(.secondary).padding()
            }
        }
        .padding(.vertical, 8)
        .padding(.bottom, 60)
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
            Group {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    PanelHeader(icon: "doc.badge.plus", title: String(localized: "Nicht committete Änderungen"))
                    if let data {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.triangle.branch").foregroundStyle(.secondary)
                            Text(data.branch).font(.system(.subheadline, design: .monospaced))
                            Text(summary(data)).font(.subheadline).foregroundStyle(.secondary)
                            Spacer()
                            PlusMinus(add: (data.staged + data.unstaged).map(\.add).reduce(0, +),
                                      del: (data.staged + data.unstaged).map(\.del).reduce(0, +))
                        }
                        .padding(.horizontal, 16)
                    }
                }
                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if let error { Text(error).foregroundStyle(Theme.warn) }
            if let data {
                if data.staged.isEmpty && data.unstaged.isEmpty {
                    Text("Alles committet.").foregroundStyle(.secondary).listRowBackground(Color.clear)
                }
                if !data.staged.isEmpty { section("Gestaged", data.staged, staged: true) }
                if !data.unstaged.isEmpty { section("Nicht gestaged", data.unstaged, staged: false) }
            }
            Color.clear.frame(height: 120).listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .overlay { if data == nil && error == nil { Skeleton(style: .iconList, count: 10).background(GitStyle.background) } }
        .safeAreaInset(edge: .bottom) { reviewBar }
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
                    Text(notice).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !(data.staged.isEmpty && data.unstaged.isEmpty) {
                    Button { showCommit = true } label: {
                        Label("Commit …", systemImage: "checkmark.circle").frame(maxWidth: .infinity).padding(.vertical, 4)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 64) // above the tab capsule
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
                HStack(spacing: 12) {
                    NavigationLink {
                        DiffScreen(server: server, space: space, source: .file(path: file.path, staged: staged), title: file.name)
                    } label: {
                        HStack(spacing: 12) {
                            StatusBadge(status: file.status)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(file.name).lineLimit(1)
                                if !file.dir.isEmpty {
                                    Text(file.dir).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                                }
                            }
                            Spacer()
                            PlusMinus(add: file.add, del: file.del)
                        }
                    }
                    Button { Task { await toggleStage(file, staged: staged) } } label: {
                        if busy == file.path {
                            ProgressView()
                        } else {
                            Image(systemName: staged ? "minus" : "plus").foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .frame(width: 28)
                    .accessibilityLabel(staged ? "Unstagen" : "Stagen")
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .swipeActions(edge: .leading) {
                    Button { Task { await toggleStage(file, staged: staged) } } label: {
                        Label(staged ? "Unstagen" : "Stagen", systemImage: staged ? "minus.circle" : "plus.circle")
                    }
                    .tint(staged ? .gray : .green)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { confirmDiscard = file } label: {
                        Label("Verwerfen", systemImage: "arrow.uturn.backward")
                    }
                    if agent != nil {
                        Button { commenting = file } label: { Label("Kommentar", systemImage: "text.bubble") }
                            .tint(Theme.accent)
                    }
                }
            }
        } header: {
            HStack {
                Text(title).font(.headline).foregroundStyle(.primary)
                Spacer()
                Text("\(files.count)").foregroundStyle(.secondary)
            }
            .textCase(nil)
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
                PanelHeader(icon: "clock.arrow.circlepath", title: String(localized: "Verlauf"))
                    .frame(width: DiffLineRow.screenWidth, alignment: .leading)
                if let error { Text(error).foregroundStyle(Theme.warn).padding() }
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
                            Text("Nicht committete Änderungen").padding(.leading, 4)
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
                            Text(row.commit.subject).lineLimit(1).fixedSize().padding(.leading, 4)
                            Spacer(minLength: 12)
                            Text(GitStyle.age(row.commit.at)).font(.footnote).foregroundStyle(.tertiary)
                                .padding(.trailing, 14)
                        }
                        .frame(minWidth: DiffLineRow.screenWidth, minHeight: Self.rowHeight, maxHeight: Self.rowHeight, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Color.clear.frame(height: 70)
            }
        }
        .overlay { if !loaded && error == nil { Skeleton(style: .graph, count: 16).background(GitStyle.background) } }
        .refreshable { await load() }
        .task { if !loaded { await load() } }
        .sheet(item: $selected) { commit in
            NavigationStack { CommitSheet(server: server, space: space, commit: commit) }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackground(Theme.card)
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
            VStack(alignment: .leading, spacing: 18) {
                Text(commit.subject).font(.title3.weight(.semibold))
                if let body = detail?.body, !body.isEmpty {
                    Text(body).font(.subheadline).foregroundStyle(.secondary)
                }
                if let detail {
                    HStack {
                        Text("GEÄNDERTE DATEIEN  \(detail.files.count)").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                        Spacer()
                        PlusMinus(add: detail.files.map(\.add).reduce(0, +), del: detail.files.map(\.del).reduce(0, +))
                    }
                    if detail.merge {
                        Text("Merge – zeigt, was der Merge gebracht hat.").font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(detail.files.prefix(60)) { file in
                        NavigationLink {
                            DiffScreen(server: server, space: space, source: .commit(hash: commit.hash, path: file.path), title: file.name)
                        } label: {
                            HStack(spacing: 12) {
                                StatusBadge(status: file.status)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(file.name).foregroundStyle(.primary).lineLimit(1)
                                    if !file.dir.isEmpty {
                                        Text(file.dir).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                                    }
                                }
                                Spacer()
                                PlusMinus(add: file.add, del: file.del)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    info(detail)
                } else if let error {
                    Text(error).foregroundStyle(Theme.warn)
                } else {
                    Skeleton(style: .iconList, count: 5).frame(height: 260)
                }
            }
            .padding(20)
        }
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 12) {
                NavigationLink {
                    DiffScreen(server: server, space: space, source: .commit(hash: commit.hash, path: nil), title: String(commit.hash.prefix(8)))
                } label: {
                    Text("Änderungen anzeigen").font(.headline)
                        .frame(maxWidth: .infinity).frame(height: 52)
                        .background(GitStyle.lanes[0], in: Capsule())
                        .foregroundStyle(.white)
                }
                Button {
                    UIPasteboard.general.string = commit.hash
                    copied = true
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .frame(width: 52, height: 52)
                        .background(Theme.fg.opacity(0.1), in: Circle())
                }
                .accessibilityLabel("Commit-Hash kopieren")
            }
            .padding(.horizontal, 20).padding(.bottom, 8)
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
        VStack(alignment: .leading, spacing: 14) {
            field("COMMIT") { Text(d.hash).font(.system(.subheadline, design: .monospaced)).textSelection(.enabled) }
            field("AUTOR") {
                (Text(d.author) + Text(" <\(d.email)>").foregroundColor(.secondary)).font(.subheadline)
            }
            field("DATUM") {
                Text("\(Date(timeIntervalSince1970: d.at / 1000).formatted(date: .numeric, time: .shortened)) · \(RelativeTime.string(d.at))")
                    .font(.subheadline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Theme.fg.opacity(0.05), in: RoundedRectangle(cornerRadius: 16))
    }

    private func field(_ label: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            content()
        }
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
            Group {
            Section {
                PanelHeader(icon: "arrow.triangle.branch", title: "Branches")
                    .listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if let error { Text(error).foregroundStyle(Theme.warn) }
            if let data {
                section("Lokal", data.local)
                section("Remote", data.remote)
            }
            Color.clear.frame(height: 60).listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .overlay { if data == nil && error == nil { Skeleton(style: .iconList, count: 10).background(GitStyle.background) } }
        .refreshable { await load() }
        .task { await load() }
    }

    private func section(_ title: String, _ items: [BranchInfo]) -> some View {
        Section {
            ForEach(items) { b in
                HStack(spacing: 14) {
                    Image(systemName: "arrow.triangle.branch")
                        .foregroundStyle(b.current ? GitStyle.lanes[0] : .secondary)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(b.name).lineLimit(1).truncationMode(.middle)
                            .fontWeight(b.current ? .semibold : .regular)
                        Text("\(b.subject) · \(GitStyle.age(b.at))").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    trailing(b)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
        } header: {
            HStack {
                Text(title).font(.headline).foregroundStyle(.primary)
                Spacer()
                Text("\(items.count)").font(.system(.subheadline, design: .monospaced)).foregroundStyle(.secondary)
            }
            .textCase(nil)
        }
    }

    @ViewBuilder private func trailing(_ b: BranchInfo) -> some View {
        if let pr = b.pr {
            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.pull").font(.caption)
                Text(verbatim: "#\(pr.number)").font(.system(.footnote, design: .monospaced))
                switch pr.checks {
                case "ok": Image(systemName: "checkmark.circle.fill").foregroundStyle(GitStyle.added)
                case "fail": Image(systemName: "xmark.circle.fill").foregroundStyle(GitStyle.removed)
                case "pending": Image(systemName: "clock.fill").foregroundStyle(Omp.warning)
                default: EmptyView()
                }
            }
            .foregroundStyle(pr.draft ? .secondary : .primary)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(Theme.fg.opacity(0.08), in: Capsule())
        } else if b.ahead > 0 || b.behind > 0 {
            HStack(spacing: 4) {
                if b.ahead > 0 { Text("↑\(b.ahead)").foregroundStyle(GitStyle.added) }
                if b.behind > 0 { Text("↓\(b.behind)").foregroundStyle(Omp.warning) }
            }
            .font(.system(.subheadline, design: .monospaced))
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

/// Commit sheet: own message, or let the agent write it (and commit) – then push / open a PR.
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

    var body: some View {
        NavigationStack {
            Form {
                if let committed {
                    Section {
                        Label("Committet: \(committed)", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.live)
                        Button { Task { await run("push") } } label: { Label("Pushen", systemImage: "arrow.up.circle") }
                        Button { Task { await run("pr") } } label: { Label("Pushen und PR öffnen", systemImage: "arrow.triangle.pull") }
                    }
                } else {
                    Section {
                        TextField("Commit-Nachricht", text: $message, axis: .vertical)
                            .lineLimit(2...6)
                            .focused($focused)
                        if hasStaged {
                            Toggle("Auch nicht gestagte Änderungen", isOn: $all)
                        }
                    } footer: {
                        Text(hasStaged && !all ? "Nur die gestagten Dateien." : "Alle Änderungen, auch neue Dateien.")
                    }
                    Section {
                        Button { Task { await commit() } } label: {
                            Label("Committen", systemImage: "checkmark.circle")
                        }
                        .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                        if let agent {
                            Button {
                                sessions.session(for: agent).sendText(
                                    "Schau dir die aktuellen Änderungen an und committe sie mit einer passenden, kurzen Commit-Nachricht.")
                                done(String(localized: "\(agent.title) schreibt die Commit-Nachricht und committet."))
                                dismiss()
                            } label: {
                                Label("\(agent.pane.agentName) die Nachricht schreiben lassen", systemImage: "sparkles")
                            }
                        }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(Theme.warn).font(.footnote) }
                }
            }
            .navigationTitle("Commit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } }
                if busy { ToolbarItem(placement: .confirmationAction) { ProgressView() } }
            }
            .onAppear { focused = true }
        }
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
