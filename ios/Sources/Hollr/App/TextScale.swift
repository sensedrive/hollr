import SwiftUI

/// App-wide text/UI scale ("Ansicht skalieren"), independent of the iOS setting.
/// Stored as an index into `steps`; -1 follows the system.
enum TextScale {
    static let key = "ui.textScale"
    static let system = -1

    static let steps: [DynamicTypeSize] = [
        .xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge,
        .accessibility1, .accessibility2, .accessibility3,
    ]

    static func label(_ size: DynamicTypeSize) -> String {
        switch size {
        case .xSmall: return String(localized: "Winzig")
        case .small: return String(localized: "Sehr klein")
        case .medium: return String(localized: "Klein")
        case .large: return String(localized: "Standard")
        case .xLarge: return String(localized: "Groß")
        case .xxLarge: return String(localized: "Sehr groß")
        case .xxxLarge: return String(localized: "Riesig")
        case .accessibility1: return "XL 1"
        case .accessibility2: return "XL 2"
        default: return "XL 3"
        }
    }

    /// The effective size for a stored index (or the system size).
    static func size(_ index: Int, system: DynamicTypeSize) -> DynamicTypeSize {
        steps.indices.contains(index) ? steps[index] : system
    }

    /// Index one step smaller/larger than the current effective size.
    static func step(_ index: Int, system: DynamicTypeSize, by delta: Int) -> Int {
        let current = steps.firstIndex(of: size(index, system: system)) ?? 3
        return min(max(current + delta, 0), steps.count - 1)
    }
}

extension View {
    /// Applies the user's chosen scale (call once at the root).
    func appTextScale() -> some View { modifier(AppTextScale()) }
}

private struct AppTextScale: ViewModifier {
    @AppStorage(TextScale.key) private var index = TextScale.system
    @Environment(\.dynamicTypeSize) private var system

    func body(content: Content) -> some View {
        content.dynamicTypeSize(TextScale.size(index, system: system))
    }
}

/// Closes the keyboard wherever the focus is.
@MainActor func dismissKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}
