import SwiftUI

/// omp's TUI colors, taken from the current palette (Settings → Design).
enum Omp {
    private static var p: Palette { Palette.current }
    static var accent: Color { Color(hex: p.orange) }
    static var success: Color { Color(hex: p.green) }
    static var error: Color { Color(hex: p.red) }
    static var warning: Color { Color(hex: p.yellow) }
    static var muted: Color { Color(hex: p.muted) }
    static var dim: Color { Color(hex: p.dim) }
    static var border: Color { Color(hex: p.border) }
    static var pendingBg: Color { Color(hex: p.accent).opacity(0.08) }
    static var successBg: Color { Color(hex: p.raised) }
    static var errorBg: Color { Color(hex: p.red).opacity(0.14) }
    static var userBg: Color { Color(hex: p.orange).opacity(0.11) }
    static var code: Color { Color(hex: p.pink) }
    static var custom: Color { Color(hex: p.purple) }
    static let mono = Font.system(.footnote, design: .monospaced)
    static let monoSmall = Font.system(.caption, design: .monospaced)

    static func icon(for tool: String) -> String {
        switch tool {
        case "bash": return "❯"
        case "edit", "write": return "✎"
        case "read": return "≡"
        case "grep", "glob": return "⌕"
        case "task": return "⇶"
        case "todo": return "☑"
        case "ask": return "?"
        case "wait", "hub": return "⚙"
        case "web_search", "browser": return "◍"
        case "eval": return "λ"
        default: return "•"
        }
    }

    static func title(for tool: String) -> String {
        switch tool {
        case "web_search": return "Search"
        default:
            if tool.hasPrefix("mcp__") { return tool.split(separator: "_").last.map(String.init) ?? tool }
            return tool.prefix(1).uppercased() + tool.dropFirst()
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// Braille spinner like omp's status frames.
struct BrailleSpinner: View {
    var color: Color = Omp.accent
    private static let frames = Array("⣾⣽⣻⢿⡿⣟⣯⣷")

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.09)) { context in
            let i = Int(context.date.timeIntervalSinceReferenceDate / 0.09) % Self.frames.count
            Text(String(Self.frames[i])).font(Omp.mono).foregroundStyle(color)
        }
    }
}

// MARK: - Rows (omp's TUI rules: packages/tui/src/chat + tools/*)

struct TimelineRow: View, Equatable {
    let item: TimelineItem
    var onAnswer: (Int, Int) -> Void = { _, _ in }

    static func == (a: TimelineRow, b: TimelineRow) -> Bool { a.item == b.item }

    var body: some View {
        switch item {
        case let .user(_, text, _, _):
            UserRow(text: text)
        case let .thinking(_, text):
            ThinkingRow(text: text)
        case let .text(_, text):
            AgentMarkdown(text: text, plain: true)
        case let .tools(_, calls):
            ToolsBlock(calls: calls)
        case let .ask(_, question, options, answer, pending):
            AskCard(question: question, options: options, answer: answer, pending: pending) { index in
                onAnswer(index, options.count)
            }
        case let .end(_, _, status, error):
            // omp shows no "done" marker, only aborts and errors
            if status != "done" { EndRow(status: status, error: error) }
        case let .info(_, text):
            Text(text).font(.caption).foregroundStyle(Omp.dim).frame(maxWidth: .infinity)
        }
    }
}

/// Full-width tinted block, no prefix (user-message.ts).
struct UserRow: View {
    let text: String

    var body: some View {
        Text(text)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Omp.userBg, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// Italic, muted prose; code blocks dropped like omp's proseOnlyThinking. Long thoughts fold to 3 lines.
struct ThinkingRow: View {
    let text: String
    @State private var open = false

    var body: some View {
        let prose = Self.prose(text)
        Text(prose)
            .font(.subheadline.italic())
            .foregroundStyle(Omp.muted)
            .lineLimit(open ? nil : 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.snappy) { open.toggle() } }
    }

    static func prose(_ text: String) -> String {
        var out: [String] = []
        var inFence = false
        for line in text.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if !inFence, let last = out.indices.last { out[last] += "..." }
                inFence.toggle()
                continue
            }
            if !inFence, !line.trimmingCharacters(in: .whitespaces).isEmpty { out.append(line) }
        }
        return out.joined(separator: "\n")
    }
}

/// Renders one run of tool calls the way omp does: each call on its own,
/// read/grep/glob as compact lines (consecutive reads merged), bash & edits as framed cards.
struct ToolsBlock: View {
    let calls: [ToolCall]

    private enum Piece: Identifiable {
        case reads([ToolCall])
        case call(ToolCall)
        var id: String {
            switch self {
            case let .reads(c): return "r-" + (c.first?.id ?? "")
            case let .call(c): return c.id
            }
        }
    }

    private var pieces: [Piece] {
        var out: [Piece] = []
        for call in calls {
            if call.name == "read", case let .reads(group)? = out.last {
                out[out.count - 1] = .reads(group + [call])
            } else if call.name == "read" {
                out.append(.reads([call]))
            } else {
                out.append(.call(call))
            }
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(pieces) { piece in
                switch piece {
                case let .reads(group): ReadLines(calls: group)
                case let .call(call): ToolView(call: call)
                }
            }
        }
    }
}

private struct ToolView: View {
    let call: ToolCall

    var body: some View {
        switch call.name {
        case "bash", "eval": BashCard(call: call)
        case "grep", "glob", "find", "todo", "wait": CompactToolLine(call: call)
        case "edit", "write", "task", "web_search": HeaderCard(call: call)
        default:
            if call.name.hasPrefix("mcp__") { CompactToolLine(call: call) } else { GenericTool(call: call) }
        }
    }
}

/// Status glyph: spinner while running, ✘ on error, else the given symbol.
private struct StatusGlyph: View {
    let call: ToolCall
    var ok: String = "✔"
    var okColor: Color = Omp.success

    var body: some View {
        switch call.status {
        case "running": BrailleSpinner()
        case "error": Text("✘").foregroundStyle(Omp.error)
        default: Text(ok).foregroundStyle(okColor)
        }
    }
}

/// `● Read path:sel` or `• Read (3)` with a tree of paths.
private struct ReadLines: View {
    let calls: [ToolCall]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if calls.count == 1, let call = calls.first {
                HStack(spacing: 6) {
                    StatusGlyph(call: call, ok: "●", okColor: .primary.opacity(0.85))
                    Text("Read").bold()
                    Text(Self.short(call.detail)).foregroundStyle(Omp.accent).lineLimit(1).truncationMode(.middle)
                }
            } else {
                HStack(spacing: 6) {
                    if let running = calls.first(where: { $0.status == "running" }) {
                        StatusGlyph(call: running)
                    } else {
                        Text("•").foregroundStyle(calls.contains { $0.status == "error" } ? Omp.error : .primary)
                    }
                    Text("Read").bold()
                    Text("(\(calls.count))").foregroundStyle(Omp.dim)
                }
                ForEach(Array(calls.enumerated()), id: \.element.id) { index, call in
                    HStack(spacing: 6) {
                        Text(index == calls.count - 1 ? "└─" : "├─").foregroundStyle(Omp.dim)
                        Text(Self.short(call.detail))
                            .foregroundStyle(call.status == "error" ? Omp.error : Omp.accent)
                            .lineLimit(1).truncationMode(.middle)
                    }
                    .padding(.leading, 14)
                }
            }
        }
        .font(Omp.monoSmall)
        .padding(.horizontal, 4)
    }

    static func short(_ path: String?) -> String {
        guard let path else { return "" }
        return path.replacingOccurrences(of: #"^/home/[^/]+"#, with: "~", options: .regularExpression)
    }
}

/// `⌕ Grep: pattern 6 Treffer · in path` – one unframed line (+ error text).
private struct CompactToolLine: View {
    let call: ToolCall

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                StatusGlyph(call: call, ok: Omp.icon(for: call.name), okColor: Omp.muted)
                (Text(Omp.title(for: call.name)).bold().foregroundColor(.primary)
                    + Text(call.detail.map { ": \($0)" } ?? "").foregroundColor(Omp.muted)
                    + Text(meta).foregroundColor(Omp.dim))
                    .lineLimit(2)
            }
            if call.status == "error", let result = call.result {
                Text(result).foregroundStyle(Omp.error).lineLimit(3).padding(.leading, 18)
            }
        }
        .font(Omp.monoSmall)
        .padding(.horizontal, 4)
    }

    private var meta: String {
        var parts: [String] = []
        if call.status != "error", let result = call.result { parts.append(result) }
        if let path = call.path { parts.append("in " + ReadLines.short(path)) }
        return parts.isEmpty ? "" : "  " + parts.joined(separator: " · ")
    }
}

/// Rounded frame tinted by state, like omp's output-block.
private struct ToolFrame<Content: View>: View {
    let call: ToolCall
    var muted = false
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) { content }
            .font(Omp.monoSmall)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(border, lineWidth: 1))
    }

    private var background: Color {
        switch call.status {
        case "running": return Omp.pendingBg
        case "error": return Omp.errorBg
        default: return Omp.successBg
        }
    }

    private var border: Color {
        switch call.status {
        case "running": return Omp.accent.opacity(0.7)
        case "error": return Omp.error.opacity(0.8)
        default: return muted ? Omp.border.opacity(0.6) : Omp.dim.opacity(0.7)
        }
    }
}

/// bash: no header, `$ command`, output tail, `⟨Wall: 2.93s⟩`.
private struct BashCard: View {
    let call: ToolCall
    @State private var expanded = false

    private var shown: Int { expanded ? 12 : 4 }

    var body: some View {
        ToolFrame(call: call) {
            if call.name == "eval" {
                HStack(spacing: 6) {
                    StatusGlyph(call: call, ok: "•", okColor: Omp.accent)
                    Text(call.detail ?? "Eval").bold().lineLimit(1)
                }
            } else {
                (Text("$ ").foregroundColor(Omp.dim) + Text(call.detail ?? "").foregroundColor(.primary))
                    .lineLimit(expanded ? 12 : 3)
            }
            if let out = call.out, !out.isEmpty {
                let tail = Array(out.suffix(shown))
                let hidden = (call.outTotal ?? out.count) - tail.count
                Divider().overlay(Omp.border)
                if hidden > 0 {
                    Text("… (\(hidden) earlier lines, showing \(tail.count) of \(call.outTotal ?? out.count))")
                        .foregroundStyle(Omp.dim)
                }
                Text(tail.joined(separator: "\n"))
                    .foregroundStyle(call.status == "error" ? Omp.error : Omp.muted)
                    .lineLimit(expanded ? nil : shown * 2)
                    .textSelection(.enabled)
            } else if call.status == "error", let result = call.result {
                Text(result).foregroundStyle(Omp.error).lineLimit(4)
            }
            footer
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.snappy) { expanded.toggle() } }
    }

    @ViewBuilder private var footer: some View {
        if call.status == "running" {
            HStack(spacing: 6) { BrailleSpinner(); Text("läuft").foregroundStyle(Omp.muted) }
        } else {
            let parts = [
                call.ms.map { "Wall: " + String(format: "%.2fs", $0 / 1000) },
                call.exit.map { "Exit: \($0)" },
                call.bg.map { "Backgrounded: \($0)" },
            ].compactMap { $0 }
            if !parts.isEmpty {
                Text("⟨\(parts.joined(separator: " | "))⟩").foregroundStyle(call.exit != nil ? Omp.error : Omp.dim)
            }
        }
    }
}

/// edit/write/task/web: framed header line only (`✎ Edit: path ⟦+3/-1⟧`).
private struct HeaderCard: View {
    let call: ToolCall

    var body: some View {
        ToolFrame(call: call, muted: true) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                StatusGlyph(call: call, ok: Omp.icon(for: call.name), okColor: Omp.accent)
                (Text(Omp.title(for: call.name)).bold().foregroundColor(.primary)
                    + Text(call.detail.map { ": " + ReadLines.short($0) } ?? "").foregroundColor(Omp.accent))
                    .lineLimit(2).truncationMode(.middle)
                Spacer(minLength: 4)
                if (call.add ?? 0) + (call.del ?? 0) > 0 {
                    (Text("⟦").foregroundColor(Omp.dim) + Text("+\(call.add ?? 0)").foregroundColor(Omp.success)
                        + Text("/").foregroundColor(Omp.dim) + Text("-\(call.del ?? 0)").foregroundColor(Omp.error)
                        + Text("⟧").foregroundColor(Omp.dim))
                }
            }
            if call.status == "error", let result = call.result {
                Text(result).foregroundStyle(Omp.error).lineLimit(4)
            }
        }
    }
}

/// Fallback: `• Name` and ` └─ args` dim.
private struct GenericTool: View {
    let call: ToolCall

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                StatusGlyph(call: call, ok: "•", okColor: .primary)
                Text(Omp.title(for: call.name)).bold()
            }
            if let detail = call.detail {
                Text(" └─ \(detail)").foregroundStyle(Omp.dim).lineLimit(1).truncationMode(.tail)
            }
            if call.status == "error", let result = call.result {
                Text(result).foregroundStyle(Omp.error).lineLimit(3)
            }
        }
        .font(Omp.monoSmall)
        .padding(.horizontal, 4)
    }
}

struct AskCard: View {
    let question: String
    let options: [String]
    let answer: String?
    let pending: Bool
    let onPick: (Int) -> Void
    /// marked right away on tap – omp's confirmation follows with the next refresh
    @State private var picked: Int?
    private var open: Bool { pending && picked == nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("?").font(Omp.mono.weight(.bold)).foregroundStyle(Omp.accent)
                Text(pending ? String(localized: "Ask – omp wartet auf dich") : String(localized: "Ask"))
                    .font(Omp.monoSmall.weight(.semibold)).foregroundStyle(pending ? Omp.warning : .primary)
            }
            Text(question).font(.body)
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                Button { if open { picked = index; onPick(index) } } label: {
                    HStack(spacing: 8) {
                        Text(answer?.contains(option) == true || picked == index ? "◉" : "○").foregroundStyle(Omp.accent)
                        Text(option).foregroundStyle(.primary).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    .font(.subheadline)
                    .padding(.vertical, 8).padding(.horizontal, 10)
                    .background(open ? Omp.pendingBg : picked == index ? Omp.pendingBg.opacity(0.5) : .clear,
                                in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(!open)
            }
            if open {
                // omp's own last entry "Other (type your own)": select it, then type the answer below
                Button { picked = options.count; onPick(options.count) } label: {
                    HStack(spacing: 8) {
                        Text("✎").foregroundStyle(Omp.accent)
                        Text("Eigene Antwort – danach unten eintippen").foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }
                    .font(.subheadline)
                    .padding(.vertical, 8).padding(.horizontal, 10)
                }
                .buttonStyle(.plain)
            }
            if let answer {
                Text("✔ \(answer)").font(Omp.monoSmall).foregroundStyle(answer == "abgebrochen" ? Omp.warning : Omp.success)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Omp.successBg, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(pending ? Omp.warning.opacity(0.7) : Omp.border.opacity(0.6)))
    }
}

struct EndRow: View {
    let status: String
    let error: String?

    var body: some View {
        Group {
            if status == "aborted" {
                Text("⏹ Abgebrochen").foregroundStyle(Omp.warning)
            } else {
                Text("Error: \(error ?? "unbekannt")").foregroundStyle(Omp.error).lineLimit(8)
            }
        }
        .font(Omp.monoSmall)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }
}

// MARK: - Above the editor (interactive-mode.ts: todo HUD, working row)

/// omp's pinned area: TODO tree, background jobs and the working row with the current intent.
struct AgentHUD: View {
    let timeline: Timeline
    @State private var todoOpen = false

    static func isVisible(_ timeline: Timeline) -> Bool {
        timeline.running || !timeline.jobs.isEmpty || openPhase(timeline) != nil
    }

    /// omp clears the TODO once everything is closed.
    static func openPhase(_ timeline: Timeline) -> TodoPhase? {
        timeline.todo?.first { $0.tasks.contains { !$0.isClosed } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let phase = Self.openPhase(timeline) { todo(phase) }
            if !timeline.jobs.isEmpty || timeline.running { activity }
        }
        .font(Omp.monoSmall)
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func todo(_ active: TodoPhase) -> some View {
        let phases = timeline.todo ?? []
        let numbered = phases.count > 1
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text("TODO").bold().foregroundStyle(Omp.accent)
                if !todoOpen {
                    Text(name(active, in: phases, numbered: numbered)).foregroundStyle(Omp.accent).lineLimit(1)
                    Text("· \(active.done)/\(active.tasks.count)").foregroundStyle(Omp.dim)
                }
                Spacer(minLength: 0)
                Image(systemName: todoOpen ? "chevron.down" : "chevron.up").font(.caption2).foregroundStyle(Omp.dim)
            }
            if todoOpen {
                ForEach(phases) { phase in
                    let isActive = phase.name == active.name
                    HStack(spacing: 6) {
                        Text("├─").foregroundStyle(Omp.dim)
                        Text(name(phase, in: phases, numbered: numbered))
                            .fontWeight(isActive ? .bold : .regular)
                            .foregroundStyle(isActive ? Omp.accent : Omp.muted)
                        Text("· \(phase.done)/\(phase.tasks.count)").foregroundStyle(Omp.dim)
                    }
                    if isActive {
                        ForEach(phase.tasks) { task in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("│ ").foregroundStyle(Omp.dim)
                                TodoRow(task: task)
                            }
                        }
                    }
                }
                Text("└─────").foregroundStyle(Omp.dim)
            } else {
                ForEach(active.tasks.filter { $0.status == "in_progress" }.prefix(2)) { task in
                    TodoRow(task: task).padding(.leading, 4)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.snappy) { todoOpen.toggle() } }
    }

    private func name(_ phase: TodoPhase, in phases: [TodoPhase], numbered: Bool) -> String {
        guard numbered, let i = phases.firstIndex(where: { $0.name == phase.name }) else { return phase.name }
        let roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]
        return (i < roman.count ? roman[i] + ". " : "") + phase.name
    }

    private var activity: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(alignment: .leading, spacing: 3) {
                ForEach(timeline.jobs) { job in
                    HStack(spacing: 6) {
                        Text("⚙").foregroundStyle(Omp.accent)
                        Text(job.id).foregroundStyle(Omp.accent)
                        Text(job.label).foregroundStyle(Omp.dim).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 4)
                        Text(Durations.since(job.startedAt, now: context.date)).foregroundStyle(Omp.dim)
                    }
                }
                if timeline.running {
                    HStack(spacing: 6) {
                        BrailleSpinner()
                        Text(timeline.waiting ? String(localized: "wartet auf Hintergrund-Jobs") : timeline.workingLabel ?? String(localized: "Working…"))
                            .foregroundStyle(Omp.accent).lineLimit(1)
                        Spacer(minLength: 4)
                        if let start = timeline.turnStartedAt {
                            Text(Durations.since(start, now: context.date)).foregroundStyle(Omp.dim)
                        }
                    }
                }
            }
        }
    }
}

struct TodoRow: View {
    let task: TodoTask

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(task.status == "completed" ? "☑" : "☐").foregroundStyle(color)
            Text(task.content + (task.status == "blocked" ? " (blocked)" : ""))
                .strikethrough(task.status == "completed" || task.status == "abandoned", color: color)
                .foregroundStyle(color)
                .lineLimit(2)
        }
        .font(Omp.monoSmall)
    }

    private var color: Color {
        switch task.status {
        case "completed": return Omp.success
        case "in_progress": return Omp.accent
        case "abandoned": return Omp.error
        case "blocked": return Omp.warning
        default: return Omp.dim
        }
    }
}
