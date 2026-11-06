import SwiftUI

/// The design's line icons (Lucide style, 24 grid, stroke 2 – atoms/Icon.tsx) as their closest SF Symbols, always
/// the outline variant. SF Symbols scale with Dynamic Type, sit on the text baseline and work in system menus.
enum HIcon: String, CaseIterable {
    case plus, x, check, grid, search, sliders, branch, globe, info, maximize, more, terminal, paperclip, mic
    case arrowUp, refresh, pencil, file, chevronRight, chevronDown, chevronLeft, alert, message, reply, activity
    case server, cpu, folder, help, wifiOff, corner, list, sun, lock, copy, external, volume, pause, trash, stop
    case sparkle, bell, key, image

    var symbol: String {
        switch self {
        case .plus: return "plus"
        case .x: return "xmark"
        case .check: return "checkmark"
        case .grid: return "square.grid.2x2"
        case .search: return "magnifyingglass"
        case .sliders: return "slider.vertical.3"
        case .branch: return "arrow.triangle.branch"
        case .globe: return "globe"
        case .info: return "info.circle"
        case .maximize: return "arrow.up.left.and.arrow.down.right"
        case .more: return "ellipsis"
        case .terminal: return "apple.terminal"
        case .paperclip: return "paperclip"
        case .mic: return "mic"
        case .arrowUp: return "arrow.up"
        case .refresh: return "arrow.clockwise"
        case .pencil: return "pencil"
        case .file: return "doc"
        case .chevronRight: return "chevron.right"
        case .chevronDown: return "chevron.down"
        case .chevronLeft: return "chevron.left"
        case .alert: return "exclamationmark.triangle"
        case .message: return "bubble.left"
        case .reply: return "arrowshape.turn.up.left"
        case .activity: return "waveform.path.ecg"
        case .server: return "server.rack"
        case .cpu: return "cpu"
        case .folder: return "folder"
        case .help: return "questionmark.circle"
        case .wifiOff: return "wifi.slash"
        case .corner: return "arrow.turn.down.right"
        case .list: return "list.bullet"
        case .sun: return "sun.max"
        case .lock: return "lock"
        case .copy: return "doc.on.doc"
        case .external: return "arrow.up.right"
        case .volume: return "speaker.wave.2"
        case .pause: return "pause"
        case .trash: return "trash"
        case .stop: return "stop"
        case .sparkle: return "sparkle"
        case .bell: return "bell"
        case .key: return "key"
        case .image: return "photo"
        }
    }
}

extension Image {
    init(_ icon: HIcon) { self.init(systemName: icon.symbol) }
}

extension Label where Title == Text, Icon == Image {
    init(_ title: LocalizedStringKey, icon: HIcon) { self.init(title, systemImage: icon.symbol) }
    @_disfavoredOverload
    init<S: StringProtocol>(_ title: S, icon: HIcon) { self.init(title, systemImage: icon.symbol) }
}

/// An icon at one of the design's sizes (12–16 pt), medium stroke like Lucide's 2 px line; scales with Dynamic Type.
struct IconView: View {
    let icon: HIcon
    var size: CGFloat = 16
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    init(_ icon: HIcon, size: CGFloat = 16) {
        self.icon = icon
        self.size = size
    }

    var body: some View {
        Image(icon)
            .font(.system(size: size * 0.9 * scale, weight: .medium))
            .frame(width: size * scale, height: size * scale)
    }
}

/// The design's "loader" icon (a 300° arc) turning – running tools, long-running cards, loading states.
/// Stands still with Reduce Motion.
struct Spinner: View {
    var color: Color = Theme.work
    var size: CGFloat = 14
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1)
            Circle()
                .trim(from: 0, to: 0.82)
                .stroke(color, style: StrokeStyle(lineWidth: max(1.5, size * scale / 8), lineCap: .round))
                .rotationEffect(.degrees(reduceMotion ? 0 : turn * 360))
                .padding(size * scale / 8)
                .frame(width: size * scale, height: size * scale)
        }
        .accessibilityHidden(true)
    }
}
