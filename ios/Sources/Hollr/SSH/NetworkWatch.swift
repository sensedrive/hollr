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

    /// bumped on every real change of the path
    private(set) var generation = 0
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

    /// Waits `seconds` – or less when the network changes meanwhile (a reconnect is worth trying then).
    func pause(_ seconds: Double) async {
        let start = generation
        let end = Date().addingTimeInterval(seconds)
        while Date() < end, generation == start, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(250))
        }
    }
}
