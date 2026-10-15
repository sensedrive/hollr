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
                    ContentUnavailableView("Kein Agent gewählt", systemImage: "sidebar.left",
                                           description: Text("Links einen Agent wählen – Rechtsklick › „Rechts daneben öffnen“ zeigt einen zweiten daneben."))
                }
                if let beside {
                    Divider()
                    NavigationStack {
                        AgentDetailView(agentId: besidePath.last ?? beside, path: $besidePath)
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) {
                                    Button { self.beside = nil } label: { Image(systemName: "xmark") }
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
