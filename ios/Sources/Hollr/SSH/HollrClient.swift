import Citadel
import CryptoKit
import Foundation
import NIOCore
import NIOSSH

extension HollrClient {
    /// "de" or "en" – sent to the server for texts it produces (server info, tools, push)
    static var appLanguage: String { Bundle.main.preferredLocalizations.first == "en" ? "en" : "de" }
}

enum HollrError: LocalizedError {
    case hostKeyMismatch(expected: String, got: String)
    case unreachable(String)
    case server(String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case let .hostKeyMismatch(expected, got):
            return String(localized: "Server-Schlüssel stimmt nicht (erwartet \(expected.prefix(18))…, bekommen \(got.prefix(18))…). Nicht verbinden – Server neu koppeln.")
        case let .unreachable(detail): return String(localized: "Server nicht erreichbar: \(detail)")
        case let .server(message): return message
        case .badResponse: return String(localized: "Unerwartete Antwort vom Server. Ist hollr dort aktuell? (install.sh erneut ausführen)")
        }
    }
}

/// Accepts exactly the host key whose fingerprint came with the pairing QR code.
final class PinnedHostKey: NIOSSHClientServerAuthenticationDelegate {
    let fingerprint: String
    init(_ fingerprint: String) { self.fingerprint = fingerprint }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let got = sshFingerprint(hostKey)
        if got == fingerprint {
            validationCompletePromise.succeed(())
        } else {
            validationCompletePromise.fail(HollrError.hostKeyMismatch(expected: fingerprint, got: got))
        }
    }
}

enum HollrClient {
    /// Connects to the first reachable address. The addresses are tried staggered (happy eyeballs):
    /// the last one that worked first, then every 1.5 s the next one in parallel – a server with
    /// many addresses (Docker bridges, Tailscale switched off) no longer costs 8 s per dead address.
    static func connect(
        addresses: [String], port: Int, user: String, fingerprint: String,
        key: Curve25519.Signing.PrivateKey
    ) async throws -> SSHClient {
        var hosts = addresses
        if let last = await ConnectionInfo.shared.via[fingerprint], let i = hosts.firstIndex(of: last) {
            hosts.insert(hosts.remove(at: i), at: 0)
        }
        guard !hosts.isEmpty else { throw HollrError.unreachable("keine Adresse") }
        let race = ConnectRace(count: hosts.count)
        let client: SSHClient
        do {
            client = try await connectRace(race, hosts: hosts, port: port, user: user, fingerprint: fingerprint, key: key)
        } catch {
            await ConnectionInfo.shared.failed(fingerprint: fingerprint)
            throw error
        }
        if let host = race.host { await ConnectionInfo.shared.connected(fingerprint: fingerprint, host: host) }
        return client
    }

    private static func connectRace(
        _ race: ConnectRace, hosts: [String], port: Int, user: String, fingerprint: String,
        key: Curve25519.Signing.PrivateKey
    ) async throws -> SSHClient {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { cont in
                race.start(cont)
                for (i, host) in hosts.enumerated() {
                    Task {
                        if i > 0 {
                            try? await Task.sleep(for: .milliseconds(1500 * i))
                            if race.isDone { return }
                        }
                        do {
                            let client = try await SSHClient.connect(
                                host: host,
                                port: port,
                                authenticationMethod: .ed25519(username: user, privateKey: key),
                                hostKeyValidator: .custom(PinnedHostKey(fingerprint)),
                                reconnect: .never,
                                connectTimeout: .seconds(8)
                            )
                            // a slower address that also made it: not needed
                            if !race.win(client, host: host) { try? await client.close() }
                        } catch let error as HollrError {
                            race.fail(error, fatal: true) // wrong host key: never try the next address
                        } catch {
                            race.fail(HollrError.unreachable("\(host): \(error.localizedDescription)"), fatal: false)
                        }
                    }
                }
            }
        } onCancel: {
            race.cancel()
        }
    }

    static func connect(_ server: Server) async throws -> SSHClient {
        try await connect(
            addresses: server.addresses, port: server.port, user: server.user,
            fingerprint: server.hostFingerprint, key: try DeviceKey.load()
        )
    }

    // MARK: Pairing

    /// Uses the one-time bootstrap key from the QR code to register this phone's own key.
    static func pair(_ payload: PairingPayload, deviceName: String) async throws -> Server {
        guard let seed = payload.bootstrapSeed else { throw PairingPayload.ParseError.malformed }
        let bootstrap = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        let client = try await connect(
            addresses: payload.a, port: payload.p, user: payload.u, fingerprint: payload.fp, key: bootstrap
        )
        defer { Task { try? await client.close() } }

        let request: [String: String] = ["pub": DeviceKey.publicLine(for: try DeviceKey.load()), "name": deviceName]
        let line = try await requestLine(client, command: "enroll", body: request)
        guard let obj = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
            throw HollrError.badResponse
        }
        guard obj["ok"] as? Bool == true, let deviceId = obj["device"] as? String else {
            let code = obj["error"] as? String ?? "unknown"
            throw HollrError.server(code == "expired" || code == "unknown_pairing"
                ? String(localized: "Der Code wurde schon benutzt oder ist abgelaufen. Auf dem Server neu erzeugen: hollr pair")
                : code == "denied"
                    ? String(localized: "Am Rechner abgelehnt.")
                    : code == "not_confirmed"
                        ? String(localized: "Am Rechner wurde nicht rechtzeitig bestätigt. Auf dem Server neu erzeugen: hollr pair")
                        : String(localized: "Kopplung abgelehnt (\(code))."))
        }
        var server = Server(
            label: payload.l, user: payload.u, addresses: payload.a, port: payload.p,
            hostFingerprint: payload.fp, deviceId: deviceId
        )
        server.network = payload.network
        return server
    }

    // MARK: Commands

    static func tree(_ server: Server) async throws -> [Workspace] {
        let client = try await SSHPool.shared.client(for: server)
        let buffer = try await client.exec("tree", on: server)
        struct Response: Decodable { let workspaces: [Workspace]?; let error: String? }
        let data = Data(buffer.readableBytesView)
        guard let response = try? JSONDecoder().decode(Response.self, from: data) else {
            HollrLog.error("tree: bad response \(String(decoding: data.prefix(300), as: UTF8.self))")
            throw HollrError.badResponse
        }
        if let error = response.error { throw HollrError.server(error) }
        return response.workspaces ?? []
    }

    /// nil = unchanged since `etag` (the server then only answers {"same":true}).
    static func timeline(_ server: Server, pane: String, limit: Int = 150, etag: String? = nil) async throws -> Timeline? {
        let client = try await SSHPool.shared.client(for: server)
        let command = etag.map { "timeline \(pane) \(limit) \($0)" } ?? "timeline \(pane) \(limit)"
        let data = Data(try await client.exec(command, on: server).readableBytesView)
        if data.count < 200, String(decoding: data, as: UTF8.self).contains("\"same\":true") { return nil }
        do {
            return try JSONDecoder().decode(Timeline.self, from: data)
        } catch {
            HollrLog.error("timeline decode: \(error) \(String(decoding: data.prefix(200), as: UTF8.self))")
            throw HollrError.badResponse
        }
    }

    static func spaces(_ server: Server) async throws -> [Space] {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.exec("spaces", on: server).readableBytesView)
        struct R: Decodable { let spaces: [Space] }
        return try JSONDecoder().decode(R.self, from: data).spaces
    }

    /// Web pages listening on the server's loopback (for the browser's quick links).
    static func ports(_ server: Server) async throws -> [WebPort] {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.exec("ports", on: server).readableBytesView)
        struct R: Decodable { let ports: [WebPort] }
        return try JSONDecoder().decode(R.self, from: data).ports
    }

    /// create / worktree / close a herdr workspace
    @discardableResult
    static func space(_ server: Server, _ body: [String: Any]) async throws -> (ws: String?, pane: String?) {
        struct R: Decodable { let ws: String?; let pane: String? }
        let r = try await fs(server, body, as: R.self, command: "space")
        return (r.ws, r.pane)
    }

    static func usage(_ server: Server, refresh: Bool = false) async throws -> (limits: [UsageLimit], capacity: [UsageCapacity]) {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.exec(refresh ? "usage refresh" : "usage", on: server).readableBytesView)
        struct R: Decodable { let limits: [UsageLimit]; let capacity: [UsageCapacity]? }
        let r = try JSONDecoder().decode(R.self, from: data)
        return (r.limits, r.capacity ?? [])
    }

    /// Read-only git / file access inside a space (server checks the path stays inside).
    /// Sends a file to the server for the agent; returns where it was stored (outside the repo).
    static func upload(_ server: Server, name: String, data: Data) async throws -> String {
        struct R: Decodable { let path: String }
        let body: [String: Any] = ["name": name, "data": data.base64EncodedString()]
        return try await fs(server, body, as: R.self, command: "upload", seconds: 180).path
    }

    static func fs<T: Decodable>(_ server: Server, _ body: [String: Any], as: T.Type, command: String = "fs",
                                 seconds: Double = 30) async throws -> T {
        let client = try await SSHPool.shared.client(for: server)
        var payload = try JSONSerialization.data(withJSONObject: body)
        payload.append(0x0a)
        var collected = Data()
        let box = DataBox()
        do {
            try await SSHPool.deadline(server, seconds: seconds) {
                try await client.withExec(command) { inbound, outbound in
                    try await outbound.write(ByteBuffer(bytes: payload))
                    for try await output in inbound {
                        if case .stdout(let buffer) = output { box.append(buffer.readableBytesView) }
                    }
                }
            }
            collected = box.data
        } catch {
            collected = box.data
            // the server closes the channel after answering – only fail if nothing came back
            if collected.isEmpty { throw error }
        }
        if let err = try? JSONDecoder().decode([String: String].self, from: collected), let message = err["error"] {
            throw HollrError.server(message)
        }
        return try JSONDecoder().decode(T.self, from: collected)
    }

    static func history(_ server: Server, pane: String, limit: Int = 80) async throws -> [LiveEvent] {
        let client = try await SSHPool.shared.client(for: server)
        let buffer = try await client.exec("history \(pane) \(limit)", on: server)
        let data = Data(buffer.readableBytesView)
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let events = obj["events"] as? [[String: Any]]
        else { throw HollrError.badResponse }
        return events.compactMap { (try? JSONSerialization.data(withJSONObject: $0)).map(LiveEvent.init(json:)) }
    }

    /// Agent CLIs installed on the server (omp, claude, codex).
    static func kinds(_ server: Server) async throws -> [String] {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.exec("kinds", on: server).readableBytesView)
        struct R: Decodable { let kinds: [String] }
        return (try? JSONDecoder().decode(R.self, from: data))?.kinds ?? []
    }

    /// Opens a new chat: a new tab in `workspace` (or a new workspace in `cwd`) running `kind`.
    static func newChat(_ server: Server, kind: String, workspace: String?, cwd: String?, label: String,
                        model: String? = nil, level: String? = nil) async throws -> String {
        let client = try await SSHPool.shared.client(for: server)
        var body = ["kind": kind, "label": label]
        if let model { body["model"] = model }
        if let level { body["level"] = level }
        if let workspace { body["workspace"] = workspace }
        if let cwd, !cwd.isEmpty { body["cwd"] = cwd }
        let line = try await requestLine(client, server: server, seconds: 90, command: "new", body: body)
        guard let obj = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
            throw HollrError.badResponse
        }
        if let pane = obj["pane"] as? String { return pane }
        throw HollrError.server((obj["error"] as? String) ?? String(localized: "Chat konnte nicht geöffnet werden."))
    }

    static func close(_ server: Server, pane: String) async throws {
        let client = try await SSHPool.shared.client(for: server)
        _ = try await client.exec("close \(pane)", on: server)
    }

    /// Visible terminal screen of a pane (for agents without a parsed history, or prompts).
    static func screen(_ server: Server, pane: String, lines: Int = 40) async throws -> String {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.exec("screen \(pane) \(lines)", on: server).readableBytesView)
        struct R: Decodable { let text: String? }
        return (try? JSONDecoder().decode(R.self, from: data))?.text ?? ""
    }

    static func keys(_ server: Server, pane: String, keys: [String]) async throws {
        let client = try await SSHPool.shared.client(for: server)
        _ = try await client.exec("keys \(pane) \(keys.joined(separator: " "))", on: server)
    }

    /// Sends a message. If omp waits on a question, the server makes the text its own answer.
    static func prompt(_ server: Server, pane: String, text: String) async throws {
        let client = try await SSHPool.shared.client(for: server)
        let line = try await requestLine(client, server: server, seconds: 30, command: "prompt \(pane)", body: ["text": text])
        if let reply = try? JSONDecoder().decode([String: String].self, from: Data(line.utf8)), let code = reply["error"] {
            throw HollrError.server(answerMessage(code))
        }
    }

    /// Answers omp's open question `ask` (its id): one pick per question. The server works out
    /// the keys – omp's cursor starts on the recommended option, multi-select toggles with Space.
    static func answer(_ server: Server, pane: String, ask: String?, picks: [AskPick]) async throws {
        var body: [String: Any] = ["picks": picks.map(\.json)]
        if let ask { body["id"] = ask }
        struct R: Decodable { let ok: Bool? }
        do {
            _ = try await fs(server, body, as: R.self, command: "answer \(pane)")
        } catch let HollrError.server(code) {
            throw HollrError.server(answerMessage(code))
        }
    }

    private static func answerMessage(_ code: String) -> String {
        switch code {
        case "no_question": String(localized: "omp fragt gerade nichts mehr.")
        case "stale_question": String(localized: "omp fragt inzwischen etwas anderes – bitte neu wählen.")
        case "bad_answer": String(localized: "Diese Antwort passt nicht zur Frage.")
        case "several_questions": String(localized: "omp stellt mehrere Fragen – bitte im Chat beantworten.")
        case "agent_blocked": String(localized: "Der Agent wartet auf eine Eingabe im Terminal – dort antworten.")
        case "not_allowed": String(localized: "Hollr auf dem Server ist zu alt – unter Server › Werkzeuge aktualisieren.")
        default: code
        }
    }

    /// Sends one JSON line on stdin and returns the first line of stdout.
    private static func requestLine(_ client: SSHClient, server: Server? = nil, seconds: Double = 60,
                                    command: String, body: [String: String]) async throws -> String {
        let box = DataBox()
        let run: @Sendable () async throws -> Void = {
            try await client.withExec(command) { inbound, outbound in
                var payload = try JSONSerialization.data(withJSONObject: body)
                payload.append(0x0a)
                try await outbound.write(ByteBuffer(bytes: payload))
                for try await output in inbound {
                    if case .stdout(let buffer) = output {
                        box.append(buffer.readableBytesView)
                        if box.data.contains(0x0a) { return }
                    }
                }
            }
        }
        if let server { try await SSHPool.deadline(server, seconds: seconds, run) } else { try await run() }
        let collected = box.data
        let line = collected.firstIndex(of: 0x0a).map { collected[..<$0] } ?? collected[...]
        let result = String(decoding: line, as: UTF8.self)
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// One long-lived SSH connection per server, shared by all short commands (tree, history, …).
/// Live calls use their own connection.
actor SSHPool {
    static let shared = SSHPool()
    private var clients: [UUID: SSHClient] = [:]
    private var connecting: [UUID: Task<SSHClient, Error>] = [:]

    func client(for server: Server) async throws -> SSHClient {
        if let existing = clients[server.id], existing.isConnected { return existing }
        clients[server.id] = nil
        if let pending = connecting[server.id] { return try await pending.value }
        let task = Task { try await HollrClient.connect(server) }
        connecting[server.id] = task
        defer { connecting[server.id] = nil }
        let client = try await task.value
        clients[server.id] = client
        HollrLog.info("pool: connected \(server.label)")
        return client
    }

    func invalidate(_ server: Server) async {
        // closing a half-open connection can take long – don't make the caller wait for it
        if let client = clients.removeValue(forKey: server.id) { Task { try? await client.close() } }
    }

    /// App in the background, network changed: connections may be dead without knowing it.
    func closeAll() async {
        for client in clients.values { Task { try? await client.close() } }
        clients.removeAll()
    }

    /// Runs one command with a deadline. A connection that went half-open (Mac asleep, Wi-Fi → mobile)
    /// still looks connected and would hold the command for minutes: on timeout the connection is
    /// dropped (which also ends the hanging command) and the next call reconnects.
    nonisolated static func deadline<T>(_ server: Server, seconds: Double = 20,
                                       _ op: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T?.self) { group in
            group.addTask { try await op() }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                return nil
            }
            defer { group.cancelAll() }
            guard let first = try await group.next(), let value = first else {
                HollrLog.error("pool: \(server.label) did not answer within \(Int(seconds))s – reconnecting")
                await SSHPool.shared.invalidate(server)
                throw HollrError.unreachable(String(localized: "keine Antwort (Zeitüberschreitung)"))
            }
            return value
        }
    }
}

extension HollrError {
    /// The connection itself failed (not an answer from the server): worth reconnecting.
    static func isTransport(_ error: Error) -> Bool {
        guard let e = error as? HollrError else { return !(error is DecodingError) }
        if case .unreachable = e { return true }
        return false
    }
}

/// Output collected inside a @Sendable closure.
final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()
    var data: Data { lock.withLock { storage } }
    func append(_ bytes: some Sequence<UInt8>) { lock.withLock { storage.append(contentsOf: bytes) } }
}

extension SSHClient {
    /// `executeCommand` with a deadline (see SSHPool.deadline).
    func exec(_ command: String, on server: Server, seconds: Double = 20) async throws -> ByteBuffer {
        try await SSHPool.deadline(server, seconds: seconds) { try await self.executeCommand(command) }
    }
}

/// First successful connection wins; the continuation is resumed exactly once.
final class ConnectRace: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<SSHClient, Error>?
    private var failures = 0
    private let count: Int
    private var lastError: Error = HollrError.unreachable("keine Adresse")
    private(set) var host: String?

    init(count: Int) { self.count = count }

    var isDone: Bool { lock.withLock { cont == nil } }

    func start(_ cont: CheckedContinuation<SSHClient, Error>) { lock.withLock { self.cont = cont } }

    /// false when another address already won (or the attempt was cancelled)
    func win(_ client: SSHClient, host: String) -> Bool {
        let c: CheckedContinuation<SSHClient, Error>? = lock.withLock {
            defer { cont = nil }
            if cont != nil { self.host = host }
            return cont
        }
        c?.resume(returning: client)
        return c != nil
    }

    func fail(_ error: Error, fatal: Bool) {
        let c: CheckedContinuation<SSHClient, Error>? = lock.withLock {
            failures += 1
            lastError = error
            guard fatal || failures >= count else { return nil }
            defer { cont = nil }
            return cont
        }
        c?.resume(throwing: error)
    }

    func cancel() {
        let c: CheckedContinuation<SSHClient, Error>? = lock.withLock { defer { cont = nil }; return cont }
        c?.resume(throwing: CancellationError())
    }
}
