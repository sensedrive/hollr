import Foundation
import MetricKit
import UIKit

/// Breadcrumbs for problems that leave no crash log on the phone – a white screen after a long break, a hang:
/// launch (and whether iOS launched the app in the background), scene and app lifecycle, the first frame,
/// app lock, every HollrLog line and MetricKit's hang / crash reports. They go to a file and, on the next good
/// start, to a server (`gate diag` → ~/.local/state/hollr/diag/ there), so they can be read without the phone.
final class Diagnostics: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = Diagnostics()

    private let lock = NSLock()
    private let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("hollr-diag.log")
    private static let maxBytes = 512 * 1024
    private var started = false
    private let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Once, from the app delegate: MetricKit and the lifecycle notifications.
    func start() {
        lock.withLock {
            guard !started else { return }
            started = true
        }
        MXMetricManager.shared.add(self)
        let events: [(Notification.Name, String)] = [
            (UIScene.willConnectNotification, "scene connect"),
            (UIScene.didDisconnectNotification, "scene disconnect"),
            (UIScene.willEnterForegroundNotification, "scene foreground"),
            (UIScene.didActivateNotification, "scene active"),
            (UIScene.willDeactivateNotification, "scene inactive"),
            (UIScene.didEnterBackgroundNotification, "scene background"),
            (UIApplication.didReceiveMemoryWarningNotification, "memory warning"),
            (UIApplication.protectedDataDidBecomeAvailableNotification, "data unlocked"),
            (UIApplication.protectedDataWillBecomeUnavailableNotification, "data locked"),
            (UIApplication.willTerminateNotification, "terminate"),
        ]
        for (name, label) in events {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                self?.note(label)
            }
        }
    }

    func note(_ line: String) {
        let text = "\(stamp.string(from: Date())) \(line)\n"
        lock.withLock {
            guard let data = text.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                let size = (try? handle.seekToEnd()) ?? 0
                if size + UInt64(data.count) > UInt64(Self.maxBytes) {
                    // keep the newer half
                    let old = (try? Data(contentsOf: url)) ?? Data()
                    let kept = old.suffix(Self.maxBytes / 2)
                    try? (kept + data).write(to: url)
                } else {
                    try? handle.write(contentsOf: data)
                }
            } else {
                try? data.write(to: url)
            }
        }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            note("metrickit \(String(decoding: payload.jsonRepresentation(), as: UTF8.self))")
        }
    }

    /// Hands what was written since the last upload to the first server that takes it; lines written meanwhile
    /// stay for the next time.
    @MainActor func upload(servers: [Server]) async {
        let data: Data = lock.withLock { (try? Data(contentsOf: url)) ?? Data() }
        guard !data.isEmpty, !servers.isEmpty else { return }
        struct Answer: Decodable { let ok: Bool? }
        let body: [String: Any] = [
            "device": UIDevice.current.name,
            "app": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?",
            "text": String(decoding: data, as: UTF8.self),
        ]
        for server in servers {
            guard (try? await HollrClient.fs(server, body, as: Answer.self, command: "diag", seconds: 20))?.ok == true else { continue }
            lock.withLock {
                let now = (try? Data(contentsOf: url)) ?? Data()
                try? now.dropFirst(min(data.count, now.count)).write(to: url)
            }
            return
        }
    }
}
