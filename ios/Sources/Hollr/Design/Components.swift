import SwiftUI

// Components of the MagicFink `hollr-desktop` v9 design (atoms + molecules), adapted to the phone:
// 44 pt touch targets, sheets instead of floating dialogs, system menus instead of drawn ones.

// MARK: - Atoms

/// Pane status (atom StatusDot): filled violet/orange/accent, grey ring when ready, a small dot without an agent.
struct StatusDot: View {
    let state: PaneState
    var size: CGFloat = 9
    /// breathe while something happens (off with Reduce Motion)
    var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ state: PaneState, size: CGFloat = 9, pulse: Bool = false) {
        self.state = state
        self.size = size
        self.pulse = pulse
    }

    init(status: String, agent: Bool = true, size: CGFloat = 9, pulse: Bool = false) {
        self.init(PaneState(status: status, agent: agent), size: size, pulse: pulse)
    }

    var body: some View {
        dot
            .frame(width: size, height: size)
            .modifier(Breathing(on: pulse && !reduceMotion))
            .accessibilityElement()
            .accessibilityLabel(state.label)
    }

    @ViewBuilder private var dot: some View {
        switch state {
        case .idle: Circle().strokeBorder(Theme.dim, lineWidth: 1.5)
        case .none: Circle().fill(Theme.dim).frame(width: 4, height: 4)
        default: Circle().fill(state.color)
        }
    }
}

private struct Breathing: ViewModifier {
    let on: Bool
    @State private var low = false

    func body(content: Content) -> some View {
        content
            .opacity(on && low ? 0.35 : 1)
            .onAppear {
                guard on else { return }
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { low = true }
            }
    }
}

/// The agent's short name in its colour (atom AgentBadge): omp, CC, cx, >_.
struct AgentBadge: View {
    let agent: String?
    var large = false

    init(agent: String?, large: Bool = false) {
        self.agent = agent
        self.large = large
    }

    init(pane: Pane, large: Bool = false) { self.init(agent: pane.agent, large: large) }

    var body: some View {
        let kind = AgentKind(agent)
        Text(verbatim: kind.short)
            .font(.system(size: large ? 12 : 10, weight: .bold, design: .monospaced))
            .foregroundStyle(kind.color)
            .frame(width: large ? 38 : 28, height: large ? 38 : 28)
            .background(kind.color.opacity(0.14), in: RoundedRectangle(cornerRadius: large ? 10 : Radius.md, style: .continuous))
            .accessibilityLabel(kind.name)
    }
}

/// Agent CLIs and their colours (mock.ts agentBadges).
struct AgentKind {
    let short: String
    let name: String
    let color: Color

    init(_ agent: String?) {
        switch agent {
        case "omp": (short, name, color) = ("omp", "omp", Theme.orange)
        case "claude": (short, name, color) = ("CC", "Claude Code", Theme.pink)
        case "codex": (short, name, color) = ("cx", "Codex", Theme.blue)
        case nil: (short, name, color) = (">_", String(localized: "Terminal"), Theme.muted)
        case let other?: (short, name, color) = (String(other.prefix(3)), other, Theme.accent)
        }
    }
}

/// Hollr's standard button (atom Button): card with border, primary in accent, danger in red, ghost without border.
struct HollrButtonStyle: ButtonStyle {
    enum Variant { case primary, secondary, danger, ghost }

    var variant: Variant = .secondary
    var small = false
    var fullWidth = false
    /// selected toggle-like button: accent border and text
    var active = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(small ? Typo.sm.weight(variant == .primary ? .semibold : .regular)
                        : Typo.note.weight(variant == .primary ? .semibold : .regular))
            .labelStyle(GapLabelStyle(spacing: small ? 6 : 7))
            .lineLimit(1)
            .foregroundStyle(foreground)
            .padding(.horizontal, small ? 10 : 14)
            .frame(minHeight: small ? 36 : Metric.touch)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .background(background, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(border, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.5)
    }

    private var foreground: Color {
        if active { return Theme.accent }
        switch variant {
        case .primary: return Theme.onAccent
        case .secondary: return Theme.fg
        case .danger: return Theme.red
        case .ghost: return Theme.muted
        }
    }

    private var background: Color {
        switch variant {
        case .primary: return Theme.accent
        case .secondary, .danger: return Theme.card
        case .ghost: return .clear
        }
    }

    private var border: Color {
        if active { return Theme.accent }
        switch variant {
        case .primary: return Theme.accent
        case .secondary, .danger: return Theme.border
        case .ghost: return .clear
        }
    }
}

extension ButtonStyle where Self == HollrButtonStyle {
    static func hollr(_ variant: HollrButtonStyle.Variant = .secondary, small: Bool = false, fullWidth: Bool = false,
                      active: Bool = false) -> HollrButtonStyle {
        HollrButtonStyle(variant: variant, small: small, fullWidth: fullWidth, active: active)
    }
}

/// Icon and title with the design's gap (7 pt; 6 pt on small buttons).
struct GapLabelStyle: LabelStyle {
    var spacing: CGFloat = 7

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: spacing) {
            configuration.icon.font(.system(size: 14, weight: .medium))
            configuration.title
        }
    }
}

/// Square icon button (atom IconButton): muted glyph, 44 pt touch target; active = accent wash.
struct IconButtonStyle: ButtonStyle {
    var active = false
    var size: CGFloat = Metric.touch

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(active || configuration.isPressed ? Theme.fg : Theme.muted)
            .frame(width: size, height: size)
            .background(active ? Theme.accent.opacity(0.22) : configuration.isPressed ? Theme.card : .clear,
                        in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == IconButtonStyle {
    static func icon(active: Bool = false, size: CGFloat = Metric.touch) -> IconButtonStyle {
        IconButtonStyle(active: active, size: size)
    }
}

/// Switch like in the settings (atom Toggle): grey off, green on. Applied app-wide by ThemedRoot.
struct HollrToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Toggle(isOn: configuration.$isOn) { configuration.label }
            .toggleStyle(.switch)
            .tint(Theme.green)
    }
}

extension ToggleStyle where Self == HollrToggleStyle {
    static var hollr: HollrToggleStyle { HollrToggleStyle() }
}

/// Switch between a few views or filters (atom Segmented): "pill" on a card capsule, "boxed" with an accent wash.
struct Segmented<Value: Hashable>: View {
    let label: String
    let options: [(value: Value, title: String)]
    @Binding var selection: Value
    var boxed = false

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let on = option.value == selection
                Button {
                    withAnimation(.easeOut(duration: 0.12)) { selection = option.value }
                } label: {
                    Text(option.title)
                        .font(Typo.sm.weight(on ? .medium : .regular))
                        .foregroundStyle(on ? Theme.fg : Theme.muted)
                        .padding(.horizontal, boxed ? 10 : 12)
                        .frame(minHeight: 30)
                        .background(on ? (boxed ? Theme.accent.opacity(0.2) : Theme.bg) : .clear,
                                    in: RoundedRectangle(cornerRadius: boxed ? Radius.sm : 99, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: boxed ? Radius.md : 99, style: .continuous))
        .overlay {
            if boxed { RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Theme.border, lineWidth: 1) }
        }
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}

/// Keyboard key or terminal quick key (atom Kbd / composer__key): small mono text on a hairline frame.
struct KeyCap: View {
    let text: String

    var body: some View {
        Text(verbatim: text)
            .font(Typo.monoSmall)
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .overlay(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).strokeBorder(Theme.wash(0.1), lineWidth: 1))
    }
}

/// "Empfohlen" next to omp's recommended option.
struct RecommendedBadge: View {
    var body: some View {
        Text("Empfohlen")
            .font(Typo.xs.weight(.semibold))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 8).padding(.vertical, 1)
            .background(Theme.accent.opacity(0.18), in: Capsule())
    }
}

/// Thin progress bar (focus card todo, work row): green fill on a text wash.
struct ProgressMeter: View {
    let value: Double
    var width: CGFloat = 90
    var height: CGFloat = 5
    var color: Color = Theme.green

    var body: some View {
        Capsule().fill(Theme.wash(0.1))
            .frame(width: width, height: height)
            .overlay(alignment: .leading) {
                Capsule().fill(color).frame(width: max(height, width * min(max(value, 0), 1)))
            }
            .accessibilityElement()
            .accessibilityValue("\(Int((value * 100).rounded())) %")
    }
}

/// The coloured 4 pt bar before a project's name (focus card, project card).
struct ProjectBar: View {
    let color: Color
    var height: CGFloat = 13

    var body: some View {
        RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 4, height: height)
    }
}

// MARK: - Page building blocks (screens/Page.css)

/// Row label in the settings lists: line icon in muted, title in text colour (Einstellungen rows).
struct SettingsLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        Label {
            configuration.title
        } icon: {
            configuration.icon.foregroundStyle(Theme.muted)
        }
        .labelStyle(.titleAndIcon)
    }
}

extension LabelStyle where Self == SettingsLabelStyle {
    static var settings: SettingsLabelStyle { SettingsLabelStyle() }
}

/// Section label above a group: uppercase 11 pt muted with a dim count on the right.
struct SectionHeader: View {
    let title: String
    var trailing: String? = nil
    /// optional status dot before the title
    var dot: Color? = nil

    var body: some View {
        HStack(spacing: Gap.s) {
            if let dot { Circle().fill(dot).frame(width: 7, height: 7) }
            Text(title.uppercased())
                .font(Typo.xs)
                .tracking(0.6)
                .foregroundStyle(Theme.muted)
            Spacer(minLength: Gap.s)
            if let trailing {
                Text(trailing).font(Typo.xs.monospacedDigit()).foregroundStyle(Theme.dim)
            }
        }
        .padding(.top, Gap.s)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Small explanatory line under a group (hp__foot).
struct FootNote: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).font(Typo.sm).foregroundStyle(Theme.dim).padding(.horizontal, Gap.xs).padding(.top, -2)
    }
}

extension View {
    /// A card (hp__card): card fill, 1 pt border, 12 pt corners, 12/14 padding.
    func cardStyle(padding: EdgeInsets = EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14),
                   radius: CGFloat = Radius.lg, fill: Color = Theme.card) -> some View {
        self.padding(padding)
            .background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
    }

    /// A text field like the design's inputs (dlg-input): raised fill, hairline border, accent when focused.
    func fieldStyle(focused: Bool = false, radius: CGFloat = 9) -> some View {
        self.font(Typo.md)
            .padding(.horizontal, 11).padding(.vertical, 9)
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(focused ? Theme.accent : Theme.border, lineWidth: 1))
    }

    /// System lists in the design's look: page background, card rows, border-coloured separators.
    func themedList() -> some View {
        scrollContentBackground(.hidden)
            .background(Theme.bg)
            .listRowSeparatorTint(Theme.border)
            .listSectionSeparatorTint(Theme.border)
    }

    /// Page background in the current palette (navigation container on iOS 18+).
    func themedPage() -> some View { modifier(ThemedPage()) }
}

private struct ThemedPage: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.containerBackground(Theme.bg, for: .navigation)
        } else {
            content.background(Theme.bg)
        }
    }
}

/// Rows in one card with hairline dividers between them (hp__rows).
struct Rows<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        _VariadicView.Tree(RowsLayout()) { content }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.lg, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.lg, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Radius.lg, style: .continuous))
    }
}

private struct RowsLayout: _VariadicView_MultiViewRoot {
    func body(children: _VariadicView.Children) -> some View {
        VStack(spacing: 0) {
            ForEach(children) { child in
                if child.id != children.first?.id { Rectangle().fill(Theme.border).frame(height: 1) }
                child
            }
        }
    }
}

/// Empty or closed state (sess__closed): icon in a card circle, title, text, actions.
struct EmptyState<Actions: View>: View {
    let icon: HIcon
    let title: String
    let text: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: Gap.s + 2) {
            IconView(icon, size: 18)
                .foregroundStyle(Theme.muted)
                .frame(width: 44, height: 44)
                .background(Theme.card, in: Circle())
            Text(title).font(.headline).padding(.top, 6)
            Text(text).font(Typo.md).foregroundStyle(Theme.muted).multilineTextAlignment(.center).frame(maxWidth: 320)
            HStack(spacing: Gap.s) { actions }.padding(.top, Gap.s)
        }
        .padding(Gap.xxl)
        .frame(maxWidth: .infinity)
    }
}

extension EmptyState where Actions == EmptyView {
    init(icon: HIcon, title: String, text: String) {
        self.init(icon: icon, title: title, text: text) { EmptyView() }
    }
}

// MARK: - Focus card (molecules/FocusCard)

/// What a focus card on the overview is about: its colour, label and icon.
enum FocusKind {
    case ask, waiting, done, error, long

    var color: Color {
        switch self {
        case .ask, .waiting: return Theme.warn
        case .done: return Theme.accent
        case .error: return Theme.red
        case .long: return Theme.work
        }
    }

    var label: String {
        switch self {
        case .ask: return String(localized: "Fragt dich")
        case .waiting: return String(localized: "Wartet auf dich")
        case .done: return String(localized: "Neues Ergebnis")
        case .error: return String(localized: "Fehler")
        case .long: return String(localized: "Läuft lange")
        }
    }

    var icon: HIcon {
        switch self {
        case .ask, .waiting: return .help
        case .done: return .check
        case .error: return .alert
        case .long: return .refresh
        }
    }

    /// results and long runs sit calmer on the page background; questions and errors on raised
    var calm: Bool { self == .done || self == .long }
}

/// Head line of a focus card: kind (icon + label), project with its colour bar, branch, time, "seen" check.
struct FocusCardHead: View {
    let kind: FocusKind
    let project: String
    var projectColor: Color
    var branch: String? = nil
    var since: String? = nil
    var onSeen: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: Gap.s) {
            HStack(spacing: 6) {
                Group {
                    if kind == .long { Spinner(color: kind.color, size: 11) } else { IconView(kind.icon, size: 11) }
                }
                .foregroundStyle(kind.color)
                .frame(width: 18, height: 18)
                .background(kind.color.opacity(0.2), in: Circle())
                Text(kind.label).font(Typo.sm.weight(.semibold)).foregroundStyle(kind.color)
            }
            .fixedSize()
            HStack(spacing: 6) {
                ProjectBar(color: projectColor)
                Text(project).font(Typo.sm.weight(.semibold)).lineLimit(1)
            }
            .layoutPriority(1)
            if let branch {
                Text(branch).font(Typo.monoSmall).foregroundStyle(Theme.dim).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: Gap.xs)
            if let since { Text(since).font(Typo.sm).foregroundStyle(Theme.dim).lineLimit(1).fixedSize() }
            if let onSeen {
                Button(action: onSeen) { IconView(.check, size: 14) }
                    .buttonStyle(.icon(size: 32))
                    .accessibilityLabel("Als gesehen markieren")
            }
        }
    }
}

extension View {
    /// Focus card frame: raised (or page) fill, kind-tinted 1 pt border, 3 pt kind bar on the left, 16 pt corners.
    func focusCardStyle(_ kind: FocusKind, selected: Bool = false) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.xl, style: .continuous)
        return self
            .padding(.vertical, 14).padding(.leading, 16).padding(.trailing, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(kind.calm ? Theme.bg : Theme.raised, in: shape)
            .overlay(alignment: .leading) {
                Rectangle().fill(kind.color).frame(width: 3)
            }
            .clipShape(shape)
            .overlay(shape.strokeBorder(selected ? kind.color : kind.color.opacity(0.4), lineWidth: selected ? 1.5 : 1))
    }
}

/// One answer option (focus card / ask card): number tile, label, "Empfohlen"; selected = accent frame.
struct OptionRow: View {
    let index: Int
    let label: String
    var detail: String? = nil
    var recommended = false
    var selected = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: "\(index + 1)")
                .font(.system(.caption, design: .monospaced).weight(.bold))
                .foregroundStyle(Theme.accent)
                .frame(minWidth: 20, minHeight: 20)
                .background(Theme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(Typo.md).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                if let detail, !detail.isEmpty {
                    Text(detail).font(Typo.sm).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                }
            }
            Spacer(minLength: 0)
            if recommended { RecommendedBadge() }
        }
        .padding(.vertical, 9).padding(.horizontal, 12)
        .frame(minHeight: Metric.touch)
        .background(selected ? Theme.accent.opacity(0.16) : Theme.wash(0.06),
                    in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.row, style: .continuous)
            .strokeBorder(selected ? Theme.accent : .clear, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
    }
}

/// Round send button (focus card reply, composer): neutral until there's text, then accent.
struct SendButtonLabel: View {
    let ready: Bool
    var size: CGFloat = Metric.touch

    var body: some View {
        IconView(.arrowUp, size: 15)
            .foregroundStyle(ready ? Theme.onAccent : Theme.dim)
            .frame(width: size, height: size)
            .background(ready ? Theme.accent : Theme.wash(0.1), in: Circle())
    }
}

// MARK: - Chat (molecules/ToolCard, AskCard, Composer, LivePill)

/// A flat tool step in the chat (molecule ToolCard): icon, name, detail, meta, chevron – no card around it.
struct ToolStepRow: View {
    enum StepState { case done, running, error }

    let symbol: String
    let name: String
    var detail: String? = nil
    var meta: String? = nil
    var state: StepState = .done
    /// nil = not expandable
    var expanded: Bool? = nil

    var body: some View {
        HStack(spacing: Gap.s) {
            Group {
                if state == .running { Spinner(color: Theme.work, size: 13) } else { Image(systemName: symbol) }
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(state == .error ? Theme.red : Theme.dim)
            .frame(width: 16)
            Text(name).foregroundStyle(state == .error ? Theme.red : Theme.fg).lineLimit(1).fixedSize()
            if let detail, !detail.isEmpty {
                Text(detail).foregroundStyle(Theme.dim).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: Gap.xs)
            if let meta { Text(meta).foregroundStyle(Theme.dim).monospacedDigit().lineLimit(1).fixedSize() }
            if let expanded {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.dim)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
        }
        .font(Typo.monoSmall)
        .padding(.vertical, 5).padding(.horizontal, Gap.s)
        .frame(minHeight: 30)
        .contentShape(Rectangle())
    }
}

extension View {
    /// The opened body of a tool step: raised fill, hairline border, indented under the step's name.
    func toolBodyStyle() -> some View {
        self.font(Typo.monoSmall)
            .padding(.vertical, Gap.s).padding(.horizontal, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
            .padding(.leading, Gap.xl)
            .padding(.bottom, 6)
    }

    /// A question card in the chat (molecule AskCard): orange-tinted raised fill and border.
    func askCardStyle() -> some View {
        self.padding(.vertical, Gap.m).padding(.horizontal, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.orange.opacity(0.06), in: RoundedRectangle(cornerRadius: Radius.lg, style: .continuous))
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.lg, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.lg, style: .continuous)
                .strokeBorder(Theme.orange.opacity(0.45), lineWidth: 1))
    }

    /// The composer's frame (molecule Composer): raised fill, 18 pt corners, text-wash border that turns accent when focused.
    func composerStyle(focused: Bool) -> some View {
        self.padding(.top, Gap.m).padding(.horizontal, 14).padding(.bottom, Gap.s)
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.composer, style: .continuous)
                .strokeBorder(focused ? Theme.accent.opacity(0.6) : Theme.wash(0.12), lineWidth: 1))
    }

    /// The user's message in the chat (sess__user): card fill, 14 pt corners.
    func userBubbleStyle() -> some View {
        self.padding(.vertical, 10).padding(.horizontal, 14)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.dialog, style: .continuous))
    }

    /// Snippet / suggestion chip (composer__chip).
    func chipStyle() -> some View {
        self.font(Typo.sm)
            .foregroundStyle(Theme.muted)
            .lineLimit(1)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Theme.wash(0.06), in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.wash(0.1), lineWidth: 1))
    }
}

/// "Live" in the composer: green text on a green wash, pill shaped.
struct LiveButtonLabel: View {
    var title = String(localized: "Live")

    var body: some View {
        HStack(spacing: 6) {
            IconView(.activity, size: 14)
            Text(title).font(Typo.note.weight(.semibold))
        }
        .foregroundStyle(Theme.green)
        .padding(.horizontal, Gap.m)
        .frame(height: Metric.touch)
        .background(Theme.green.opacity(0.16), in: Capsule())
    }
}

/// Pulsing live dot (LivePill).
struct LiveDot: View {
    var color: Color = Theme.live
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var ring = false

    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8)
            .overlay(Circle().stroke(color.opacity(ring ? 0 : 0.25), lineWidth: ring ? 8 : 0))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: false)) { ring = true }
            }
    }
}

extension View {
    /// The ongoing live call's pill (molecule LivePill): live-tinted card, 10 pt corners.
    func livePillStyle(_ color: Color = Theme.live) -> some View {
        self.padding(.vertical, 5).padding(.leading, Gap.s).padding(.trailing, 5)
            .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.row, style: .continuous).strokeBorder(color.opacity(0.3), lineWidth: 1))
    }
}

// MARK: - Overlays (molecules/Dialog, Toast; organisms/Dialogs)

/// Tone of a dialog's or toast's icon tile.
enum Tone {
    case accent, danger, warn, live

    var color: Color {
        switch self {
        case .accent: return Theme.accent
        case .danger: return Theme.red
        case .warn: return Theme.warn
        case .live: return Theme.live
        }
    }
}

/// 30 pt icon tile in a tone (dialog head, toast).
struct IconTile: View {
    let icon: HIcon
    var tone: Tone = .accent

    var body: some View {
        IconView(icon, size: 15)
            .foregroundStyle(tone.color)
            .frame(width: 30, height: 30)
            .background(tone.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

/// A dialog in a sheet (molecule Dialog): icon tile + title + close in the head, scrolling body,
/// footer with hairline and buttons. Present with `.dialogSheet()`.
struct DialogScaffold<Content: View, Footer: View>: View {
    let icon: HIcon
    var tone: Tone = .accent
    let title: String
    var onClose: (() -> Void)? = nil
    @ViewBuilder var content: Content
    @ViewBuilder var footer: Footer

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                IconTile(icon: icon, tone: tone)
                Text(title).font(Typo.lg).lineLimit(2)
                Spacer(minLength: Gap.s)
                if let onClose {
                    Button(action: onClose) { IconView(.x, size: 15) }
                        .buttonStyle(.icon(size: 36))
                        .accessibilityLabel("Schließen")
                }
            }
            .padding(.top, Gap.l).padding(.leading, 18).padding(.trailing, Gap.m).padding(.bottom, 10)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) { content }
                    .font(Typo.md)
                    .padding(.horizontal, 18).padding(.top, Gap.xs).padding(.bottom, Gap.l)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            if Footer.self != EmptyView.self {
                HStack(spacing: Gap.s) { footer }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, 18).padding(.vertical, Gap.m)
                    .background(Theme.bg.opacity(0.4))
                    .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
            }
        }
        .background(Theme.side)
    }
}

extension DialogScaffold where Footer == EmptyView {
    init(icon: HIcon, tone: Tone = .accent, title: String, onClose: (() -> Void)? = nil, @ViewBuilder content: () -> Content) {
        self.init(icon: icon, tone: tone, title: title, onClose: onClose, content: content) { EmptyView() }
    }
}

extension View {
    /// Sheet chrome for dialogs: side-coloured background, drag indicator.
    func dialogSheet() -> some View {
        presentationBackground(Theme.side)
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(Radius.composer)
    }
}

/// Labelled field inside a dialog (dlg-field).
struct DialogField<Content: View>: View {
    let label: String
    var note: String? = nil
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(Typo.sm.weight(.semibold)).foregroundStyle(Theme.muted)
            content
            if let note { Text(note).font(Typo.sm).foregroundStyle(Theme.dim) }
        }
    }
}

/// A choice in a dialog (dlg-choice): bordered row, accent frame and wash when chosen.
struct ChoiceRow<Content: View>: View {
    let selected: Bool
    @ViewBuilder var content: Content

    var body: some View {
        HStack(spacing: 10) { content }
            .padding(.vertical, 9).padding(.horizontal, Gap.m)
            .frame(maxWidth: .infinity, minHeight: Metric.touch, alignment: .leading)
            .background(selected ? Theme.accent.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.row, style: .continuous)
                .strokeBorder(selected ? Theme.accent : Theme.border, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// In-app notice (molecule Toast): icon tile, title, two lines of text, optional actions and close.
struct ToastView<Actions: View>: View {
    let icon: HIcon
    var tone: Tone = .accent
    let title: String
    var message: String? = nil
    var onClose: (() -> Void)? = nil
    @ViewBuilder var actions: Actions

    var body: some View {
        HStack(alignment: .top, spacing: Gap.m) {
            IconTile(icon: icon, tone: tone)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Typo.md.weight(.semibold))
                if let message { Text(message).font(Typo.sm).foregroundStyle(Theme.muted).lineLimit(2) }
                if Actions.self != EmptyView.self { HStack(spacing: 6) { actions }.padding(.top, 6) }
            }
            Spacer(minLength: 0)
            if let onClose {
                Button(action: onClose) { IconView(.x, size: 13) }
                    .buttonStyle(.icon(size: 32))
                    .accessibilityLabel("Schließen")
            }
        }
        .padding(.vertical, Gap.m).padding(.leading, 14).padding(.trailing, Gap.m)
        .background(Theme.side, in: RoundedRectangle(cornerRadius: Radius.lg, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.38), radius: 17, y: 12)
    }
}

extension ToastView where Actions == EmptyView {
    init(icon: HIcon, tone: Tone = .accent, title: String, message: String? = nil, onClose: (() -> Void)? = nil) {
        self.init(icon: icon, tone: tone, title: title, message: message, onClose: onClose) { EmptyView() }
    }
}
