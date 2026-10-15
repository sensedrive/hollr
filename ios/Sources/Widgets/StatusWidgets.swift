import SwiftUI
import WidgetKit

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

/// The snapshot only changes when the app writes it (and then reloads the widgets) – the timeline
/// just re-reads it every 15 minutes so "updated …" stays honest.
struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry { SnapshotEntry(date: .now, snapshot: .preview) }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        let snap = WidgetSnapshot.load()
        completion(SnapshotEntry(date: .now, snapshot: context.isPreview && snap.agents.isEmpty ? .preview : snap))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let entry = SnapshotEntry(date: .now, snapshot: WidgetSnapshot.load())
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
    }
}

// MARK: Agents

struct AgentsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "hollr.agents", provider: SnapshotProvider()) { entry in
            AgentsWidgetView(entry: entry).containerBackground(for: .widget) { Color.black }
        }
        .configurationDisplayName("Agents")
        .description("Wer arbeitet, wer auf dich wartet.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct AgentsWidgetView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let snap = entry.snapshot
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: snap.waiting > 0 ? "questionmark.bubble.fill" : "waveform")
                    Text("\(snap.waiting > 0 ? snap.waiting : snap.working)").font(.headline.monospacedDigit())
                }
            }
            .widgetURL(snap.ranked.first.flatMap { HollrLink.open(fp: $0.fp, pane: $0.pane) })
        case .accessoryInline:
            Text(snap.waiting > 0 ? "\(snap.waiting) warten auf dich" : "\(snap.working) Agents arbeiten")
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("Hollr").font(.headline)
                Text(summary(snap)).font(.caption)
                if let top = snap.ranked.first { Text("\(top.title) · \(Palette.label(top.status))").font(.caption2).lineLimit(1) }
            }
        default:
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Hollr").font(.headline).foregroundStyle(.white)
                    Spacer()
                    if snap.waiting > 0 {
                        Label("\(snap.waiting)", systemImage: "questionmark.bubble.fill").font(.caption.weight(.bold))
                            .foregroundStyle(Palette.waiting)
                    }
                    Label("\(snap.working)", systemImage: "waveform").font(.caption.weight(.bold)).foregroundStyle(Palette.working)
                }
                let rows = family == .systemSmall ? 3 : family == .systemMedium ? 4 : 9
                if snap.agents.isEmpty {
                    Spacer()
                    Text("Öffne Hollr einmal, dann erscheinen hier deine Agents.").font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(snap.ranked.prefix(rows)) { agent in
                        Link(destination: HollrLink.open(fp: agent.fp, pane: agent.pane) ?? URL(string: "hollr://")!) {
                            HStack(spacing: 6) {
                                Circle().fill(color(agent.status)).frame(width: 7, height: 7)
                                Text(agent.title).font(.caption.weight(.medium)).foregroundStyle(.white).lineLimit(1)
                                if family != .systemSmall {
                                    Text(agent.server).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
                Text("Stand \(snap.updated, style: .relative)").font(.system(size: 9)).foregroundStyle(.secondary)
            }
        }
    }

    private func summary(_ snap: WidgetSnapshot) -> String {
        snap.waiting > 0 ? String(localized: "\(snap.waiting) warten auf dich") : String(localized: "\(snap.working) arbeiten")
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "blocked": return Palette.waiting
        case "working": return Palette.working
        case "done": return Palette.done
        default: return .gray
        }
    }
}

// MARK: Limits

struct LimitsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "hollr.limits", provider: SnapshotProvider()) { entry in
            LimitsWidgetView(entry: entry).containerBackground(for: .widget) { Color.black }
        }
        .configurationDisplayName("Nutzungslimits")
        .description("Claude, ChatGPT & Co. – wie viel vom Limit verbraucht ist.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

private struct LimitsWidgetView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let limits = entry.snapshot.limits
        VStack(alignment: .leading, spacing: family == .accessoryRectangular ? 2 : 8) {
            if family != .accessoryRectangular { Text("Limits").font(.headline).foregroundStyle(.white) }
            if limits.isEmpty {
                Text("Noch keine Daten").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(limits.prefix(family == .systemMedium ? 6 : 4)) { limit in
                HStack(spacing: 6) {
                    Text("\(limit.provider) \(limit.window)").font(.caption).lineLimit(1)
                    Spacer(minLength: 4)
                    Text("\(Int((limit.used * 100).rounded())) %").font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(limit.used > 0.85 ? Palette.error : limit.used > 0.6 ? Palette.waiting : Palette.done)
                }
                if family != .accessoryRectangular {
                    ProgressView(value: min(limit.used, 1)).tint(limit.used > 0.85 ? Palette.error : limit.used > 0.6 ? Palette.waiting : Palette.done)
                }
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(.white)
    }
}

extension WidgetSnapshot {
    static var preview: WidgetSnapshot {
        WidgetSnapshot(
            agents: [
                .init(id: "1", fp: "", pane: "w1:p1", server: "workr", title: "Patricks Tickets", agent: "omp", status: "blocked"),
                .init(id: "2", fp: "", pane: "w2:p1", server: "workr", title: "Gastronomie", agent: "omp", status: "working"),
                .init(id: "3", fp: "", pane: "w3:p1", server: "MacBook", title: "watchr", agent: "omp", status: "idle"),
            ],
            limits: [.init(provider: "Claude", window: "5h", used: 0.42), .init(provider: "Claude", window: "7d", used: 0.9)],
            updated: .now)
    }
}
