import ActivityKit
import SwiftUI
import WidgetKit

/// A working agent on the lock screen and in the Dynamic Island: what it does right now, todo progress,
/// how long it has been at it – orange when it waits for you. Tapping opens the chat.
struct AgentLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(HollrLink.open(fp: context.attributes.fp, pane: context.attributes.pane))
        } dynamicIsland: { context in
            let state = context.state
            let attrs = context.attributes
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label {
                        Text(attrs.title).font(.headline).lineLimit(1)
                    } icon: {
                        StatusIcon(status: state.status)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Elapsed(state: state).font(.headline.monospacedDigit()).padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(state.step).font(.subheadline).lineLimit(2)
                            .foregroundStyle(state.status == "waiting" ? Palette.waiting : .primary)
                        if state.todoTotal > 0 { TodoBar(state: state) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                StatusIcon(status: state.status)
            } compactTrailing: {
                if state.status == "working" {
                    Elapsed(state: state).font(.caption2.monospacedDigit()).frame(maxWidth: 44)
                } else {
                    Text(Palette.short(state.status)).font(.caption2.weight(.semibold))
                        .foregroundStyle(Palette.color(state.status))
                }
            } minimal: {
                StatusIcon(status: state.status)
            }
            .widgetURL(HollrLink.open(fp: attrs.fp, pane: attrs.pane))
            .keylineTint(Palette.color(state.status))
        }
    }
}

private struct LockScreenView: View {
    let attributes: AgentActivityAttributes
    let state: AgentActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                StatusIcon(status: state.status)
                VStack(alignment: .leading, spacing: 1) {
                    Text(attributes.title).font(.headline).foregroundStyle(.white).lineLimit(1)
                    Text("\(attributes.agent) · \(Palette.label(state.status))")
                        .font(.caption).foregroundStyle(Palette.color(state.status))
                }
                Spacer(minLength: 8)
                Elapsed(state: state).font(.title3.monospacedDigit().weight(.semibold)).foregroundStyle(.white)
            }
            Text(state.step)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.85))
                .lineLimit(2)
            if state.todoTotal > 0 { TodoBar(state: state) }
        }
        .padding(16)
    }
}

/// Running time while it works, the total once it waits or is done.
private struct Elapsed: View {
    let state: AgentActivityAttributes.ContentState

    var body: some View {
        let start = Date(timeIntervalSince1970: state.since)
        if state.status == "working" {
            Text(start, style: .timer).multilineTextAlignment(.trailing)
        } else {
            Text(Palette.duration(Date().timeIntervalSince(start)))
        }
    }
}

private struct TodoBar: View {
    let state: AgentActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 8) {
            ProgressView(value: Double(state.todoDone), total: Double(max(state.todoTotal, 1)))
                .tint(Palette.color(state.status))
            Text("\(state.todoDone)/\(state.todoTotal)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
    }
}

private struct StatusIcon: View {
    let status: String

    var body: some View {
        Image(systemName: Palette.symbol(status))
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(Palette.color(status))
    }
}

enum Palette {
    static let working = Color(red: 0.65, green: 0.55, blue: 0.98)
    static let waiting = Color(red: 0.98, green: 0.57, blue: 0.24)
    static let done = Color(red: 0.20, green: 0.83, blue: 0.60)
    static let error = Color(red: 0.97, green: 0.44, blue: 0.44)

    static func color(_ status: String) -> Color {
        switch status {
        case "waiting": return waiting
        case "done": return done
        case "error": return error
        default: return working
        }
    }

    static func symbol(_ status: String) -> String {
        switch status {
        case "waiting": return "questionmark.bubble.fill"
        case "done": return "checkmark.circle.fill"
        case "error": return "exclamationmark.triangle.fill"
        default: return "waveform"
        }
    }

    static func label(_ status: String) -> String {
        switch status {
        case "waiting": return String(localized: "wartet auf dich")
        case "done": return String(localized: "fertig")
        case "error": return String(localized: "Fehler")
        default: return String(localized: "arbeitet")
        }
    }

    static func short(_ status: String) -> String {
        switch status {
        case "waiting": return "?"
        case "done": return "✓"
        case "error": return "!"
        default: return ""
        }
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let s = max(Int(seconds), 0)
        return s >= 3600 ? "\(s / 3600)h \(s % 3600 / 60)m" : s >= 60 ? "\(s / 60)m" : "\(s)s"
    }
}
