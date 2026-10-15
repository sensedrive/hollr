import SwiftUI
import UIKit

/// A color theme (Settings → Design). Every color in the app comes from the current palette.
struct Palette: Identifiable, Equatable {
    let name: String
    let isDark: Bool
    let bg: UInt32
    let surface: UInt32
    let raised: UInt32
    let fg: UInt32
    let muted: UInt32
    let dim: UInt32
    let border: UInt32
    let accent: UInt32
    let red: UInt32
    let green: UInt32
    let yellow: UInt32
    let orange: UInt32
    let purple: UInt32
    let cyan: UInt32
    let pink: UInt32
    let blue: UInt32
    var id: String { name }

    /// set by `ThemedRoot` before the view tree is built
    nonisolated(unsafe) static var current: Palette = .hollr
    nonisolated(unsafe) static var applied = false

    static let hollr = Palette(name: "Hollr", isDark: true, bg: 0x000000, surface: 0x1C1C1E, raised: 0x161616, fg: 0xFFFFFF,
                               muted: 0x777D88, dim: 0x5F6673, border: 0x3D424A, accent: 0x7C9CFF, red: 0xFC3A4B, green: 0x2EB57A,
                               yellow: 0xE4C00F, orange: 0xFEBC38, purple: 0x9A63FF, cyan: 0x5ED3C1, pink: 0xF286C4, blue: 0x5AA9F0)
    static let moshi = Palette(name: "Moshi", isDark: true, bg: 0x1E1F26, surface: 0x2A2B33, raised: 0x24252C, fg: 0xE6E6EA,
                               muted: 0x9A9BA5, dim: 0x6C6E78, border: 0x3A3B44, accent: 0xA98BF5, red: 0xE5737F, green: 0x6CCB8C,
                               yellow: 0xE3C46B, orange: 0xE39A4C, purple: 0xB48CF2, cyan: 0x5ED3C1, pink: 0xE05CA8, blue: 0x7FA3F5)
    static let dracula = Palette(name: "Dracula", isDark: true, bg: 0x282A36, surface: 0x343746, raised: 0x2F3240, fg: 0xF8F8F2,
                                 muted: 0xA0A4C0, dim: 0x6272A4, border: 0x44475A, accent: 0xBD93F9, red: 0xFF5555, green: 0x50FA7B,
                                 yellow: 0xF1FA8C, orange: 0xFFB86C, purple: 0xBD93F9, cyan: 0x8BE9FD, pink: 0xFF79C6, blue: 0x8BE9FD)
    static let nord = Palette(name: "Nord", isDark: true, bg: 0x2E3440, surface: 0x3B4252, raised: 0x353C4A, fg: 0xECEFF4,
                              muted: 0xA3ABBA, dim: 0x6B7385, border: 0x4C566A, accent: 0x88C0D0, red: 0xBF616A, green: 0xA3BE8C,
                              yellow: 0xEBCB8B, orange: 0xD08770, purple: 0xB48EAD, cyan: 0x8FBCBB, pink: 0xB48EAD, blue: 0x81A1C1)
    static let solarizedDark = Palette(name: "Solarized Dark", isDark: true, bg: 0x002B36, surface: 0x073642, raised: 0x04313C,
                                       fg: 0xEEE8D5, muted: 0x93A1A1, dim: 0x657B83, border: 0x0E4A57, accent: 0x268BD2, red: 0xDC322F,
                                       green: 0x859900, yellow: 0xB58900, orange: 0xCB4B16, purple: 0x6C71C4, cyan: 0x2AA198,
                                       pink: 0xD33682, blue: 0x268BD2)
    static let gruvbox = Palette(name: "Gruvbox", isDark: true, bg: 0x282828, surface: 0x3C3836, raised: 0x32302F, fg: 0xEBDBB2,
                                 muted: 0xA89984, dim: 0x7C6F64, border: 0x504945, accent: 0x83A598, red: 0xFB4934, green: 0xB8BB26,
                                 yellow: 0xFABD2F, orange: 0xFE8019, purple: 0xD3869B, cyan: 0x8EC07C, pink: 0xD3869B, blue: 0x83A598)
    static let mocha = Palette(name: "Catppuccin Mocha", isDark: true, bg: 0x1E1E2E, surface: 0x313244, raised: 0x181825,
                               fg: 0xCDD6F4, muted: 0xA6ADC8, dim: 0x6C7086, border: 0x45475A, accent: 0xCBA6F7, red: 0xF38BA8,
                               green: 0xA6E3A1, yellow: 0xF9E2AF, orange: 0xFAB387, purple: 0xCBA6F7, cyan: 0x94E2D5,
                               pink: 0xF5C2E7, blue: 0x89B4FA)
    static let solarizedLight = Palette(name: "Solarized Light", isDark: false, bg: 0xFDF6E3, surface: 0xEEE8D5, raised: 0xF5EFDC,
                                        fg: 0x073642, muted: 0x586E75, dim: 0x93A1A1, border: 0xD9D2BF, accent: 0x268BD2,
                                        red: 0xDC322F, green: 0x859900, yellow: 0xB58900, orange: 0xCB4B16, purple: 0x6C71C4,
                                        cyan: 0x2AA198, pink: 0xD33682, blue: 0x268BD2)
    static let latte = Palette(name: "Catppuccin Latte", isDark: false, bg: 0xEFF1F5, surface: 0xE6E9EF, raised: 0xDCE0E8,
                               fg: 0x4C4F69, muted: 0x6C6F85, dim: 0x9CA0B0, border: 0xCCD0DA, accent: 0x8839EF, red: 0xD20F39,
                               green: 0x40A02B, yellow: 0xDF8E1D, orange: 0xFE640B, purple: 0x8839EF, cyan: 0x179299,
                               pink: 0xEA76CB, blue: 0x1E66F5)
    static let githubLight = Palette(name: "GitHub Light", isDark: false, bg: 0xFFFFFF, surface: 0xF6F8FA, raised: 0xF0F2F5,
                                     fg: 0x1F2328, muted: 0x59636E, dim: 0x8C959F, border: 0xD0D7DE, accent: 0x0969DA,
                                     red: 0xCF222E, green: 0x1A7F37, yellow: 0x9A6700, orange: 0xBC4C00, purple: 0x8250DF,
                                     cyan: 0x1B7C83, pink: 0xBF3989, blue: 0x0969DA)

    static let dark: [Palette] = [.hollr, .moshi, .dracula, .nord, .solarizedDark, .gruvbox, .mocha]
    static let light: [Palette] = [.solarizedLight, .latte, .githubLight]
    static let all = dark + light

    static func named(_ name: String) -> Palette? { all.first { $0.name == name } }

    /// The five dots shown in the picker (like Moshi): background, text, red, green, blue.
    var preview: [Color] { [bg, fg, red, green, blue].map { Color(hex: $0) } }
}

enum ThemeSettings {
    static let followKey = "theme.followSystem"
    static let selectedKey = "theme.selected"
    static let darkKey = "theme.dark"
    static let lightKey = "theme.light"
}

/// Resolves the palette (fixed, or dark/light following the system), applies color scheme,
/// tint and background, and rebuilds the view tree when the palette changes.
struct ThemedRoot<Content: View>: View {
    @AppStorage(ThemeSettings.followKey) private var follow = false
    @AppStorage(ThemeSettings.selectedKey) private var selected = Palette.hollr.name
    @AppStorage(ThemeSettings.darkKey) private var darkName = Palette.hollr.name
    @AppStorage(ThemeSettings.lightKey) private var lightName = Palette.latte.name
    @Environment(\.colorScheme) private var system
    @ViewBuilder let content: Content

    var body: some View {
        let palette = resolve()
        let _ = Self.apply(palette)
        content
            .background(Color(hex: palette.bg).ignoresSafeArea())
            .id(palette.name)
            .tint(Color(hex: palette.accent))
            .preferredColorScheme(follow ? nil : (palette.isDark ? .dark : .light))
    }

    /// Global state + UIKit backgrounds (lists are UICollectionViews).
    private static func apply(_ palette: Palette) {
        guard Palette.current != palette || !Palette.applied else { return }
        Palette.current = palette
        Palette.applied = true
        let bg = UIColor(Color(hex: palette.bg))
        UICollectionView.appearance().backgroundColor = bg
        UITableView.appearance().backgroundColor = bg
        for scene in UIApplication.shared.connectedScenes {
            (scene as? UIWindowScene)?.windows.forEach { $0.backgroundColor = bg }
        }
    }

    private func resolve() -> Palette {
        if follow {
            return system == .dark ? Palette.named(darkName) ?? .hollr : Palette.named(lightName) ?? .latte
        }
        return Palette.named(selected) ?? .hollr
    }
}

/// Settings → Design (like Moshi).
struct DesignSettingsView: View {
    @AppStorage(ThemeSettings.followKey) private var follow = false
    @AppStorage(ThemeSettings.selectedKey) private var selected = Palette.hollr.name
    @AppStorage(ThemeSettings.darkKey) private var darkName = Palette.hollr.name
    @AppStorage(ThemeSettings.lightKey) private var lightName = Palette.latte.name

    var body: some View {
        List {
            Group {
            Section("Automatisch") {
                Toggle("System folgen", isOn: $follow)
                NavigationLink {
                    PalettePicker(title: "Dunkles Design", palettes: Palette.dark, selection: $darkName)
                } label: {
                    LabeledContent("Dunkles Design", value: darkName)
                }
                NavigationLink {
                    PalettePicker(title: "Helles Design", palettes: Palette.light, selection: $lightName)
                } label: {
                    LabeledContent("Helles Design", value: lightName)
                }
            }
            Section {
                Toggle("Werkzeuge im Chat zusammenfassen", isOn: Binding(
                    get: { UserDefaults.standard.object(forKey: "chat.compactTools") as? Bool ?? true },
                    set: { UserDefaults.standard.set($0, forKey: "chat.compactTools") }))
            } header: {
                Text("Chat")
            } footer: {
                Text("Fertige Werkzeug-Gruppen erscheinen als eine Zeile („12 Werkzeuge · 3 Dateien geändert“) – antippen klappt sie auf.")
            }
            Section("Dunkel") { rows(Palette.dark) }
            Section("Hell") { rows(Palette.light) }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .navigationTitle("Design")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func rows(_ palettes: [Palette]) -> some View {
        ForEach(palettes) { p in
            Button {
                follow = false
                selected = p.name
            } label: {
                PaletteRow(palette: p, checked: !follow && selected == p.name)
            }
            .buttonStyle(.plain)
        }
    }
}

private struct PalettePicker: View {
    let title: String
    let palettes: [Palette]
    @Binding var selection: String

    var body: some View {
        List(palettes) { p in
            Button { selection = p.name } label: { PaletteRow(palette: p, checked: selection == p.name) }
                .buttonStyle(.plain)
        }
        .navigationTitle(title)
    }
}

private struct PaletteRow: View {
    let palette: Palette
    let checked: Bool

    var body: some View {
        HStack {
            Text(palette.name)
            Spacer()
            HStack(spacing: 4) {
                ForEach(Array(palette.preview.enumerated()), id: \.offset) { _, c in
                    Circle().fill(c).frame(width: 14, height: 14)
                        .overlay(Circle().stroke(Color.primary.opacity(0.15), lineWidth: 0.5))
                }
            }
            Image(systemName: "checkmark").foregroundStyle(Theme.accent).opacity(checked ? 1 : 0).frame(width: 24)
        }
        .contentShape(Rectangle())
    }
}

extension View {
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

extension View {
    /// List in the palette's colors (system lists ignore UIKit appearance).
    func themedList() -> some View {
        scrollContentBackground(.hidden).background(Theme.bg)
    }
}
