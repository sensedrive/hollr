import SwiftUI

// MARK: - Server responses (server/src/git.ts)

struct GraphCommit: Decodable, Identifiable, Hashable {
    let hash: String
    let parents: [String]
    let subject: String
    let author: String
    let at: Double
    let refs: String?
    var id: String { hash }
}

struct ChangesSummary: Decodable, Hashable {
    let files: Int
    let add: Int
    let del: Int
}

struct GraphResponse: Decodable {
    let commits: [GraphCommit]
    let changes: ChangesSummary
}

struct FileChange: Decodable, Identifiable, Hashable {
    let path: String
    let status: String
    let add: Int
    let del: Int
    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }
    var dir: String { (path as NSString).deletingLastPathComponent }
}

struct ChangesResponse: Decodable {
    let branch: String
    let staged: [FileChange]
    let unstaged: [FileChange]
}

struct CommitDetail: Decodable {
    let hash: String
    let author: String
    let email: String
    let at: Double
    let subject: String
    let body: String
    let merge: Bool
    let files: [FileChange]
}

struct PullRequestInfo: Decodable, Hashable {
    let number: Int
    let state: String
    let draft: Bool
    let checks: String?
}

struct BranchInfo: Decodable, Identifiable, Hashable {
    let name: String
    let subject: String
    let at: Double
    let current: Bool
    let ahead: Int
    let behind: Int
    let pr: PullRequestInfo?
    var id: String { name }
}

struct BranchesResponse: Decodable {
    let local: [BranchInfo]
    let remote: [BranchInfo]
}

struct TextResponse: Decodable { let text: String }

// MARK: - Look

enum GitStyle {
    private static var p: Palette { Palette.current }
    static var lanes: [Color] { [p.purple, p.orange, p.pink, p.cyan, p.blue, p.green, p.yellow, p.red].map { Color(hex: $0) } }
    static var added: Color { Color(hex: p.green) }
    static var removed: Color { Color(hex: p.red) }
    static var addedBg: Color { Color(hex: p.green).opacity(0.16) }
    static var removedBg: Color { Color(hex: p.red).opacity(0.18) }
    static var background: Color { Color(hex: p.isDark && p.name == "Hollr" ? 0x1E1F26 : p.bg) }

    static func statusColor(_ s: String) -> Color {
        switch s {
        case "A": return added
        case "D": return removed
        case "R": return Color(hex: 0x5AA9F0)
        default: return Color(hex: 0xB48CF2)
        }
    }

    /// "1d", "41d", "3h", "2mo" like Moshi
    static func age(_ epochMs: Double) -> String {
        let s = max(0, Date().timeIntervalSince1970 - epochMs / 1000)
        switch s {
        case ..<60: return String(localized: "jetzt")
        case ..<3600: return "\(Int(s / 60))m"
        case ..<86400: return "\(Int(s / 3600))h"
        case ..<(86400 * 60): return "\(Int(s / 86400))d"
        case ..<(86400 * 365): return "\(Int(s / (86400 * 30)))mo"
        default: return "\(Int(s / (86400 * 365)))y"
        }
    }
}

/// M / A / D badge
struct StatusBadge: View {
    let status: String
    var body: some View {
        Text(status == "?" ? "A" : status)
            .font(.system(.footnote, design: .monospaced).weight(.semibold))
            .foregroundStyle(GitStyle.statusColor(status))
            .frame(width: 26, height: 26)
            .background(GitStyle.statusColor(status).opacity(0.16), in: RoundedRectangle(cornerRadius: 7))
    }
}

struct PlusMinus: View {
    let add: Int
    let del: Int
    var body: some View {
        HStack(spacing: 6) {
            Text("+\(add)").foregroundStyle(GitStyle.added)
            Text("-\(del)").foregroundStyle(GitStyle.removed)
        }
        .font(.system(.footnote, design: .monospaced))
    }
}

// MARK: - Graph layout

/// One row of the history graph: lanes entering from the top, the node, lanes leaving at the bottom.
struct GraphRow: Identifiable {
    let commit: GraphCommit
    let node: Int
    /// lane index → hash expected there, before / after this commit
    let before: [String?]
    let after: [String?]
    /// lanes that end in this node (branch merged in from there)
    let incoming: [Int]
    /// lanes the node continues into (parents)
    let outgoing: [Int]
    var id: String { commit.hash }
    var width: Int { max(before.count, after.count, node + 1) }
}

enum GraphLayout {
    /// Classic lane assignment over topologically ordered commits.
    static func rows(_ commits: [GraphCommit], dirtyTop: Bool) -> [GraphRow] {
        var lanes: [String?] = dirtyTop ? commits.first.map { [$0.hash] } ?? [] : []
        var rows: [GraphRow] = []
        func freeSlot(excluding: Int? = nil) -> Int {
            if let i = lanes.indices.first(where: { lanes[$0] == nil && $0 != excluding }) { return i }
            lanes.append(nil)
            return lanes.count - 1
        }
        for commit in commits {
            let matches = lanes.indices.filter { lanes[$0] == commit.hash }
            let node: Int
            if let first = matches.first {
                node = first
            } else {
                node = freeSlot()
            }
            let before = lanes
            for i in matches where i != node { lanes[i] = nil }
            var outgoing: [Int] = []
            if let first = commit.parents.first {
                if let existing = lanes.indices.first(where: { lanes[$0] == first && $0 != node }), existing < node {
                    // the first parent already has a lane further left: join it
                    lanes[node] = nil
                    outgoing.append(existing)
                } else {
                    lanes[node] = first
                    outgoing.append(node)
                }
                for parent in commit.parents.dropFirst() {
                    if let k = lanes.firstIndex(where: { $0 == parent }) {
                        outgoing.append(k)
                    } else {
                        let k = freeSlot(excluding: node)
                        lanes[k] = parent
                        outgoing.append(k)
                    }
                }
            } else {
                lanes[node] = nil
            }
            while let last = lanes.last, last == nil { lanes.removeLast() }
            rows.append(GraphRow(commit: commit, node: node, before: before, after: lanes,
                                 incoming: matches.filter { $0 != node }, outgoing: outgoing))
        }
        return rows
    }
}

/// Draws one graph row (Canvas): straight pass-through lanes, curves into/out of the node.
struct GraphCell: View {
    let row: GraphRow
    let top: Bool
    static let lane: CGFloat = 16
    static let inset: CGFloat = 12

    static func x(_ i: Int) -> CGFloat { inset + CGFloat(i) * lane }

    var body: some View {
        Canvas { ctx, size in
            let h = size.height
            let mid = h / 2
            func color(_ i: Int) -> Color { GitStyle.lanes[i % GitStyle.lanes.count] }
            func line(_ from: CGPoint, _ to: CGPoint, _ c: Color) {
                var p = Path()
                p.move(to: from)
                if from.x == to.x {
                    p.addLine(to: to)
                } else {
                    // smooth S-curve between lanes
                    let midY = (from.y + to.y) / 2
                    p.addCurve(to: to, control1: CGPoint(x: from.x, y: midY), control2: CGPoint(x: to.x, y: midY))
                }
                ctx.stroke(p, with: .color(c), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }
            let nodePoint = CGPoint(x: Self.x(row.node), y: mid)
            // lanes passing by
            for (i, hash) in row.before.enumerated() {
                guard let hash else { continue }
                if hash == row.commit.hash {
                    line(CGPoint(x: Self.x(i), y: 0), nodePoint, color(i == row.node ? row.node : i))
                } else if i < row.after.count, row.after[i] == hash {
                    line(CGPoint(x: Self.x(i), y: 0), CGPoint(x: Self.x(i), y: h), color(i))
                } else if let k = row.after.firstIndex(where: { $0 == hash }) {
                    line(CGPoint(x: Self.x(i), y: 0), CGPoint(x: Self.x(k), y: h), color(k))
                }
            }
            // into the parents
            for k in row.outgoing {
                line(nodePoint, CGPoint(x: Self.x(k), y: h), color(k))
            }
            let r: CGFloat = row.commit.parents.count > 1 ? 4.5 : 5.5
            let dot = Path(ellipseIn: CGRect(x: nodePoint.x - r, y: mid - r, width: r * 2, height: r * 2))
            ctx.fill(dot, with: .color(color(row.node)))
        }
        .frame(width: Self.inset + CGFloat(row.width) * Self.lane)
    }
}

// MARK: - Syntax highlighting (lightweight, per line)

enum Syntax {
    private static var p: Palette { Palette.current }
    static var keyword: Color { Color(hex: p.pink) }
    static var string: Color { Color(hex: p.yellow) }
    static var comment: Color { Color(hex: p.dim) }
    static var number: Color { Color(hex: p.purple) }
    static var type: Color { Color(hex: p.cyan) }

    private static let keywords: Set<String> = [
        "import", "from", "export", "default", "const", "let", "var", "function", "return", "if", "else", "for",
        "while", "do", "class", "struct", "enum", "interface", "type", "func", "async", "await", "new", "case",
        "switch", "break", "continue", "true", "false", "null", "nil", "undefined", "self", "this", "def", "end",
        "in", "of", "as", "public", "private", "protected", "static", "throw", "throws", "try", "catch", "guard",
        "extends", "implements", "package", "fn", "pub", "use", "mod", "impl", "match", "where", "yield", "lambda",
        "None", "True", "False", "elif", "with", "pass", "raise", "and", "or", "not", "is", "readonly", "override",
    ]

    static func language(for path: String) -> String {
        (path as NSString).pathExtension.lowercased()
    }

    static func highlight(_ line: String, lang: String) -> AttributedString {
        var out = AttributedString()
        let chars = Array(line)
        var i = 0
        let hashComments = ["py", "sh", "bash", "zsh", "yml", "yaml", "toml", "rb", "env", "conf", "dockerfile"].contains(lang)
        func append(_ s: String, _ color: Color?) {
            var a = AttributedString(s)
            if let color { a.foregroundColor = color }
            out += a
        }
        var word = ""
        func flushWord() {
            guard !word.isEmpty else { return }
            if keywords.contains(word) {
                append(word, keyword)
            } else if word.first?.isNumber == true {
                append(word, number)
            } else if word.first?.isUppercase == true, lang != "md" {
                append(word, type)
            } else {
                append(word, nil)
            }
            word = ""
        }
        while i < chars.count {
            let c = chars[i]
            // comments
            if (c == "/" && i + 1 < chars.count && chars[i + 1] == "/") || (hashComments && c == "#") {
                flushWord()
                append(String(chars[i...]), comment)
                return out
            }
            // strings
            if c == "\"" || c == "'" || c == "`" {
                flushWord()
                var j = i + 1
                while j < chars.count, chars[j] != c {
                    if chars[j] == "\\" { j += 1 }
                    j += 1
                }
                let end = min(j, chars.count - 1)
                append(String(chars[i...end]), string)
                i = end + 1
                continue
            }
            if c.isLetter || c.isNumber || c == "_" || c == "$" {
                word.append(c)
            } else {
                flushWord()
                append(String(c), c == "{" || c == "}" || c == "(" || c == ")" || c == "[" || c == "]" || c == ";" || c == "," ? Omp.muted : nil)
            }
            i += 1
        }
        flushWord()
        return out
    }
}

// MARK: - File type icons

enum FileIcon {
    static func symbol(_ name: String, dir: Bool) -> (String, Color) {
        if dir { return ("folder.fill", Color(hex: 0x6CA6F0)) }
        let lower = name.lowercased()
        if lower.hasPrefix(".env") { return ("slider.horizontal.3", Color(hex: 0xE5C07B)) }
        if lower == ".gitignore" || lower == ".gitattributes" { return ("arrow.triangle.branch", Color(hex: 0xE0603A)) }
        if lower.hasPrefix("dockerfile") || lower == ".dockerignore" { return ("shippingbox.fill", Color(hex: 0x3B9DE0)) }
        switch (name as NSString).pathExtension.lowercased() {
        case "ts", "tsx", "mts", "cts": return ("t.square.fill", Color(hex: 0x3B82D6))
        case "js", "jsx", "mjs", "cjs": return ("j.square.fill", Color(hex: 0xE8C547))
        case "json", "jsonc": return ("curlybraces", Color(hex: 0xD9A441))
        case "md", "mdx": return ("m.square.fill", Color(hex: 0x5AA9F0))
        case "yml", "yaml": return ("list.bullet.rectangle.fill", Color(hex: 0xE05D5D))
        case "toml", "ini", "conf", "cfg": return ("gearshape.fill", Color(hex: 0x8B95A5))
        case "swift": return ("swift", Color(hex: 0xF0743E))
        case "py": return ("p.square.fill", Color(hex: 0x4B8BBE))
        case "rs": return ("r.square.fill", Color(hex: 0xDE7A4B))
        case "go": return ("g.square.fill", Color(hex: 0x4FC3D9))
        case "sh", "bash", "zsh": return ("terminal.fill", Color(hex: 0x7CC36E))
        case "css", "scss", "sass": return ("paintbrush.fill", Color(hex: 0x5AA9F0))
        case "html", "htm", "vue", "svelte": return ("chevron.left.forwardslash.chevron.right", Color(hex: 0xE5713E))
        case "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "heic": return ("photo.fill", Color(hex: 0xB48CF2))
        case "pdf": return ("doc.richtext.fill", Color(hex: 0xE05D5D))
        case "lock": return ("lock.fill", Color(hex: 0x8B95A5))
        case "sql", "prisma": return ("cylinder.fill", Color(hex: 0x5ED3C1))
        case "txt", "log": return ("doc.plaintext", Color(hex: 0x8B95A5))
        default: return ("doc.text", Color(hex: 0x6C9BD2))
        }
    }
}
