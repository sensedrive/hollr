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

/// Model dialog (organism ModelDialog): search, recently used, the list with the chosen model, thinking /
/// effort level. Without `onConfirm` a tap picks the model and closes; with it the footer confirms.
/// Present in a sheet with `.dialogSheet()`.
struct ModelPicker: View {
    let server: Server
    let kind: String
    /// nil = agent default
    @Binding var model: String?
    @Binding var level: String?
    var title = String(localized: "Modell")
    var current: String? = nil
    var confirmTitle: String? = nil
    /// quiet note under the list (dlg-note)
    var note: String? = nil
    /// what went wrong on confirming
    var problem: String? = nil
    var onConfirm: (() -> Void)? = nil
    @State private var list: ModelList?
    @State private var error: String?
    @State private var search = ""
    @FocusState private var searching: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if let confirmTitle, let onConfirm {
                DialogScaffold(icon: .cpu, title: title, onClose: { dismiss() }) {
                    content
                } footer: {
                    Button("Abbrechen") { dismiss() }.buttonStyle(.hollr())
                    Button(confirmTitle) { onConfirm() }
                        .buttonStyle(.hollr(.primary))
                        .disabled(model == nil)
                }
            } else {
                DialogScaffold(icon: .cpu, title: title, onClose: { dismiss() }) { content }
            }
        }
        .refreshable { await load(refresh: true) }
        .task { await load(refresh: false) }
    }

    @ViewBuilder private var content: some View {
        TextField("Modell suchen", text: $search, prompt: Text("Modell suchen …").foregroundStyle(Theme.dim))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($searching)
            .fieldStyle(focused: searching)
        if let current {
            HStack(spacing: Gap.s) {
                Text("Aktuell").foregroundStyle(Theme.muted)
                Spacer(minLength: Gap.s)
                Text(current).font(Typo.mono).lineLimit(1).truncationMode(.middle)
            }
        }
        if let list, !list.levels.isEmpty {
            DialogField(label: list.levelName) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Segmented(label: list.levelName,
                              options: [(value: "", title: String(localized: "Standard"))] + list.levels.map { (value: $0, title: $0) },
                              selection: Binding(get: { level ?? "" }, set: { level = $0.isEmpty ? nil : $0 }),
                              boxed: true)
                }
            }
        }
        if list == nil && error == nil {
            VStack(spacing: 6) {
                ForEach(0..<6, id: \.self) { _ in
                    ChoiceRow(selected: false) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Modellname lädt").font(Typo.md)
                            Text("anbieter/modell-id").font(Typo.monoSmall)
                        }
                    }
                }
            }
            .redacted(reason: .placeholder)
        }
        if search.isEmpty, onConfirm == nil {
            row(id: nil, name: String(localized: "Standard des Agents"), detail: nil)
        }
        let recent = RecentModels.list(kind).compactMap { id in list?.models.first { $0.id == id } }
        if search.isEmpty, !recent.isEmpty {
            group(String(localized: "Zuletzt"), recent.map { ($0, $0.id) })
        }
        ForEach(groups, id: \.name) { g in
            group(g.name, g.models.map { ($0, detail($0)) })
        }
        if let error { Text(error).font(Typo.sm).foregroundStyle(Theme.warn) }
        if let problem { Text(problem).font(Typo.sm).foregroundStyle(Theme.warn) }
        if let note { Text(note).font(Typo.sm).foregroundStyle(Theme.dim) }
    }

    private func group(_ name: String, _ models: [(ModelOption, String)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(title: name)
            ForEach(models, id: \.0.id) { item in row(id: item.0.id, name: item.0.name, detail: item.1) }
        }
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
            ChoiceRow(selected: model == id) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(Typo.md).foregroundStyle(Theme.fg)
                    if let detail { Text(detail).font(Typo.monoSmall).foregroundStyle(Theme.dim).lineLimit(1) }
                }
                Spacer(minLength: Gap.s)
                if model == id { IconView(.check, size: 14).foregroundStyle(Theme.accent) }
            }
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
        Group {
            if ref.pane.agent == "codex" {
                DialogScaffold(icon: .cpu, title: String(localized: "Modell wechseln"), onClose: { dismiss() }) {
                    Text("Codex wechselt das Modell nur über seine eigene Auswahl im Terminal.")
                    Text("Danach über die Tasten ↑ ↓ und Enter wählen.").font(Typo.sm).foregroundStyle(Theme.dim)
                } footer: {
                    Button("Abbrechen") { dismiss() }.buttonStyle(.hollr())
                    Button("Auswahl in Codex öffnen (/model)") {
                        session.sendText("/model")
                        dismiss()
                    }
                    .buttonStyle(.hollr(.primary))
                }
            } else {
                ModelPicker(server: ref.server, kind: ref.pane.agent ?? "omp", model: $model, level: $level,
                            title: String(localized: "Modell wechseln"),
                            current: session.timeline?.line?.model ?? session.timeline?.model,
                            confirmTitle: busy ? "…" : String(localized: "Wechseln"),
                            note: ref.pane.agent == "omp"
                                ? String(localized: "Gilt nur für diese Sitzung – omps Standard bleibt.")
                                : String(localized: "Wechselt das Modell dieser Claude-Sitzung (/model)."),
                            problem: error) {
                    Task { await apply() }
                }
            }
        }
        .dialogSheet()
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
