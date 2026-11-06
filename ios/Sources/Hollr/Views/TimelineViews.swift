import SwiftUI

/// How a tool looks in the chat: its line icon (SF Symbol) and its title.
private enum ToolLook {
    static func symbol(for tool: String) -> String {
        switch tool {
        case "bash": return HIcon.terminal.symbol
        case "edit", "write": return HIcon.pencil.symbol
        case "read": return HIcon.file.symbol
        case "grep", "glob", "find": return HIcon.search.symbol
        case "task": return "square.stack"
        case "todo": return "checklist"
        case "ask": return HIcon.help.symbol
        case "wait", "hub": return "gearshape"
        case "web_search", "browser": return HIcon.globe.symbol
        case "eval": return "function"
        default: return "circle"
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

    static func state(_ status: String) -> ToolStepRow.StepState {
        switch status {
        case "running": return .running
        case "error": return .error
        default: return .done
        }
    }

    /// Paths under the server user's home as `~/…`.
    static func short(_ path: String?) -> String {
        guard let path else { return "" }
        return path.replacingOccurrences(of: #"^/home/[^/]+"#, with: "~", options: .regularExpression)
    }
}

// MARK: - Rows (Sitzung: user bubble, Gedanken, markdown, flat tool steps, ask card)

struct TimelineRow: View, Equatable {
    let item: TimelineItem
    /// answers omp's question (ask id, one pick per question); false = not sent
    var onAnswer: (String, [AskPick]) async -> Bool = { _, _ in false }

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
        case let .ask(id, questions, answer, pending):
            AskCard(id: id, questions: questions, answer: answer, pending: pending, onSubmit: onAnswer)
        case let .end(_, _, status, error):
            // omp shows no "done" marker, only aborts and errors
            if status != "done" { EndRow(status: status, error: error) }
        case let .info(_, text):
            Text(text).font(Typo.sm).foregroundStyle(Theme.dim).frame(maxWidth: .infinity)
        }
    }
}

/// Your message: right-aligned bubble on the card fill (sess__user, at most ~92 % wide on the phone).
struct UserRow: View {
    let text: String

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: Gap.xxl)
            Text(text)
                .textSelection(.enabled)
                .userBubbleStyle()
        }
    }
}

/// One dim line "Gedanken · …"; a tap opens the thought as a muted block with a border on the left.
/// Code blocks are dropped like omp's proseOnlyThinking.
struct ThinkingRow: View {
    let text: String
    @State private var open = false

    var body: some View {
        let prose = Self.prose(text)
        Group {
            if open {
                VStack(alignment: .leading, spacing: Gap.xs) {
                    Text("Gedanken ausblenden").font(Typo.sm).foregroundStyle(Theme.dim)
                    Text(prose)
                        .font(Typo.md)
                        .foregroundStyle(Theme.muted)
                        .lineSpacing(3)
                        .textSelection(.enabled)
                }
                .padding(.vertical, 2).padding(.leading, Gap.m)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 2) }
            } else {
                Text("Gedanken · \(prose.replacingOccurrences(of: "\n", with: " "))")
                    .font(Typo.note)
                    .foregroundStyle(Theme.dim)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.snappy) { open.toggle() } }
        .accessibilityAddTraits(.isButton)
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

/// One run of tool calls as flat steps (molecule ToolCard): consecutive reads merged into one step,
/// output, matches and errors fold open under their step.
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

    @AppStorage("chat.compactTools") private var compact = true
    @State private var expanded = false

    /// Finished groups of several calls fold into one line – the chat reads like a conversation;
    /// running ones and errors stay open.
    private var folds: Bool {
        compact && !expanded && calls.count > 2 && !calls.contains { $0.status == "running" || $0.status == "error" }
    }

    var body: some View {
        Group {
            if folds {
                Button { withAnimation(.easeInOut(duration: 0.2)) { expanded = true } } label: { summary }
                    .buttonStyle(.plain)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    if compact && expanded {
                        Button { withAnimation(.easeInOut(duration: 0.2)) { expanded = false } } label: {
                            ToolStepRow(symbol: "chevron.up", name: String(localized: "Zuklappen"))
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(pieces) { piece in
                        switch piece {
                        case let .reads(group): ReadStep(calls: group)
                        case let .call(call): ToolView(call: call)
                        }
                    }
                }
            }
        }
        // the step icons line up with the text above (sess__tools)
        .padding(.horizontal, -Gap.s)
    }

    /// "12 Werkzeuge · 3 Dateien geändert +40 −12" as one flat step.
    private var summary: some View {
        let edits = calls.filter { $0.name == "edit" || $0.name == "write" }
        let files = Set(edits.compactMap { $0.path ?? $0.detail }).count
        let add = calls.compactMap(\.add).reduce(0, +), del = calls.compactMap(\.del).reduce(0, +)
        return HStack(spacing: Gap.s) {
            Image(systemName: "wrench.and.screwdriver")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.dim)
                .frame(width: 16)
            Text("\(calls.count) Werkzeuge").foregroundStyle(Theme.fg).lineLimit(1)
            if files > 0 {
                Text("· \(files) \(files == 1 ? String(localized: "Datei") : String(localized: "Dateien")) geändert")
                    .foregroundStyle(Theme.dim).lineLimit(1)
            }
            Spacer(minLength: Gap.xs)
            if add + del > 0 {
                Text("+\(add)").foregroundStyle(Theme.green)
                Text("−\(del)").foregroundStyle(Theme.red)
            }
            Image(systemName: HIcon.chevronRight.symbol)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Theme.dim)
        }
        .font(Typo.monoSmall)
        .padding(.vertical, 5).padding(.horizontal, Gap.s)
        .frame(minHeight: 30)
        .contentShape(Rectangle())
    }
}

/// A flat step that opens its body (output, matches, error) on tap.
private struct ToolStep<Content: View>: View {
    let symbol: String
    let name: String
    var detail: String? = nil
    var meta: String? = nil
    var state: ToolStepRow.StepState = .done
    /// there is something to open
    var expandable = false
    @ViewBuilder var content: () -> Content
    @State private var open: Bool

    init(symbol: String, name: String, detail: String? = nil, meta: String? = nil, state: ToolStepRow.StepState = .done,
         expandable: Bool = false, startsOpen: Bool = false, @ViewBuilder content: @escaping () -> Content) {
        self.symbol = symbol
        self.name = name
        self.detail = detail
        self.meta = meta
        self.state = state
        self.expandable = expandable
        self.content = content
        _open = State(initialValue: startsOpen)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if expandable {
                Button { withAnimation(.snappy) { open.toggle() } } label: { row(expanded: open) }
                    .buttonStyle(.plain)
                if open {
                    VStack(alignment: .leading, spacing: 6) { content() }.toolBodyStyle()
                }
            } else {
                row(expanded: nil)
            }
        }
    }

    private func row(expanded: Bool?) -> some View {
        ToolStepRow(symbol: state == .error ? HIcon.alert.symbol : symbol, name: name, detail: detail, meta: meta,
                    state: state, expanded: expanded)
    }
}

private struct ToolView: View {
    let call: ToolCall

    var body: some View {
        switch call.name {
        case "bash", "eval": BashStep(call: call)
        case "grep", "glob", "find", "todo", "wait": CompactStep(call: call)
        case "edit", "write", "task", "web_search": HeaderStep(call: call)
        default:
            if call.name.hasPrefix("mcp__") { CompactStep(call: call) } else { GenericStep(call: call) }
        }
    }
}

/// The error text under a failed step.
private struct ErrorText: View {
    let text: String
    var body: some View { Text(text).foregroundStyle(Theme.red).lineLimit(8).textSelection(.enabled) }
}

/// `Read path` – several reads in a row as one step with the paths in its body.
private struct ReadStep: View {
    let calls: [ToolCall]

    var body: some View {
        let state: ToolStepRow.StepState = calls.contains { $0.status == "running" } ? .running
            : calls.contains { $0.status == "error" } ? .error : .done
        if calls.count == 1, let call = calls.first {
            let error = call.status == "error" ? call.result : nil
            ToolStep(symbol: ToolLook.symbol(for: "read"), name: "Read", detail: ToolLook.short(call.detail),
                     state: state, expandable: error != nil, startsOpen: error != nil) {
                if let error { ErrorText(text: error) }
            }
        } else {
            ToolStep(symbol: ToolLook.symbol(for: "read"), name: "Read",
                     detail: String(localized: "\(calls.count) Dateien"), state: state,
                     expandable: true, startsOpen: state == .error) {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(calls) { call in
                        Text(ToolLook.short(call.detail))
                            .foregroundStyle(call.status == "error" ? Theme.red : Theme.muted)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
            }
        }
    }
}

/// `Grep pattern · 6 Treffer` – the scope and errors in the body.
private struct CompactStep: View {
    let call: ToolCall

    var body: some View {
        let error = call.status == "error" ? call.result : nil
        let detail = [call.detail, error == nil ? call.result : nil].compactMap { $0 }.joined(separator: " · ")
        ToolStep(symbol: ToolLook.symbol(for: call.name), name: ToolLook.title(for: call.name),
                 detail: detail, state: ToolLook.state(call.status),
                 expandable: call.path != nil || error != nil, startsOpen: error != nil) {
            if let path = call.path { Text("in \(ToolLook.short(path))").foregroundStyle(Theme.muted) }
            if let error { ErrorText(text: error) }
        }
    }
}

/// bash / eval: the command, its time or exit code; the output tail in the body (diffs tinted).
private struct BashStep: View {
    let call: ToolCall

    var body: some View {
        let isEval = call.name == "eval"
        let hasOut = !(call.out ?? []).isEmpty
        let failed = call.status == "error"
        ToolStep(symbol: ToolLook.symbol(for: call.name), name: isEval ? ToolLook.title(for: "eval") : "Bash",
                 detail: call.detail, meta: meta, state: ToolLook.state(call.status),
                 expandable: true, startsOpen: call.status == "running" || failed) {
            if !isEval, let command = call.detail {
                (Text("$ ").foregroundColor(Theme.dim) + Text(command).foregroundColor(Theme.fg))
                    .textSelection(.enabled)
            }
            if let out = call.out, !out.isEmpty {
                let hidden = (call.outTotal ?? out.count) - out.count
                if hidden > 0 {
                    Text("… (\(hidden) earlier lines, showing \(out.count) of \(call.outTotal ?? out.count))")
                        .foregroundStyle(Theme.dim)
                }
                OutputLines(lines: out, failed: failed)
            } else if failed, let result = call.result {
                ErrorText(text: result)
            }
            if call.status == "running", !hasOut {
                Text("läuft").foregroundStyle(Theme.muted)
            }
            if !footer.isEmpty {
                Text(footer).foregroundStyle(call.exit != nil ? Theme.red : Theme.dim)
            }
        }
    }

    private var meta: String? {
        if let exit = call.exit { return "Exit \(exit)" }
        return call.ms.map { Durations.format(ms: $0) }
    }

    private var footer: String {
        [
            call.ms.map { "Wall: " + String(format: "%.2fs", $0 / 1000) },
            call.exit.map { "Exit: \($0)" },
            call.bg.map { "Backgrounded: \($0)" },
        ].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Command output; a unified diff (git diff …) gets the green/red line washes of tool-card__dl.
private struct OutputLines: View {
    let lines: [String]
    let failed: Bool

    private var isDiff: Bool { lines.contains { $0.hasPrefix("@@") || $0.hasPrefix("diff --git") } }

    var body: some View {
        if isDiff {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    let kind = Self.kind(line)
                    Text(line.isEmpty ? " " : line)
                        .foregroundStyle(kind == .add ? Theme.green : kind == .del ? Theme.red : Theme.dim)
                        .lineLimit(1)
                        .padding(.horizontal, Gap.s)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(kind == .add ? Theme.green.opacity(0.12) : kind == .del ? Theme.red.opacity(0.12) : .clear)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
            .textSelection(.enabled)
        } else {
            Text(lines.joined(separator: "\n"))
                .foregroundStyle(failed ? Theme.red : Theme.muted)
                .textSelection(.enabled)
        }
    }

    private enum Kind { case add, del, ctx }

    private static func kind(_ line: String) -> Kind {
        if line.hasPrefix("+"), !line.hasPrefix("+++") { return .add }
        if line.hasPrefix("-"), !line.hasPrefix("---") { return .del }
        return .ctx
    }
}

/// edit / write / task / web: `Edit path +3 −1`.
private struct HeaderStep: View {
    let call: ToolCall

    var body: some View {
        let error = call.status == "error" ? call.result : nil
        let changed = (call.add ?? 0) + (call.del ?? 0) > 0
        ToolStep(symbol: ToolLook.symbol(for: call.name), name: ToolLook.title(for: call.name),
                 detail: ToolLook.short(call.detail), meta: changed ? "+\(call.add ?? 0) −\(call.del ?? 0)" : nil,
                 state: ToolLook.state(call.status), expandable: error != nil, startsOpen: error != nil) {
            if let error { ErrorText(text: error) }
        }
    }
}

/// Any other tool: its name and arguments.
private struct GenericStep: View {
    let call: ToolCall

    var body: some View {
        let error = call.status == "error" ? call.result : nil
        ToolStep(symbol: ToolLook.symbol(for: call.name), name: ToolLook.title(for: call.name), detail: call.detail,
                 state: ToolLook.state(call.status), expandable: error != nil, startsOpen: error != nil) {
            if let error { ErrorText(text: error) }
        }
    }
}

/// omp's question (molecule AskCard): orange head, numbered options, own answer, send.
struct AskCard: View {
    let id: String
    let questions: [AskQuestion]
    let answer: String?
    let pending: Bool
    let onSubmit: (String, [AskPick]) async -> Bool
    /// what you picked, shown right away – omp's confirmation follows with the next refresh
    @State private var picks: [AskPick]
    @State private var sending = false
    @State private var sent = false

    init(id: String, questions: [AskQuestion], answer: String?, pending: Bool,
         onSubmit: @escaping (String, [AskPick]) async -> Bool) {
        self.id = id
        self.questions = questions
        self.answer = answer
        self.pending = pending
        self.onSubmit = onSubmit
        _picks = State(initialValue: Array(repeating: AskPick(), count: questions.count))
    }

    private var open: Bool { pending && !sent && !sending }
    /// every single-choice question has its answer (multi-select may stay empty, like in omp)
    private var complete: Bool {
        zip(questions, picks).allSatisfy { q, p in
            q.multi || !p.options.isEmpty || !p.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: Gap.s) {
                IconView(.help, size: 14)
                Text(pending ? String(localized: "Ask – omp wartet auf dich") : String(localized: "Ask"))
                if questions.count == 1, let header = questions.first?.header {
                    Text("· \(header)").lineLimit(1)
                }
            }
            .font(Typo.sm.weight(.semibold))
            .foregroundStyle(Theme.orange)
            ForEach(Array(questions.enumerated()), id: \.offset) { qi, q in
                questionBlock(qi, q)
            }
            if pending && !sent {
                if questions.answeredByTap {
                    Label("Eigene Antwort? Einfach unten eintippen.", icon: .pencil)
                        .font(Typo.sm).foregroundStyle(Theme.dim)
                } else {
                    HStack {
                        Spacer(minLength: 0)
                        Button { submit() } label: {
                            HStack(spacing: 6) {
                                if sending { Spinner(color: Theme.onAccent, size: 12) }
                                Text("Antworten senden")
                            }
                        }
                        .buttonStyle(.hollr(.primary, small: true))
                        .disabled(!complete || sending)
                    }
                }
            }
            if let answer {
                Label(answer, icon: .check)
                    .font(Typo.sm)
                    .foregroundStyle(answer == "abgebrochen" ? Theme.yellow : Theme.green)
            }
        }
        .askCardStyle()
    }

    @ViewBuilder private func questionBlock(_ qi: Int, _ q: AskQuestion) -> some View {
        if questions.count > 1 {
            HStack(spacing: 6) {
                Text("\(qi + 1).").font(Typo.monoSmall.weight(.bold)).foregroundStyle(Theme.orange)
                if let header = q.header { Text(header).font(Typo.sm).foregroundStyle(Theme.muted).lineLimit(1) }
                if q.multi { Text("mehrere möglich").font(Typo.xs).foregroundStyle(Theme.dim) }
            }
            .padding(.top, qi == 0 ? 0 : 6)
        } else if q.multi {
            Text("mehrere möglich").font(Typo.xs).foregroundStyle(Theme.dim)
        }
        Text(q.question).font(Typo.md.weight(.semibold))
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(q.options.enumerated()), id: \.offset) { index, option in
                let chosen = picks[qi].options.contains(index) || answer?.contains(option) == true
                Button { tap(qi, index) } label: {
                    // omp's explanation of the option (only while you still have to choose)
                    OptionRow(index: index, label: option, detail: open ? q.description(index) : nil,
                              recommended: index == q.recommended, selected: chosen)
                }
                .buttonStyle(.plain)
                .disabled(!open)
                .accessibilityAddTraits(chosen ? .isSelected : [])
            }
        }
        if open && !questions.answeredByTap {
            // omp's own last row "Other (type your own)"
            TextField("Eigene Antwort …", text: Binding(get: { picks[qi].text }, set: { text in
                picks[qi].text = text
                if !q.multi && !text.trimmingCharacters(in: .whitespaces).isEmpty { picks[qi].options = [] }
            }), axis: .vertical)
                .lineLimit(1...3)
                .fieldStyle()
        }
    }

    private func tap(_ qi: Int, _ index: Int) {
        if questions.answeredByTap {
            picks[qi] = AskPick(options: [index])
            submit()
        } else if questions[qi].multi {
            if picks[qi].options.remove(index) == nil { picks[qi].options.insert(index) }
        } else {
            picks[qi] = AskPick(options: [index])
        }
    }

    private func submit() {
        sending = true
        Task {
            let ok = await onSubmit(id, picks)
            sending = false
            sent = ok
            // not sent: choose again
            if !ok && questions.answeredByTap { picks = Array(repeating: AskPick(), count: questions.count) }
        }
    }
}

struct EndRow: View {
    let status: String
    let error: String?

    var body: some View {
        Group {
            if status == "aborted" {
                Label("Abgebrochen", icon: .stop).foregroundStyle(Theme.yellow)
            } else {
                Label { Text("Error: \(error ?? "unbekannt")").lineLimit(8) } icon: { Image(HIcon.alert) }
                    .foregroundStyle(Theme.red)
            }
        }
        .font(Typo.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Composer top (organism Hud): what's running, background jobs, the TODO

/// omp's pinned area inside the composer: the working row with the current intent, background jobs and
/// the current TODO task (opens to the whole list).
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
        VStack(alignment: .leading, spacing: Gap.xs) {
            if !timeline.jobs.isEmpty || timeline.running { activity }
            if let phase = Self.openPhase(timeline) { todo(phase) }
        }
        .font(Typo.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func todo(_ active: TodoPhase) -> some View {
        let phases = timeline.todo ?? []
        let numbered = phases.count > 1
        let current = active.tasks.first { $0.status == "in_progress" } ?? active.tasks.first { !$0.isClosed }
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: Gap.s) {
                IconView(.list, size: 13).foregroundStyle(Theme.dim).frame(width: 16)
                Text(current?.content ?? active.name).foregroundStyle(Theme.fg).lineLimit(1)
                Spacer(minLength: Gap.xs)
                HStack(spacing: Gap.xs) {
                    Text("\(name(active, in: phases, numbered: numbered)) \(active.done)/\(active.tasks.count)")
                        .monospacedDigit().lineLimit(1)
                    IconView(.chevronRight, size: 11).rotationEffect(.degrees(todoOpen ? 90 : 0))
                }
                .foregroundStyle(Theme.dim)
            }
            if todoOpen {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(phases) { phase in
                        let isActive = phase.name == active.name
                        if numbered {
                            Text("\(name(phase, in: phases, numbered: numbered)) · \(phase.done)/\(phase.tasks.count)")
                                .fontWeight(isActive ? .semibold : .regular)
                                .foregroundStyle(isActive ? Theme.fg : Theme.dim)
                        }
                        if isActive {
                            ForEach(phase.tasks) { task in TodoRow(task: task) }
                        }
                    }
                }
                .padding(.leading, Gap.xl)
                .padding(.vertical, 2)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.snappy) { todoOpen.toggle() } }
        .accessibilityAddTraits(.isButton)
    }

    private func name(_ phase: TodoPhase, in phases: [TodoPhase], numbered: Bool) -> String {
        guard numbered, let i = phases.firstIndex(where: { $0.name == phase.name }) else { return phase.name }
        let roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]
        return (i < roman.count ? roman[i] + ". " : "") + phase.name
    }

    private var activity: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(alignment: .leading, spacing: Gap.xs) {
                if timeline.running {
                    HStack(spacing: Gap.s) {
                        Spinner(color: Theme.work, size: 13).frame(width: 16)
                        Text(timeline.waiting ? String(localized: "wartet auf Hintergrund-Jobs") : timeline.workingLabel ?? String(localized: "Working…"))
                            .foregroundStyle(Theme.muted).lineLimit(1)
                        Spacer(minLength: Gap.xs)
                        if let start = timeline.turnStartedAt {
                            Text(Durations.since(start, now: context.date)).monospacedDigit().foregroundStyle(Theme.dim)
                        }
                    }
                }
                ForEach(timeline.jobs) { job in
                    HStack(spacing: Gap.s) {
                        Image(systemName: "gearshape").font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.dim).frame(width: 16)
                        Text(job.id).font(Typo.monoSmall).foregroundStyle(Theme.muted)
                        Text(job.label).foregroundStyle(Theme.dim).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: Gap.xs)
                        Text(Durations.since(job.startedAt, now: context.date)).monospacedDigit().foregroundStyle(Theme.dim)
                    }
                }
            }
        }
    }
}

/// One TODO task (hud__row): a small box, ticked when done; the running one in the work colour.
struct TodoRow: View {
    let task: TodoTask

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Gap.s) {
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .strokeBorder(boxColor, lineWidth: 1.5)
                .frame(width: 13, height: 13)
                .overlay { if task.status == "completed" { IconView(.check, size: 9).foregroundStyle(Theme.dim) } }
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
            Text(task.content + (task.status == "blocked" ? " (blocked)" : ""))
                .strikethrough(task.isClosed, color: color)
                .foregroundStyle(color)
                .lineLimit(2)
        }
        .font(Typo.sm)
    }

    private var color: Color {
        switch task.status {
        case "completed": return Theme.dim
        case "in_progress": return Theme.fg
        case "abandoned": return Theme.red
        case "blocked": return Theme.warn
        default: return Theme.muted
        }
    }

    private var boxColor: Color {
        switch task.status {
        case "in_progress": return Theme.work
        case "blocked": return Theme.warn
        default: return Theme.dim
        }
    }
}
