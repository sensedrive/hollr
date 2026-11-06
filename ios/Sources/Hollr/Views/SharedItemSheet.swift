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
                Section {
                    if item.file != nil { Label(item.fileName ?? "Bild / Datei", icon: .image) }
                    if !item.text.isEmpty { Text(item.text).font(Typo.note).lineLimit(8) }
                } header: {
                    SectionHeader(title: String(localized: "Geteilt"))
                }
                .listRowBackground(Theme.card)
                if let error {
                    Section { Label(error, icon: .alert).font(Typo.sm).foregroundStyle(Theme.warn) }
                        .listRowBackground(Theme.card)
                }
                Section {
                    ForEach(agents) { ref in
                        Button { Task { await send(to: ref) } } label: {
                            HStack {
                                AgentRow(ref: ref, showServer: store.servers.count > 1)
                                if sending == ref.id { Spinner(color: Theme.accent) }
                            }
                        }
                        .disabled(sending != nil)
                    }
                    if agents.isEmpty { Text("Keine Agents erreichbar.").foregroundStyle(Theme.muted) }
                } header: {
                    SectionHeader(title: String(localized: "An welchen Agent?"))
                }
                .listRowBackground(Theme.card)
            }
            .themedList()
            .navigationTitle("Teilen an …")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Später") { done() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button("Verwerfen", role: .destructive) { SharedItem.remove(item); done() }
                        .foregroundStyle(Theme.red)
                }
            }
        }
        .presentationBackground(Theme.bg)
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
