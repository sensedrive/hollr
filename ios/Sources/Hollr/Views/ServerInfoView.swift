import SwiftUI
import UIKit

struct ServerInfo: Decodable {
    struct Memory: Decodable { let total: Double; let used: Double; let swapTotal: Double; let swapUsed: Double }
    struct Disk: Decodable, Identifiable { let mount: String; let total: Double; let used: Double; var id: String { mount } }
    struct Process: Decodable, Identifiable {
        let pid: Int
        let user: String
        let cpu: Double
        let mem: Double
        let rssMb: Int
        let name: String
        let command: String
        let stack: Bool
        var id: Int { pid }
    }
    struct Check: Decodable, Identifiable {
        let name: String
        let ok: Bool
        let detail: String
        let fix: String?
        /// stable key ("herdr", "Push-Schlüssel" …) – name is translated
        var key: String? = nil
        /// what the setup checklist can do: "tool:herdr", "watch", "push"
        var action: String? = nil
        var id: String { name }

        enum CodingKeys: String, CodingKey { case name, ok, detail, fix, key = "id", action }

        init(name: String, ok: Bool, detail: String, fix: String?) {
            self.name = name
            self.ok = ok
            self.detail = detail
            self.fix = fix
        }
    }

    let host: String
    let os: String
    let kernel: String
    let arch: String
    let user: String
    let uptime: Double
    let hollr: String
    let cores: Int
    let load: [Double]
    let cpu: Double?
    let memory: Memory
    let disks: [Disk]
    let processes: [Process]
    let checks: [Check]

    static let placeholder = ServerInfo(
        host: "server-name", os: "Linux Distribution 24.04", kernel: "6.8.0-generic", arch: "x64", user: "user",
        uptime: 100_000, hollr: "0.0.0", cores: 8, load: [1, 1, 1], cpu: 20,
        memory: Memory(total: 32e9, used: 12e9, swapTotal: 0, swapUsed: 0),
        disks: [Disk(mount: "/", total: 300e9, used: 120e9)],
        processes: (1...8).map { Process(pid: $0, user: "user", cpu: 1, mem: 1, rssMb: 100, name: "process-name", command: "", stack: false) },
        checks: (1...6).map { Check(name: String(localized: "Prüfung \($0) läuft"), ok: true, detail: String(localized: "Details"), fix: nil) }
    )
}

extension HollrClient {
    static func sysinfo(_ server: Server) async throws -> ServerInfo {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.executeCommand("sysinfo \(HollrClient.appLanguage)").readableBytesView)
        return try JSONDecoder().decode(ServerInfo.self, from: data)
    }
}

/// Server check: load, memory, disks, processes and whether the setup is correct.
struct ServerInfoView: View {
    let server: Server
    @State private var info: ServerInfo?
    @State private var error: String?
    @State private var onlyStack = false
    @State private var search = ""

    var body: some View {
        let shown = info ?? .placeholder
        List {
            Group {
            if let error {
                Label(error, icon: .alert).font(Typo.sm).foregroundStyle(Theme.warn)
            }
            Section {
                VStack(alignment: .leading, spacing: Gap.xs) {
                    Text(shown.host).font(.title3.weight(.semibold))
                    Text("\(shown.os) · \(shown.arch)").font(Typo.md).foregroundStyle(Theme.muted)
                    Text("Kernel \(shown.kernel) · läuft seit \(Self.duration(shown.uptime)) · Hollr \(shown.hollr)")
                        .font(Typo.sm).foregroundStyle(Theme.dim)
                }
                .padding(.vertical, Gap.xs)
            }
            Section {
                Meter(title: "CPU", value: (shown.cpu ?? 0) / 100,
                      label: shown.cpu.map { "\(Int($0.rounded())) % · \(shown.cores) Kerne" } ?? "\(shown.cores) Kerne")
                Meter(title: "Last", value: (shown.load.first ?? 0) / Double(max(shown.cores, 1)),
                      label: shown.load.map { String(format: "%.2f", $0) }.joined(separator: " · "))
                Meter(title: "RAM", value: shown.memory.used / max(shown.memory.total, 1),
                      label: "\(Self.bytes(shown.memory.used)) / \(Self.bytes(shown.memory.total))")
                if shown.memory.swapTotal > 0 {
                    Meter(title: "Swap", value: shown.memory.swapUsed / shown.memory.swapTotal,
                          label: "\(Self.bytes(shown.memory.swapUsed)) / \(Self.bytes(shown.memory.swapTotal))")
                }
                ForEach(shown.disks) { disk in
                    Meter(title: disk.mount, value: disk.used / max(disk.total, 1),
                          label: "\(Self.bytes(disk.used)) / \(Self.bytes(disk.total))")
                }
            } header: {
                SectionHeader(title: String(localized: "Auslastung"))
            }
            Section {
                ForEach(shown.checks) { check in
                    VStack(alignment: .leading, spacing: Gap.xs) {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(check.ok ? HIcon.check : HIcon.alert)
                                .foregroundStyle(check.ok ? Theme.green : Theme.warn)
                            Text(check.name).font(Typo.md)
                            Spacer()
                        }
                        Text(check.detail).font(Typo.sm).foregroundStyle(Theme.muted).lineLimit(2)
                        if !check.ok, let fix = check.fix {
                            Button {
                                UIPasteboard.general.string = fix
                            } label: {
                                Label(fix, icon: .copy).font(Typo.monoSmall).lineLimit(2)
                                    .foregroundStyle(Theme.accent)
                            }
                        }
                    }
                }
            } header: {
                let failed = shown.checks.filter { !$0.ok }.count
                SectionHeader(title: failed == 0 ? String(localized: "Einrichtung · alles korrekt")
                                                 : String(localized: "Einrichtung · \(failed) Problem(e)"))
            }
            Section {
                Segmented(label: String(localized: "Prozesse · nach CPU"),
                          options: [(false, String(localized: "Alle")), (true, String(localized: "Hollr & Agents"))],
                          selection: $onlyStack, boxed: true)
                ForEach(shown.processes.filter { (!onlyStack || $0.stack) && (search.isEmpty || $0.command.localizedCaseInsensitiveContains(search) || $0.name.localizedCaseInsensitiveContains(search)) }) { p in
                    ProcessRow(process: p)
                }
            } header: {
                SectionHeader(title: String(localized: "Prozesse · nach CPU"))
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .redacted(reason: info == nil && error == nil ? .placeholder : [])
        .searchable(text: $search, prompt: "Prozess suchen")
        .navigationTitle("Server-Info")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func load() async {
        do {
            info = try await HollrClient.sysinfo(server)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    static func bytes(_ v: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(v), countStyle: .memory)
    }

    static func duration(_ seconds: Double) -> String {
        let d = Int(seconds) / 86400, h = (Int(seconds) % 86400) / 3600, m = (Int(seconds) % 3600) / 60
        return d > 0 ? "\(d) T \(h) h" : h > 0 ? "\(h) h \(m) min" : "\(m) min"
    }
}

/// One load line: name, mono value, a ProgressMeter bar over the full row width (green, orange from 70 %, red from 90 %).
private struct Meter: View {
    let title: String
    let value: Double
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(Typo.md).lineLimit(1)
                Spacer()
                Text(label).font(Typo.monoSmall.monospacedDigit()).foregroundStyle(Theme.muted)
            }
            GeometryReader { geo in
                ProgressMeter(value: value, width: geo.size.width, height: 6, color: color)
            }
            .frame(height: 6)
        }
        .padding(.vertical, 2)
    }

    private var color: Color { value > 0.9 ? Theme.red : value > 0.7 ? Theme.warn : Theme.green }
}

private struct ProcessRow: View {
    let process: ServerInfo.Process
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: Gap.s) {
                if process.stack { Circle().fill(Theme.accent).frame(width: 6, height: 6) }
                Text(process.name).font(Typo.md).lineLimit(1)
                Spacer()
                Text(String(format: "%.1f %%", process.cpu)).font(Typo.monoSmall.monospacedDigit())
                    .foregroundStyle(process.cpu > 50 ? Theme.warn : Theme.muted)
                Text("\(process.rssMb) MB").font(Typo.monoSmall.monospacedDigit()).foregroundStyle(Theme.muted)
                    .frame(width: 64, alignment: .trailing)
            }
            Text(verbatim: "\(process.pid) · \(process.user)").font(Typo.monoXS).foregroundStyle(Theme.dim)
            if expanded {
                Text(process.command).font(Typo.monoXS).foregroundStyle(Theme.muted).textSelection(.enabled)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.snappy) { expanded.toggle() } }
    }
}
