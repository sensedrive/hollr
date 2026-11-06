import LocalAuthentication
import SwiftUI

/// Optional Face ID / Touch ID / passcode lock (Settings → Sicherheit).
enum AppLock {
    static let key = "security.faceID"
    /// relock after this long in the background
    static let grace: TimeInterval = 30

    static var biometryName: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return String(localized: "Gerätecode")
        }
    }

    static func authenticate(reason: String = "Hollr entsperren") async -> Bool {
        let ctx = LAContext()
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return true }
        return (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}

extension View {
    func appLock() -> some View { modifier(AppLockModifier()) }
}

private struct AppLockModifier: ViewModifier {
    @AppStorage(AppLock.key) private var enabled = false
    @Environment(\.scenePhase) private var phase
    @State private var locked = UserDefaults.standard.bool(forKey: AppLock.key)
    @State private var backgroundSince: Date?
    @State private var authenticating = false

    func body(content: Content) -> some View {
        content
            .overlay {
                if enabled && locked {
                    // opaque page background: nothing of the app shows through (organisms/Overlays AppLock)
                    VStack(spacing: 14) {
                        IconView(.lock, size: 26)
                            .foregroundStyle(Theme.fg)
                            .frame(width: 64, height: 64)
                            .background(Theme.card, in: Circle())
                            .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                            .accessibilityHidden(true)
                        Text("Hollr ist gesperrt").font(.title3.weight(.semibold))
                        Text("Agents arbeiten weiter. Mitteilungen zeigen nur, dass etwas wartet – nicht was.")
                            .font(Typo.note)
                            .foregroundStyle(Theme.muted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 300)
                        Button {
                            Task { await unlock() }
                        } label: {
                            Label("Mit \(AppLock.biometryName) entsperren", icon: .key)
                        }
                        .buttonStyle(.hollr(.primary))
                        .padding(.top, Gap.xs)
                    }
                    .padding(Gap.xl)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.bg.ignoresSafeArea())
                    .accessibilityElement(children: .contain)
                    .accessibilityAddTraits(.isModal)
                    .transition(.opacity)
                }
            }
            .onChange(of: phase) { _, now in
                switch now {
                case .background:
                    backgroundSince = Date()
                case .active:
                    if enabled, let since = backgroundSince, Date().timeIntervalSince(since) > AppLock.grace { locked = true }
                    backgroundSince = nil
                    if enabled && locked { Task { await unlock() } }
                default:
                    break
                }
            }
            .task { if enabled && locked { await unlock() } }
    }

    private func unlock() async {
        guard !authenticating else { return }
        authenticating = true
        defer { authenticating = false }
        if await AppLock.authenticate() {
            withAnimation { locked = false }
        }
    }
}
