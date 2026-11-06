import SwiftUI

/// Design tokens of the MagicFink `hollr-desktop` v9 design (tokens.json), resolved against the current palette
/// (Settings → Design). Views take every colour from here – no ad-hoc colours.
enum Theme {
    private static var p: Palette { Palette.current }

    // MARK: surfaces

    /// page background (--color-bg)
    static var bg: Color { Color(hex: p.bg) }
    /// sheets, dialogs, menus, tab bar (--color-side: halfway between page and card on dark themes)
    static var side: Color { p.isDark ? Color(hex: Palette.mix(p.bg, p.surface, 0.5)) : Color(hex: p.surface) }
    /// cards and row groups (--color-card)
    static var card: Color { Color(hex: p.surface) }
    /// inputs, focus cards, the composer, tool output (--color-raised)
    static var raised: Color { Color(hex: p.raised) }
    /// 1 px card and divider lines (--color-border)
    static var border: Color { Color(hex: p.border) }

    // MARK: text

    /// text (--color-text) – with opacity also for subtle fills (`wash`)
    static var fg: Color { Color(hex: p.fg) }
    /// secondary text (--color-text-muted)
    static var muted: Color { Color(hex: p.muted) }
    /// hints, times, counts – mixed towards muted for contrast, like the desktop app (--color-dim)
    static var dim: Color { Color(hex: Palette.mix(p.dim, p.muted, 0.6)) }
    /// a subtle fill: the text colour at `amount` (color-mix(in srgb, var(--color-text) N%, transparent))
    static func wash(_ amount: Double) -> Color { fg.opacity(amount) }

    // MARK: accent

    static var accent: Color { Color(hex: p.accent) }
    /// selected options, active icon buttons (--color-accent-soft)
    static var accentSoft: Color { accent.opacity(0.2) }
    /// text/icons on an accent-filled surface (--color-on-accent)
    static var onAccent: Color { p.isDark ? Color(hex: 0x0B0C0F) : .white }

    // MARK: hues

    static var red: Color { Color(hex: p.red) }
    static var green: Color { Color(hex: p.green) }
    static var yellow: Color { Color(hex: p.yellow) }
    static var orange: Color { Color(hex: p.orange) }
    static var purple: Color { Color(hex: p.purple) }
    static var cyan: Color { Color(hex: p.cyan) }
    static var pink: Color { Color(hex: p.pink) }
    static var blue: Color { Color(hex: p.blue) }

    // MARK: semantic

    /// connected, live call, success, toggles on
    static var live: Color { green }
    /// an agent is working
    static var work: Color { purple }
    /// waits for you (question, confirmation, warning)
    static var warn: Color { orange }

    /// A workspace's own colour (same name → same colour on every device): the project bar on cards and rows.
    static func identity(_ name: String) -> Color {
        let hues: [UInt32] = [p.accent, p.purple, p.orange, p.cyan, p.pink, p.green, p.blue, p.yellow]
        var hash: UInt64 = 1469598103934665603 // FNV-1a: stable, unlike hashValue
        for byte in name.lowercased().utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        return Color(hex: hues[Int(hash % UInt64(hues.count))])
    }

    static func statusColor(_ status: String) -> Color { PaneState(status: status).color }

    static func statusLabel(_ status: String) -> String { PaneState(status: status).label }

    static func ompStateLabel(_ state: String?) -> String {
        switch state {
        case "listening": return String(localized: "hört zu")
        case "speaking": return "spricht"
        case "working", "thinking": return String(localized: "arbeitet")
        case "muted": return String(localized: "stumm")
        case "connecting": return "verbindet"
        case let s?: return s
        case nil: return "verbunden"
        }
    }
}

/// A pane's state as the design shows it (atom StatusDot): violet working, orange waits for you, accent blue
/// new result (unread), grey ring ready, a small dot when no agent runs.
enum PaneState {
    case working, blocked, result, idle, none

    init(status: String, agent: Bool = true) {
        guard agent else { self = .none; return }
        switch status {
        case "working": self = .working
        case "blocked": self = .blocked
        case "done": self = .result
        case "idle": self = .idle
        default: self = .none
        }
    }

    var color: Color {
        switch self {
        case .working: return Theme.work
        case .blocked: return Theme.warn
        case .result: return Theme.accent
        case .idle, .none: return Theme.dim
        }
    }

    var label: String {
        switch self {
        case .working: return String(localized: "arbeitet")
        case .blocked: return String(localized: "wartet auf dich")
        case .result: return String(localized: "neues Ergebnis")
        case .idle: return String(localized: "bereit")
        case .none: return String(localized: "kein Agent")
        }
    }
}

/// Type scale (font.size-*): the design's pixel sizes on the matching Dynamic Type styles, so text scales with
/// the system setting and "Ansicht skalieren".
enum Typo {
    /// 11 – section labels, counts, meta
    static let xs = Font.caption2
    /// 12 – secondary lines, chips, small buttons
    static let sm = Font.caption
    /// 13 – buttons, menu items, tool steps
    static let note = Font.footnote
    /// 14–15 – body text in cards and rows
    static let md = Font.subheadline
    /// 15 semibold – card titles, dialog titles
    static let lg = Font.subheadline.weight(.semibold)
    /// 22 bold – page heads inside content
    static let xl = Font.title2.weight(.bold)
    /// 28 bold – large titles (navigation bar)
    static let xxl = Font.title.weight(.bold)
    /// mono (font.family-mono): branches, paths, tool names, diff lines
    static let mono = Font.system(.footnote, design: .monospaced)
    static let monoSmall = Font.system(.caption, design: .monospaced)
    static let monoXS = Font.system(.caption2, design: .monospaced)
}

/// Spacing scale (space.1 … space.7).
enum Gap {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    static let xxxl: CGFloat = 48
}

/// Corner radii (radius.*), all drawn as continuous rounded rectangles.
enum Radius {
    static let sm: CGFloat = 6
    static let md: CGFloat = 8
    /// option rows, inputs, menus' items
    static let row: CGFloat = 10
    static let lg: CGFloat = 12
    /// dialogs, sheets' inner cards
    static let dialog: CGFloat = 14
    static let xl: CGFloat = 16
    /// the composer
    static let composer: CGFloat = 18
}

/// Control sizes (size.*): 44 pt touch targets on the phone, 30 pt compact controls.
enum Metric {
    static let touch: CGFloat = 44
    static let control: CGFloat = 30
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

extension Palette {
    /// `a` blended towards `b` by `t` (0…1), per channel – like CSS color-mix in sRGB.
    static func mix(_ a: UInt32, _ b: UInt32, _ t: Double) -> UInt32 {
        func channel(_ shift: UInt32) -> UInt32 {
            let x = Double((a >> shift) & 0xFF), y = Double((b >> shift) & 0xFF)
            return UInt32((x * (1 - t) + y * t).rounded()) << shift
        }
        return channel(16) | channel(8) | channel(0)
    }
}
