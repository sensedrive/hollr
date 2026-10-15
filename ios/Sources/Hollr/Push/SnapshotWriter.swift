import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// Keeps the widgets' snapshot in step with the app (called on every herdr / usage change).
@MainActor
enum SnapshotWriter {
    static func write(agents refs: [AgentRef], usage: [UsageLimit]) {
        var snap = WidgetSnapshot()
        snap.agents = refs.map {
            WidgetSnapshot.Agent(id: $0.id, fp: $0.server.hostFingerprint, pane: $0.pane.pane, server: $0.server.label,
                                 title: $0.title, agent: $0.pane.agentName, status: $0.pane.status)
        }
        // one row per provider/window, the highest use (several accounts / servers report the same)
        var best: [String: WidgetSnapshot.Limit] = [:]
        for l in usage {
            let row = WidgetSnapshot.Limit(provider: l.providerName, window: l.shortWindow, used: l.used, resetsAt: l.resetsAt)
            if (best[row.id]?.used ?? -1) < row.used { best[row.id] = row }
        }
        snap.limits = best.values.sorted { ($0.provider, $0.window) < ($1.provider, $1.window) }
        snap.updated = .now
        if snap.save() {
            #if canImport(WidgetKit)
            WidgetCenter.shared.reloadAllTimelines()
            #endif
        }
    }
}
