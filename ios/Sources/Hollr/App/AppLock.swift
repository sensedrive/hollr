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
                    ZStack {
                        Rectangle().fill(.ultraThickMaterial).ignoresSafeArea()
                        VStack(spacing: 18) {
                            Image(systemName: "lock.fill").font(.system(size: 44)).foregroundStyle(Theme.accent)
                            Text("Hollr ist gesperrt").font(.title3.weight(.semibold))
                            Button {
                                Task { await unlock() }
                            } label: {
                                Label("Mit \(AppLock.biometryName) entsperren", systemImage: "faceid")
                                    .padding(.horizontal, 8)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
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
