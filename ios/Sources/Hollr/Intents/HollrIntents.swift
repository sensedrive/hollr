import AppIntents
import Foundation

/// An agent for Shortcuts / Siri – from the snapshot the app keeps for the widgets.
struct AgentEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Agent"
    static var defaultQuery = AgentQuery()

    var id: String
    var title: String
    var agent: String
    var server: String
    var fp: String
    var pane: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(agent) · \(server)")
    }

    init(_ a: WidgetSnapshot.Agent) {
        id = a.id
        title = a.title
        agent = a.agent
        server = a.server
        fp = a.fp
        pane = a.pane
    }
}

struct AgentQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [AgentEntity] {
        WidgetSnapshot.load().agents.filter { identifiers.contains($0.id) }.map(AgentEntity.init)
    }

    func entities(matching string: String) async throws -> [AgentEntity] {
        let q = string.lowercased()
        return WidgetSnapshot.load().ranked
            .filter { $0.title.lowercased().contains(q) || $0.server.lowercased().contains(q) }
            .map(AgentEntity.init)
    }

    func suggestedEntities() async throws -> [AgentEntity] {
        WidgetSnapshot.load().ranked.filter { $0.agent != "Shell" }.map(AgentEntity.init)
    }
}

/// "Frag tendr, ob die Tests grün sind" – sends a prompt without opening the app.
struct AskAgentIntent: AppIntent {
    static var title: LocalizedStringResource = "Agent fragen"
    static var description = IntentDescription("Schickt eine Nachricht an einen Agent auf deinem Server.")

    @Parameter(title: "Agent") var agent: AgentEntity
    @Parameter(title: "Nachricht", inputOptions: String.IntentInputOptions(multiline: true)) var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Frag \(\.$agent): \(\.$text)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let server = ServerStore().servers.first(where: { $0.hostFingerprint == agent.fp }) else {
            throw HollrError.server(String(localized: "Der Server dieses Agents ist nicht mehr gekoppelt."))
        }
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { throw HollrError.server(String(localized: "Die Nachricht ist leer.")) }
        try await HollrClient.prompt(server, pane: agent.pane, text: message)
        return .result(dialog: "An \(agent.title) gesendet.")
    }
}

struct OpenAgentIntent: AppIntent {
    static var title: LocalizedStringResource = "Agent öffnen"
    static var openAppWhenRun = true

    @Parameter(title: "Agent") var agent: AgentEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        PushManager.shared.openRequest = (agent.fp, agent.pane)
        return .result()
    }
}

/// Opens the chat and starts omp /live – e.g. on the Action button.
struct StartLiveIntent: AppIntent {
    static var title: LocalizedStringResource = "Live starten"
    static var description = IntentDescription("Öffnet den Agent und startet ein Live-Gespräch mit omp.")
    static var openAppWhenRun = true

    @Parameter(title: "Agent") var agent: AgentEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        PushManager.shared.liveRequest = (agent.fp, agent.pane)
        return .result()
    }
}

struct HollrShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskAgentIntent(),
            phrases: ["Frag einen Agent in \(.applicationName)", "Frag \(\.$agent) in \(.applicationName)"],
            shortTitle: "Agent fragen", systemImageName: "text.bubble"
        )
        AppShortcut(
            intent: StartLiveIntent(),
            phrases: ["Starte Live in \(.applicationName)", "Live mit \(\.$agent) in \(.applicationName)"],
            shortTitle: "Live starten", systemImageName: "waveform"
        )
        AppShortcut(
            intent: OpenAgentIntent(),
            phrases: ["Öffne \(\.$agent) in \(.applicationName)"],
            shortTitle: "Agent öffnen", systemImageName: "bubble.left.and.text.bubble.right"
        )
    }
}
