import Foundation
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit

/// Live Activities are started by the server (push-to-start, iOS 17.2+). The app only hands out tokens:
/// the push-to-start token with the push registration, and each running activity's update token to
/// the server it belongs to. The system wakes the app in the background for that, so this starts at launch.
@MainActor
enum LiveActivities {
    private static var started = false
    private static var observed = Set<String>()

    /// push-to-start token, sent with the push registration
    static var startToken: String? { UserDefaults.standard.string(forKey: "push.liveStart") }

    static func start() {
        guard !started else { return }
        started = true
        if #available(iOS 17.2, *) {
            Task {
                for await data in Activity<AgentActivityAttributes>.pushToStartTokenUpdates {
                    let hex = data.hex
                    guard hex != startToken else { continue }
                    UserDefaults.standard.set(hex, forKey: "push.liveStart")
                    await PushManager.shared.registerEverywhere()
                }
            }
        }
        for activity in Activity<AgentActivityAttributes>.activities { observe(activity) }
        Task {
            for await activity in Activity<AgentActivityAttributes>.activityUpdates { observe(activity) }
        }
    }

    private static func observe(_ activity: Activity<AgentActivityAttributes>) {
        guard observed.insert(activity.id).inserted else { return }
        let attrs = activity.attributes
        Task {
            for await data in activity.pushTokenUpdates {
                await PushManager.shared.reportActivity(fp: attrs.fp, pane: attrs.pane, token: data.hex)
            }
        }
        Task {
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                await PushManager.shared.reportActivity(fp: attrs.fp, pane: attrs.pane, token: nil)
                observed.remove(activity.id)
                return
            }
        }
    }

    /// The agent was opened in the app: its activity has done its job.
    static func endIfDone(pane: String) {
        for activity in Activity<AgentActivityAttributes>.activities
        where activity.attributes.pane == pane && activity.content.state.status != "working" {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }
}

private extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
#else
@MainActor
enum LiveActivities {
    static var startToken: String? { nil }
    static func start() {}
    static func endIfDone(pane: String) {}
}
#endif
