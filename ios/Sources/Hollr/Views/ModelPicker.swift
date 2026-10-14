import SwiftUI

struct ModelOption: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let group: String
    let context: Int?
}

struct ModelList: Decodable {
    let kind: String
    let models: [ModelOption]
    let levels: [String]
    let levelName: String
    let canSwitch: Bool
}

extension HollrClient {
    static func models(_ server: Server, kind: String, refresh: Bool = false) async throws -> ModelList {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.executeCommand(refresh ? "models \(kind) refresh" : "models \(kind)").readableBytesView)
        if let err = try? JSONDecoder().decode([String: String].self, from: data), let message = err["error"] {
            throw HollrError.server(message)
        }
        return try JSONDecoder().decode(ModelList.self, from: data)
    }

    /// Session-only model switch in a running agent (omp `/switch`, Claude `/model`).
    static func switchModel(_ server: Server, pane: String, model: String, level: String?) async throws {
        struct R: Decodable { let ok: Bool? }
        var body: [String: Any] = ["model": model]
        if let level { body["level"] = level }
        _ = try await fs(server, body, as: R.self, command: "model \(pane)")
    }
}

/// Recently used models per agent kind (shown on top of the picker).
enum RecentModels {
    static func list(_ kind: String) -> [String] {
        UserDefaults.standard.stringArray(forKey: "models.recent.\(kind)") ?? []
    }

    static func add(_ id: String, kind: String) {
        var l = list(kind)
        l.removeAll { $0 == id }
        l.insert(id, at: 0)
        UserDefaults.standard.set(Array(l.prefix(6)), forKey: "models.recent.\(kind)")
    }
}

/// Searchable model list with thinking / effort level.
struct ModelPicker: View {
    let server: Server
    let kind: String
    /// nil = agent default
    @Binding var model: String?
    @Binding var level: String?
    var current: String? = nil
    var confirmTitle: String? = nil
    var onConfirm: (() -> Void)? = nil
    @State private var list: ModelList?
    @State private var error: String?
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Group {
                if let current {
                    Section { LabeledContent("Aktuell", value: current) }
                }
                if let list, !list.levels.isEmpty {
                    Section {
                        Picker(list.levelName, selection: Binding(get: { level ?? "" }, set: { level = $0.isEmpty ? nil : $0 })) {
                            Text("Standard").tag("")
                            ForEach(list.levels, id: \.self) { Text($0).tag($0) }
                        }
                    }
                }
                if search.isEmpty, onConfirm == nil {
                    Section {
                        row(id: nil, name: String(localized: "Standard des Agents"), detail: nil)
                    }
                }
                let recent = RecentModels.list(kind).compactMap { id in list?.models.first { $0.id == id } }
                if search.isEmpty, !recent.isEmpty {
                    Section("Zuletzt") {
                        ForEach(recent) { m in row(id: m.id, name: m.name, detail: m.id) }
                    }
                }
                ForEach(groups, id: \.name) { group in
                    Section(group.name) {
                        ForEach(group.models) { m in row(id: m.id, name: m.name, detail: detail(m)) }
                    }
                }
                if let error { Text(error).foregroundStyle(Theme.warn) }
            }
            .listRowBackground(Theme.card)
        }
        .themedList()
        .overlay {
            if list == nil && error == nil {
                List(0..<8, id: \.self) { _ in
                    VStack(alignment: .leading) {
                        Text("Modellname lädt").font(.body)
                        Text("anbieter/modell-id").font(.caption)
                    }
                    .redacted(reason: .placeholder)
                    .listRowBackground(Theme.card)
                }
                .themedList()
            }
        }
        .searchable(text: $search, prompt: "Modell suchen")
        .navigationTitle("Modell")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let confirmTitle, let onConfirm {
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmTitle) { onConfirm() }.bold().disabled(model == nil)
                }
            }
        }
        .refreshable { await load(refresh: true) }
        .task { await load(refresh: false) }
    }

    private var groups: [(name: String, models: [ModelOption])] {
        let models = (list?.models ?? []).filter {
            search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.id.localizedCaseInsensitiveContains(search)
        }
        var order: [String] = []
        var map: [String: [ModelOption]] = [:]
        for m in models {
            if map[m.group] == nil { order.append(m.group) }
            map[m.group, default: []].append(m)
        }
        return order.map { ($0, map[$0] ?? []) }
    }

    private func detail(_ m: ModelOption) -> String {
        var parts = [m.id]
        if let ctx = m.context, ctx > 0 { parts.append(ctx >= 1_000_000 ? "\(ctx / 1_000_000)M" : "\(ctx / 1000)k") }
        return parts.joined(separator: " · ")
    }

    private func row(id: String?, name: String, detail: String?) -> some View {
        Button {
            model = id
            if let id { RecentModels.add(id, kind: kind) }
            if onConfirm == nil { dismiss() }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).foregroundStyle(.primary)
                    if let detail { Text(detail).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer()
                if model == id { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func load(refresh: Bool) async {
        do {
            list = try await HollrClient.models(server, kind: kind, refresh: refresh)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Sheet for switching the model of a running session.
struct ModelSwitchSheet: View {
    let session: AgentSession
    @State private var model: String?
    @State private var level: String?
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    private var ref: AgentRef { session.ref }

    var body: some View {
        NavigationStack {
            if ref.pane.agent == "codex" {
                VStack(spacing: 16) {
                    Image(systemName: "cpu").font(.largeTitle).foregroundStyle(Theme.accent)
                    Text("Codex wechselt das Modell nur über seine eigene Auswahl im Terminal.")
                        .multilineTextAlignment(.center)
                    Button("Auswahl in Codex öffnen (/model)") {
                        session.sendText("/model")
                        dismiss()
                    }
                    .buttonStyle(.borderedProminent)
                    Text("Danach mit >_ ↑ ↓ und Enter wählen.").font(.caption).foregroundStyle(.secondary)
                }
                .padding(24)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } } }
            } else {
                ModelPicker(server: ref.server, kind: ref.pane.agent ?? "omp", model: $model, level: $level,
                            current: session.timeline?.line?.model ?? session.timeline?.model,
                            confirmTitle: busy ? "…" : "Wechseln") {
                    Task { await apply() }
                }
                .safeAreaInset(edge: .bottom) {
                    VStack(spacing: 4) {
                        if let error { Text(error).font(.footnote).foregroundStyle(Theme.warn) }
                        Text(ref.pane.agent == "omp"
                             ? String(localized: "Gilt nur für diese Sitzung – omps Standard bleibt.")
                             : String(localized: "Wechselt das Modell dieser Claude-Sitzung (/model)."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity)
                    .background(.bar)
                }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } } }
            }
        }
    }

    private func apply() async {
        guard let model else { return }
        busy = true
        defer { busy = false }
        do {
            try await HollrClient.switchModel(ref.server, pane: ref.pane.pane, model: model, level: level)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

}
