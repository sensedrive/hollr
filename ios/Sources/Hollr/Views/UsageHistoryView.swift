import Charts
import SwiftUI

// MARK: - data (`hollr gate usage history <days>`, recorded by each server's watcher)

struct UsageHistory: Decodable {
    struct Limit: Decodable {
        let p: String
        let a: String?
        let l: String
        let w: String
        let u: Double
    }
    struct Sample: Decodable {
        let at: Double
        let limits: [Limit]
    }
    struct Activity: Decodable {
        let at: Double
        let host: String
        let work: [String: Double]
    }
    let host: String
    let samples: [Sample]
    let activity: [Activity]
}

extension HollrClient {
    static func usageHistory(_ server: Server, days: Int) async throws -> UsageHistory {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.executeCommand("usage history \(days)").readableBytesView)
        return try JSONDecoder().decode(UsageHistory.self, from: data)
    }
}

/// One point of a limit's curve (merged over all servers – they see the same accounts).
private struct LimitPoint: Identifiable {
    let series: String
    let date: Date
    let used: Double
    var id: String { "\(series)|\(date.timeIntervalSince1970)" }
}

private struct DayValue: Identifiable {
    let day: Date
    let group: String
    let value: Double
    var id: String { "\(group)|\(day.timeIntervalSince1970)" }
}

// MARK: - view

/// Settings-free beta: how the limits moved, how much was used per day, and where agents worked.
struct UsageHistoryView: View {
    @Environment(ServerStore.self) private var store
    @State private var days = 7
    @State private var histories: [(server: Server, history: UsageHistory)] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            Group {
                Section {
                    Picker("Zeitraum", selection: $days) {
                        Text("24 Std.").tag(1)
                        Text("7 Tage").tag(7)
                        Text("30 Tage").tag(30)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                if let error { Text(error).foregroundStyle(Theme.warn) }
                if loading && histories.isEmpty {
                    Section { SkeletonBar(width: 240, height: 160).shimmer() }
                } else if accounts.isEmpty && hoursByMachine.isEmpty {
                    Section {
                        Text("Noch keine Daten. Der Hollr-Server zeichnet ab jetzt alle 10 Minuten auf – schau in einer Stunde wieder vorbei.")
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(accounts, id: \.self) { account in
                    Section {
                        limitChart(account)
                        dailyChart(account)
                    } header: {
                        Text(account)
                    }
                }
                if !hoursByMachine.isEmpty {
                    Section {
                        machineChart
                        ForEach(kindTotals, id: \.kind) { row in
                            LabeledContent(row.kind, value: Self.hours(row.seconds))
                        }
                    } header: {
                        Text("Agent-Zeit pro Maschine")
                    } footer: {
                        Text("Wie lange Agents auf jeder Maschine gearbeitet haben – zeigt, wer die Limits verbraucht.")
                    }
                }
                Section {
                } footer: {
                    Text("Beta. Prozente kommen von den Anbietern (omp usage) und werden vom Hollr-Server aufgezeichnet, Agent-Zeit misst der Server selbst. Gespeichert werden 30 Tage.")
                }
            }
            .listRowBackground(Theme.card)
        }
        .themedList()
        .navigationTitle("Verlauf")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: days) { await load() }
        .refreshable { await load() }
    }

    // MARK: charts

    private func limitChart(_ account: String) -> some View {
        let points = limitPoints.filter { $0.series.hasPrefix(account + " · ") }
        return VStack(alignment: .leading, spacing: 6) {
            Text("Auslastung").font(.subheadline.weight(.semibold))
            Chart(points) { p in
                LineMark(x: .value("Zeit", p.date), y: .value("Genutzt", p.used * 100))
                    .foregroundStyle(by: .value("Limit", String(p.series.dropFirst(account.count + 3))))
                    .interpolationMethod(.stepEnd)
                PointMark(x: .value("Zeit", p.date), y: .value("Genutzt", p.used * 100))
                    .foregroundStyle(by: .value("Limit", String(p.series.dropFirst(account.count + 3))))
                    .symbolSize(points.count < 40 ? 24 : 0)
            }
            .chartYScale(domain: 0...100)
            .chartYAxis { AxisMarks(values: [0, 50, 100]) { v in AxisGridLine(); AxisValueLabel("\(v.as(Int.self) ?? 0) %") } }
            .frame(height: 170)
        }
        .padding(.vertical, 6)
    }

    private func dailyChart(_ account: String) -> some View {
        let values = dailyUse.filter { $0.group == account }
        return VStack(alignment: .leading, spacing: 6) {
            Text("Verbrauch pro Tag").font(.subheadline.weight(.semibold))
            Text("Prozentpunkte des längsten Limits (z. B. 7 Tage), die an dem Tag dazukamen")
                .font(.caption).foregroundStyle(.secondary)
            if values.isEmpty {
                Text("Noch kein Verbrauch aufgezeichnet.").font(.caption).foregroundStyle(.tertiary)
            } else {
                Chart(values) { v in
                    BarMark(x: .value("Tag", v.day, unit: .day), y: .value("Verbrauch", v.value * 100))
                        .foregroundStyle(Theme.accent)
                }
                .chartYAxis { AxisMarks { v in AxisGridLine(); AxisValueLabel("\(v.as(Int.self) ?? 0) %") } }
                .frame(height: 130)
            }
        }
        .padding(.vertical, 6)
    }

    private var machineChart: some View {
        Chart(hoursByMachine) { v in
            BarMark(x: .value("Tag", v.day, unit: days == 1 ? .hour : .day), y: .value("Stunden", v.value / 3600))
                .foregroundStyle(by: .value("Maschine", v.group))
        }
        .chartYAxis { AxisMarks { v in AxisGridLine(); AxisValueLabel("\(v.as(Double.self).map { String(format: "%.0f h", $0) } ?? "")") } }
        .frame(height: 170)
        .padding(.vertical, 6)
    }

    // MARK: derived data

    /// "Claude · Konto" – one chart section each
    private var accounts: [String] {
        Array(Set(limitPoints.map { String($0.series.split(separator: " · ").prefix(2).joined(separator: " · ")) })).sorted()
    }

    private static func seriesKey(_ l: UsageHistory.Limit) -> (account: String, window: String) {
        let provider = UsageLimit.name(l.p)
        let account = l.a.map { "\(provider) · \($0)" } ?? "\(provider) · –"
        return (account, l.l == l.w || l.l.isEmpty ? l.w : l.l)
    }

    private var limitPoints: [LimitPoint] {
        // same account on several servers: one point per 10-minute slot
        var seen = Set<String>()
        var out: [LimitPoint] = []
        for sample in histories.flatMap(\.history.samples).sorted(by: { $0.at < $1.at }) {
            let slot = Int(sample.at / 600_000)
            for l in sample.limits {
                let key = Self.seriesKey(l)
                let series = "\(key.account) · \(key.window)"
                guard seen.insert("\(series)|\(slot)").inserted else { continue }
                out.append(LimitPoint(series: series, date: Date(timeIntervalSince1970: sample.at / 1000), used: l.u))
            }
        }
        return out
    }

    /// Sum of increases of each account's longest window per day (resets are drops, not use).
    private var dailyUse: [DayValue] {
        let cal = Calendar.current
        var byAccount: [String: [LimitPoint]] = [:]
        for p in limitPoints { byAccount[String(p.series.split(separator: " · ").prefix(2).joined(separator: " · ")), default: []].append(p) }
        var out: [DayValue] = []
        for (account, points) in byAccount {
            // longest window = the one whose name says day/week/month, else the first
            let series = Dictionary(grouping: points, by: \.series)
            guard let main = series.keys.sorted(by: { Self.windowRank($0) > Self.windowRank($1) }).first,
                  let line = series[main]?.sorted(by: { $0.date < $1.date }) else { continue }
            var perDay: [Date: Double] = [:]
            for (a, b) in zip(line, line.dropFirst()) where b.used > a.used {
                perDay[cal.startOfDay(for: b.date), default: 0] += b.used - a.used
            }
            out += perDay.map { DayValue(day: $0.key, group: account, value: $0.value) }
        }
        return out
    }

    private static func windowRank(_ series: String) -> Int {
        let s = series.lowercased()
        if s.contains("fable") { return 0 }
        if s.contains("month") || s.contains("monat") { return 4 }
        if s.contains("7") || s.contains("week") || s.contains("day") { return 3 }
        return 1
    }

    private var hoursByMachine: [DayValue] {
        let cal = Calendar.current
        var sums: [String: Double] = [:]
        for (server, history) in histories {
            for bucket in history.activity {
                let date = Date(timeIntervalSince1970: bucket.at / 1000)
                let slot = days == 1 ? date : cal.startOfDay(for: date)
                sums["\(server.label)|\(slot.timeIntervalSince1970)", default: 0] += bucket.work.values.reduce(0, +)
            }
        }
        return sums.map { key, value in
            let parts = key.split(separator: "|")
            return DayValue(day: Date(timeIntervalSince1970: Double(parts[1]) ?? 0), group: String(parts[0]), value: value)
        }
    }

    private var kindTotals: [(kind: String, seconds: Double)] {
        var sums: [String: Double] = [:]
        for bucket in histories.flatMap(\.history.activity) {
            for (kind, seconds) in bucket.work { sums[kind, default: 0] += seconds }
        }
        return sums.map { ($0.key, $0.value) }.sorted { $0.seconds > $1.seconds }
    }

    private static func hours(_ seconds: Double) -> String {
        seconds >= 3600 ? String(format: "%.1f h", seconds / 3600) : "\(Int(seconds / 60)) min"
    }

    private func load() async {
        loading = true
        var result: [(Server, UsageHistory)] = []
        var failed: [String] = []
        await withTaskGroup(of: (Server, UsageHistory?).self) { group in
            for server in store.servers {
                group.addTask { (server, try? await HollrClient.usageHistory(server, days: days)) }
            }
            for await (server, history) in group {
                if let history { result.append((server, history)) } else { failed.append(server.label) }
            }
        }
        histories = result.map { (server: $0.0, history: $0.1) }
        error = failed.isEmpty ? nil : String(localized: "Kein Verlauf von: \(failed.joined(separator: ", ")) (Hollr-Server aktualisieren)")
        loading = false
    }
}
