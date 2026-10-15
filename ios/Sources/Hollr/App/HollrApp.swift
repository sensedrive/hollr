import SwiftUI

@main
struct HollrApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = ServerStore()
    @State private var herdr = HerdrStore()
    @State private var sessions = SessionStore()
    @State private var dictation = DictationSettings()
    @State private var mySessions = MySessions()
    @State private var drafts = DraftStore()
    @State private var dictator = Dictator()
    @State private var inbox = Inbox()
    @State private var snippets = PromptSnippets()
    @State private var pairing: PairingRequest?

    var body: some Scene {
        WindowGroup {
            ThemedRoot {
            RootView(pairing: $pairing)
                // innermost: the browser cover inherits stores and text scale
                .linkChooser()
                .environment(store)
                .environment(herdr)
                .environment(sessions)
                .environment(dictation)
                .environment(mySessions)
                .environment(drafts)
                .environment(dictator)
                .environment(inbox)
                .environment(snippets)
                .appTextScale()
                .appLock()
                // dictation models take hundreds of MB: give them back when iOS asks or we go away
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
                    if !dictator.isBusy { Dictator.releaseModels() }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
                    drafts.save()
                    // a dictation stops itself and still needs its model for the last piece
                    Task {
                        while dictator.isBusy { try? await Task.sleep(for: .milliseconds(200)) }
                        Dictator.releaseModels()
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.willTerminateNotification)) { _ in
                    drafts.save()
                }
                .onOpenURL { url in
                    // Live Activity / widget: hollr://open?fp=…&pane=…
                    if let target = HollrLink.parseOpen(url) {
                        PushManager.shared.openRequest = target
                        return
                    }
                    // QR code scanned with the iPhone camera opens hollr://pair?c=…
                    pairing = PairingRequest(link: url.absoluteString)
                }
            }
        }
    }
}

enum Theme {
    private static var p: Palette { Palette.current }
    static var accent: Color { Color(hex: p.accent) }
    static var live: Color { Color(hex: p.green) }
    static var work: Color { Color(hex: p.purple) }
    static var warn: Color { Color(hex: p.orange) }
    static var card: Color { Color(hex: p.surface) }
    /// page background
    static var bg: Color { Color(hex: p.bg) }
    /// input fields, cards on cards
    static var raised: Color { Color(hex: p.raised) }
    /// text color – use with opacity for subtle fills and strokes (adapts to light themes)
    static var fg: Color { Color(hex: p.fg) }
    /// text/icons on an accent-filled surface
    static var onAccent: Color { p.isDark ? .black : .white }

    /// A workspace's own color (same name → same color on every device): cards, rows, chips, chat.
    static func identity(_ name: String) -> Color {
        let hues: [Double] = [0.58, 0.76, 0.93, 0.03, 0.09, 0.14, 0.36, 0.47]
        var hash: UInt64 = 1469598103934665603 // FNV-1a: stable, unlike hashValue
        for byte in name.lowercased().utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        return Color(hue: hues[Int(hash % UInt64(hues.count))], saturation: p.isDark ? 0.55 : 0.6, brightness: p.isDark ? 0.95 : 0.75)
    }

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "idle", "done": return live
        case "working": return work
        case "blocked": return warn
        default: return .gray
        }
    }

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

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "idle": return String(localized: "bereit")
        case "done": return String(localized: "fertig")
        case "working": return String(localized: "arbeitet")
        case "blocked": return String(localized: "wartet auf dich")
        default: return status
        }
    }
}
