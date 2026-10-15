import SwiftUI

/// Something shared to Hollr (share sheet): pick the agent that gets it.
struct SharedItemSheet: View {
    let item: SharedItem
    let done: () -> Void
    @Environment(ServerStore.self) private var store
    @Environment(HerdrStore.self) private var herdr
    @Environment(SessionStore.self) private var sessions
    @State private var sending: String?
    @State private var error: String?

    private var agents: [AgentRef] {
        let rank = ["blocked": 0, "working": 1, "done": 2, "idle": 3]
        return herdr.allAgents(store.servers).sorted { (rank[$0.pane.status] ?? 4, $0.title) < (rank[$1.pane.status] ?? 4, $1.title) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Geteilt") {
                    if item.file != nil { Label(item.fileName ?? "Bild / Datei", systemImage: "photo") }
                    if !item.text.isEmpty { Text(item.text).font(.footnote).lineLimit(8) }
                }
                if let error { Section { Text(error).foregroundStyle(Theme.warn) } }
                Section("An welchen Agent?") {
                    ForEach(agents) { ref in
                        Button { Task { await send(to: ref) } } label: {
                            HStack {
                                AgentRow(ref: ref, showServer: store.servers.count > 1)
                                if sending == ref.id { ProgressView() }
                            }
                        }
                        .disabled(sending != nil)
                    }
                    if agents.isEmpty { Text("Keine Agents erreichbar.").foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Teilen an …")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Später") { done() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button("Verwerfen", role: .destructive) { SharedItem.remove(item); done() }
                }
            }
        }
    }

    private func send(to ref: AgentRef) async {
        sending = ref.id
        defer { sending = nil }
        do {
            var text = item.text
            if let data = item.file {
                let path = try await HollrClient.upload(ref.server, name: item.fileName ?? "datei", data: data)
                text = [text, path].filter { !$0.isEmpty }.joined(separator: "\n")
            }
            sessions.session(for: ref).sendText(text)
            SharedItem.remove(item)
            Haptics.notify(.success)
            done()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
