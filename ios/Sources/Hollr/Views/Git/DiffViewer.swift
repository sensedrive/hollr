import SwiftUI
import UIKit

// MARK: - Unified diff parsing

struct DiffLine: Identifiable, Hashable {
    enum Kind { case context, added, removed }
    let id: Int
    let kind: Kind
    let old: Int?
    let new: Int?
    let text: String
}

struct DiffFile: Identifiable, Hashable {
    let path: String
    var lines: [DiffLine]
    var add: Int { lines.filter { $0.kind == .added }.count }
    var del: Int { lines.filter { $0.kind == .removed }.count }
    var id: String { path }
}

enum DiffParser {
    static func parse(_ text: String) -> [DiffFile] {
        var files: [DiffFile] = []
        var current: DiffFile?
        var old = 0, new = 0, n = 0
        func finish() { if let current { files.append(current) } }
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("diff --git ") {
                finish()
                let path = line.components(separatedBy: " b/").last ?? line
                current = DiffFile(path: path, lines: [])
                continue
            }
            if line.hasPrefix("+++ b/") {
                current = DiffFile(path: String(line.dropFirst(6)), lines: current?.lines ?? [])
                continue
            }
            if line.hasPrefix("--- ") || line.hasPrefix("+++ ") || line.hasPrefix("index ") || line.hasPrefix("new file")
                || line.hasPrefix("deleted file") || line.hasPrefix("similarity") || line.hasPrefix("rename ")
                || line.hasPrefix("old mode") || line.hasPrefix("new mode") || line.hasPrefix("Binary files") {
                continue
            }
            if line.hasPrefix("@@") {
                // @@ -12,7 +12,9 @@
                let nums = line.split(separator: " ")
                if nums.count > 2 {
                    old = Int(nums[1].dropFirst().split(separator: ",").first ?? "") ?? 0
                    new = Int(nums[2].dropFirst().split(separator: ",").first ?? "") ?? 0
                }
                if current == nil { current = DiffFile(path: "", lines: []) }
                if let last = current?.lines.last, let lastNew = last.new ?? last.old, new > lastNew + 1 {
                    // gap between hunks: marker line
                    current?.lines.append(DiffLine(id: n, kind: .context, old: nil, new: nil, text: "\u{2026}"))
                    n += 1
                }
                continue
            }
            guard current != nil else { continue }
            if line.hasPrefix("\\") { continue } // "\ No newline at end of file"
            let body = line.isEmpty ? "" : String(line.dropFirst())
            switch line.first {
            case "+":
                current?.lines.append(DiffLine(id: n, kind: .added, old: nil, new: new, text: body)); new += 1
            case "-":
                current?.lines.append(DiffLine(id: n, kind: .removed, old: old, new: nil, text: body)); old += 1
            default:
                current?.lines.append(DiffLine(id: n, kind: .context, old: old, new: new, text: body)); old += 1; new += 1
            }
            n += 1
        }
        finish()
        return files.filter { !$0.path.isEmpty || !$0.lines.isEmpty }
    }
}

// MARK: - Rendering with folded context

private enum DiffBlock: Identifiable {
    case lines([DiffLine])
    case fold(id: Int, lines: [DiffLine])
    var id: Int {
        switch self {
        case let .lines(l): return l.first?.id ?? -1
        case let .fold(id, _): return -id - 2
        }
    }
}

/// One file's diff: line numbers, colored gutter, syntax colors, unchanged runs folded.
struct DiffFileView: View {
    let file: DiffFile
    let wrap: Bool
    @State private var expanded: Set<Int> = []
    @State private var collapsed = false
    private static let keep = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !collapsed {
                ForEach(blocks) { block in
                    switch block {
                    case let .lines(lines):
                        ForEach(lines) { DiffLineRow(line: $0, lang: Syntax.language(for: file.path), wrap: wrap) }
                    case let .fold(id, lines):
                        if expanded.contains(id) {
                            ForEach(lines) { DiffLineRow(line: $0, lang: Syntax.language(for: file.path), wrap: wrap) }
                        } else {
                            Button { withAnimation(.snappy) { _ = expanded.insert(id) } } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "arrow.up.and.down").font(Typo.sm)
                                        .frame(width: 44)
                                    Text("\(lines.count) unveränderte Zeilen").font(Typo.sm)
                                    Spacer()
                                }.foregroundStyle(Theme.muted)
                                .padding(.vertical, 9)
                                .background(Theme.wash(0.05))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private var header: some View {
        Button { withAnimation(.snappy) { collapsed.toggle() } } label: {
            HStack(spacing: Gap.s) {
                IconView(collapsed ? .chevronRight : .chevronDown, size: 12).foregroundStyle(Theme.dim)
                IconView(.file, size: 13).foregroundStyle(Theme.muted)
                Text(file.path).font(Typo.monoSmall).lineLimit(1).truncationMode(.head)
                Spacer()
                PlusMinus(add: file.add, del: file.del)
            }
            .padding(.horizontal, Gap.m).padding(.vertical, 10)
            .background(Theme.card)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
        }
        .buttonStyle(.plain)
    }

    /// Unchanged runs longer than 2×keep+1 collapse into a fold row.
    private var blocks: [DiffBlock] {
        var out: [DiffBlock] = []
        var buffer: [DiffLine] = []
        var context: [DiffLine] = []
        func flushContext(isEnd: Bool, isStart: Bool) {
            let headKeep = isStart ? 0 : Self.keep
            let tailKeep = isEnd ? 0 : Self.keep
            if context.count > headKeep + tailKeep + 1 {
                buffer += context.prefix(headKeep)
                if !buffer.isEmpty { out.append(.lines(buffer)) }
                buffer = []
                let folded = Array(context.dropFirst(headKeep).dropLast(tailKeep))
                out.append(.fold(id: folded.first?.id ?? 0, lines: folded))
                buffer = Array(context.suffix(tailKeep))
            } else {
                buffer += context
            }
            context = []
        }
        var seenChange = false
        for line in file.lines {
            if line.kind == .context, line.old != nil {
                context.append(line)
            } else {
                flushContext(isEnd: false, isStart: !seenChange)
                buffer.append(line)
                seenChange = true
            }
        }
        flushContext(isEnd: true, isStart: !seenChange)
        if !buffer.isEmpty { out.append(.lines(buffer)) }
        return out
    }
}

struct DiffLineRow: View {
    let line: DiffLine
    let lang: String
    let wrap: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle().fill(gutter).frame(width: 3)
            Text(number)
                .foregroundStyle(line.kind == .context ? Theme.dim : gutter)
                .frame(width: 44, alignment: .trailing)
                .padding(.trailing, 10)
            Text(line.old == nil && line.new == nil ? AttributedString(line.text) : Syntax.highlight(line.text.isEmpty ? " " : line.text, lang: lang))
                .lineLimit(wrap ? nil : 1)
                .fixedSize(horizontal: !wrap, vertical: true)
                .foregroundStyle(line.old == nil && line.new == nil ? Theme.dim : .primary)
            if wrap { Spacer(minLength: 0) }
        }
        .font(Typo.mono)
        .padding(.vertical, 2)
        // full-width tint, also when scrolling sideways
        .frame(minWidth: wrap ? nil : DiffLineRow.screenWidth, maxWidth: wrap ? .infinity : nil, alignment: .leading)
        .background(background)
    }

    @MainActor static var screenWidth: CGFloat {
        (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.width ?? 400
    }

    private var number: String {
        switch line.kind {
        case .removed: return line.old.map(String.init) ?? ""
        default: return line.new.map(String.init) ?? ""
        }
    }

    private var gutter: Color {
        switch line.kind {
        case .added: return Theme.green
        case .removed: return Theme.red
        case .context: return .clear
        }
    }

    /// added / removed lines on a 12 % green / red wash (tool-card__dl)
    private var background: Color {
        switch line.kind {
        case .added: return Theme.green.opacity(0.12)
        case .removed: return Theme.red.opacity(0.12)
        case .context: return .clear
        }
    }
}

/// Loads and shows a diff (working tree file, staged file, or a commit).
struct DiffScreen: View {
    enum Source: Hashable {
        case file(path: String, staged: Bool)
        case commit(hash: String, path: String?)
    }

    let server: Server
    let space: Space
    let source: Source
    var title: String = String(localized: "Änderungen")
    @State private var files: [DiffFile]?
    @State private var error: String?
    @AppStorage("diff.wrap") private var wrap = false

    var body: some View {
        Group {
            if let files {
                if files.isEmpty {
                    EmptyState(icon: .check, title: String(localized: "Keine Änderungen"), text: "")
                } else if wrap {
                    ScrollView { content(files) }
                } else {
                    ScrollView([.vertical, .horizontal]) { content(files) }
                }
            } else if let error {
                EmptyState(icon: .alert, title: String(localized: "Fehler"), text: error)
            } else {
                Skeleton(style: .code, count: 30)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { wrap.toggle() } label: { Image(systemName: wrap ? "text.justify.left" : "arrow.turn.down.left") }
                    .accessibilityLabel(wrap ? "Nicht umbrechen" : "Zeilen umbrechen")
            }
        }
        .task { await load() }
    }

    private func content(_ files: [DiffFile]) -> some View {
        LazyVStack(alignment: .leading, spacing: Gap.l, pinnedViews: []) {
            ForEach(files) { DiffFileView(file: $0, wrap: wrap) }
        }
        .padding(.bottom, Gap.xl)
        .textSelection(.enabled)
    }

    private func load() async {
        do {
            let body: [String: Any]
            switch source {
            case let .file(path, staged):
                body = ["op": "diff", "ws": space.id, "path": path, "staged": staged]
            case let .commit(hash, path):
                var b: [String: Any] = ["op": "commitdiff", "ws": space.id, "hash": hash]
                if let path { b["path"] = path }
                body = b
            }
            let r = try await HollrClient.fs(server, body, as: TextResponse.self)
            files = DiffParser.parse(r.text)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
