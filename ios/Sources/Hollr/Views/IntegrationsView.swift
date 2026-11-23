import SwiftUI

extension HollrClient {
    /// JIRA credentials as a server reports them: never the token (it is not even decoded).
    struct JiraStatus: Decodable, Equatable {
        let site: String
        let email: String
        let account: String?
        let updatedAt: String?
    }

    struct SecretsStatus: Decodable, Equatable { let jira: JiraStatus? }

    /// What is stored on the server (`secrets` gate command); the token never comes back.
    static func secretsStatus(_ server: Server) async throws -> SecretsStatus {
        try await fs(server, ["op": "status"], as: SecretsStatus.self, command: "secrets", seconds: 15)
    }

    /// Verifies the credentials against JIRA on the server and stores them there; returns the account name.
    static func setJira(_ server: Server, site: String, email: String, token: String) async throws -> String? {
        struct R: Decodable { let ok: Bool?; let account: String? }
        let body = ["op": "set", "name": "jira", "site": site, "email": email, "token": token]
        return try await fs(server, body, as: R.self, command: "secrets", seconds: 25).account
    }

    static func deleteJira(_ server: Server) async throws {
        struct R: Decodable { let ok: Bool? }
        _ = try await fs(server, ["op": "delete", "name": "jira"], as: R.self, command: "secrets", seconds: 15)
    }
}

enum JiraSite {
    /// `https://foo.atlassian.net/` → `foo.atlassian.net`; nil when it is no Atlassian cloud site.
    static func normalized(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if s.hasPrefix("https://") { s.removeFirst(8) }
        while s.hasSuffix("/") { s.removeLast() }
        return s.range(of: #"^[a-z0-9][a-z0-9-]*\.atlassian\.net$"#, options: .regularExpression) != nil ? s : nil
    }
}

/// Settings › Integrationen: JIRA credentials entered once, stored on every paired server.
struct IntegrationsView: View {
    @Environment(ServerStore.self) private var store
    @State private var site = "leicht-luftig.atlassian.net"
    @State private var email = ""
    @State private var token = ""
    @State private var states: [Server.ID: Status] = [:]
    @State private var results: [Server.ID: Result] = [:]
    @State private var saving = false
    @State private var removing: Server?
    @State private var formError: String?

    private enum Status: Equatable {
        case stored(HollrClient.JiraStatus)
        case missing
        case offline
        case tooOld
        case failed(String)
    }

    private enum Result: Equatable {
        case ok
        case failed(String)
    }

    var body: some View {
        List {
            Section {
                TextField("Site", text: $site)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                TextField("E-Mail", text: $email)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress)
                SecureField("API-Token", text: $token)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                if let url = URL(string: "https://id.atlassian.com/manage-profile/security/api-tokens") {
                    Link(destination: url) { Label("Token anlegen", icon: .external) }
                }
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        Text("Auf allen Rechnern speichern")
                        if saving { Spacer(); ProgressView() }
                    }
                }
                .disabled(saving || token.isEmpty || email.isEmpty)
                if let formError { Text(formError).font(Typo.sm).foregroundStyle(Theme.red) }
            } header: {
                SectionHeader(title: "JIRA")
            } footer: {
                Text("Das Token wird auf jedem gekoppelten Rechner gespeichert und nie wieder angezeigt.")
                    .font(Typo.sm).foregroundStyle(Theme.dim)
            }
            Section {
                ForEach(store.servers) { server in
                    row(server).listRowBackground(Theme.card)
                }
            } header: {
                SectionHeader(title: String(localized: "Rechner"))
            }
        }
        .themedList()
        .navigationTitle("Integrationen")
        .task { await reload() }
        .refreshable { await reload() }
        .confirmationDialog(String(localized: "JIRA-Zugang entfernen?"),
                            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { server in
            Button("Entfernen", role: .destructive) { Task { await remove(server) } }
        } message: { server in
            Text(server.label)
        }
    }

    private func row(_ server: Server) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(server.label).font(Typo.md)
                Text(statusText(states[server.id])).font(Typo.sm).foregroundStyle(Theme.muted)
                switch results[server.id] {
                case .ok: Text("✓ gespeichert").font(Typo.sm).foregroundStyle(Theme.live)
                case let .failed(message): Text(message).font(Typo.sm).foregroundStyle(Theme.red)
                case nil: EmptyView()
                }
            }
            Spacer()
            if case .stored = states[server.id] {
                Button("Entfernen", role: .destructive) { removing = server }.buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
    }

    private func statusText(_ status: Status?) -> String {
        switch status {
        case nil: return String(localized: "Lade …")
        case let .stored(jira):
            var parts = [String(localized: "angemeldet als \(jira.account ?? jira.email)"), jira.email]
            if let date = jira.updatedAt.flatMap({ ISO8601DateFormatter.lenient($0) }) {
                parts.append(date.formatted(date: .abbreviated, time: .shortened))
            }
            return parts.joined(separator: " · ")
        case .missing: return String(localized: "nicht hinterlegt")
        case .offline: return String(localized: "offline")
        case .tooOld: return String(localized: "Hollr zu alt – in Werkzeuge aktualisieren")
        case let .failed(message): return message
        }
    }

    private static func status(_ server: Server) async -> Status {
        do {
            let r = try await HollrClient.secretsStatus(server)
            return r.jira.map(Status.stored) ?? .missing
        } catch HollrError.server("not_allowed") {
            return .tooOld
        } catch HollrError.server(let message) {
            return .failed(message)
        } catch HollrError.badResponse {
            return .failed(HollrError.badResponse.localizedDescription)
        } catch {
            return .offline
        }
    }

    private func reload() async {
        await withTaskGroup(of: (Server.ID, Status).self) { group in
            for server in store.servers {
                group.addTask { (server.id, await Self.status(server)) }
            }
            for await (id, status) in group { states[id] = status }
        }
    }

    private func save() async {
        formError = nil
        guard let normalized = JiraSite.normalized(site) else {
            formError = String(localized: "Site muss wie name.atlassian.net aussehen.")
            return
        }
        let mail = email.trimmingCharacters(in: .whitespaces)
        guard mail.contains("@") else { formError = String(localized: "Bitte eine gültige E-Mail angeben."); return }
        guard token.count <= 400, token.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
            formError = String(localized: "Das Token darf keine Leerzeichen enthalten.")
            return
        }
        site = normalized
        saving = true
        defer { saving = false }
        results = [:]
        let secret = token
        let targets = store.servers.filter { states[$0.id] != .offline && states[$0.id] != .tooOld }
        await withTaskGroup(of: (Server.ID, Result).self) { group in
            for server in targets {
                group.addTask {
                    do {
                        _ = try await HollrClient.setJira(server, site: normalized, email: mail, token: secret)
                        return (server.id, .ok)
                    } catch {
                        return (server.id, .failed(error.localizedDescription))
                    }
                }
            }
            for await (id, result) in group { results[id] = result }
        }
        if !targets.isEmpty, targets.allSatisfy({ results[$0.id] == .ok }), targets.count == store.servers.count {
            token = ""
        }
        await reload()
    }

    private func remove(_ server: Server) async {
        do {
            try await HollrClient.deleteJira(server)
            results[server.id] = nil
        } catch {
            results[server.id] = .failed(error.localizedDescription)
        }
        states[server.id] = await Self.status(server)
    }
}

private extension ISO8601DateFormatter {
    static func lenient(_ text: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: text) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: text)
    }
}
