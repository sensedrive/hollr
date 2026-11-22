import Foundation
import Network

/// Watches the phone's network path (Wi-Fi ↔ mobile, Tailscale VPN on/off, a new address). After a change the
/// pooled SSH connections are usually half-open – they look connected but nothing comes back – so they are
/// dropped at once and every waiting reconnect loop (live feed, chat stream) tries again right away instead of
/// sitting out its backoff or a 20–50 s timeout.
@MainActor
@Observable
final class NetworkWatch {
    static let shared = NetworkWatch()

    /// bumped on every real change of the path – and when the app comes back from the background, whose
    /// connections were closed or went half-open meanwhile
    private(set) var generation = 0
    /// false while the app is in the background: streams wait instead of connecting into a suspended app
    /// (such a connection is dead on return, and the stream on it sat out its whole watchdog)
    private(set) var active = true
    @ObservationIgnored private var monitor: NWPathMonitor?
    @ObservationIgnored private var last: String?

    func start() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in
            let signature = NetworkWatch.signature(path)
            Task { @MainActor in NetworkWatch.shared.changed(signature) }
        }
        monitor.start(queue: DispatchQueue(label: "hollr.network"))
        self.monitor = monitor
    }

    /// status and the interfaces in use (a VPN shows up as its own utun interface)
    nonisolated private static func signature(_ path: NWPath) -> String {
        let interfaces = path.availableInterfaces.map { "\($0.type)-\($0.name)" }.sorted().joined(separator: ",")
        return "\(path.status)|\(interfaces)"
    }

    private func changed(_ signature: String) {
        defer { last = signature }
        guard let last, last != signature else { return }
        HollrLog.info("network changed: \(last) → \(signature)")
        generation += 1
        Task { await SSHPool.shared.closeAll() }
    }

    /// The app went to the background (false) or came back (true).
    func setActive(_ on: Bool) {
        guard on != active else { return }
        active = on
        if on { generation += 1 }
    }

    /// Returns once the app is in the foreground.
    func untilActive() async {
        while !active, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    /// Waits `seconds` – or less when the network changes meanwhile (a reconnect is worth trying then).
    func pause(_ seconds: Double) async {
        let start = generation
        let end = Date().addingTimeInterval(seconds)
        while Date() < end, generation == start, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(250))
        }
    }
}
