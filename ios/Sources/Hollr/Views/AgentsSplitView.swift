import SwiftUI

/// Mac (and any wide window): agents in a sidebar, one or two chats side by side.
struct AgentsSplitView: View {
    var onNewChat: () -> Void
    @Binding var selection: String?
    @State private var beside: String?
    @State private var primaryPath: [String] = []
    @State private var besidePath: [String] = []

    var body: some View {
        NavigationSplitView {
            AgentListView(onNewChat: onNewChat, selection: $selection) { id in
                if selection == nil { selection = id } else if id != selection { beside = id }
            }
            .navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 420)
        } detail: {
            HStack(spacing: 0) {
                if let selection {
                    NavigationStack {
                        AgentDetailView(agentId: primaryPath.last ?? selection, path: $primaryPath)
                    }
                    .id(selection)
                } else {
                    EmptyState(icon: .message, title: String(localized: "Kein Agent gewählt"),
                               text: String(localized: "Links einen Agent wählen – Rechtsklick › „Rechts daneben öffnen“ zeigt einen zweiten daneben."))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.bg)
                }
                if let beside {
                    Rectangle().fill(Theme.border).frame(width: 1)
                    NavigationStack {
                        AgentDetailView(agentId: besidePath.last ?? beside, path: $besidePath)
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) {
                                    Button { self.beside = nil } label: { Image(.x) }
                                        .buttonStyle(.icon())
                                        .accessibilityLabel("Zweiten Chat schließen")
                                }
                            }
                    }
                    .id(beside)
                    .frame(minWidth: 360)
                }
            }
        }
        .onChange(of: selection) { _, _ in primaryPath = [] }
        .onChange(of: beside) { _, _ in besidePath = [] }
    }
}
