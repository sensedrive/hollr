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
    /// Connects to the first reachable address.
    static func connect(
        addresses: [String], port: Int, user: String, fingerprint: String,
        key: Curve25519.Signing.PrivateKey
    ) async throws -> SSHClient {
        var lastError: Error = HollrError.unreachable("keine Adresse")
        for host in addresses {
            do {
                return try await SSHClient.connect(
                    host: host,
                    port: port,
                    authenticationMethod: .ed25519(username: user, privateKey: key),
                    hostKeyValidator: .custom(PinnedHostKey(fingerprint)),
                    reconnect: .never,
                    connectTimeout: .seconds(8)
                )
            } catch let error as HollrError {
                throw error // wrong host key: never try the next address
            } catch {
                lastError = HollrError.unreachable("\(host): \(error.localizedDescription)")
            }
        }
        throw lastError
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
                : String(localized: "Kopplung abgelehnt (\(code))."))
        }
        return Server(
            label: payload.l, user: payload.u, addresses: payload.a, port: payload.p,
            hostFingerprint: payload.fp, deviceId: deviceId
        )
    }

    // MARK: Commands

    static func tree(_ server: Server) async throws -> [Workspace] {
        let client = try await SSHPool.shared.client(for: server)
        let buffer = try await client.executeCommand("tree")
        struct Response: Decodable { let workspaces: [Workspace]?; let error: String? }
        let data = Data(buffer.readableBytesView)
        guard let response = try? JSONDecoder().decode(Response.self, from: data) else {
            HollrLog.error("tree: bad response \(String(decoding: data.prefix(300), as: UTF8.self))")
            throw HollrError.badResponse
        }
        if let error = response.error { throw HollrError.server(error) }
        return response.workspaces ?? []
    }

    static func timeline(_ server: Server, pane: String, limit: Int = 150) async throws -> Timeline {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.executeCommand("timeline \(pane) \(limit)").readableBytesView)
        do {
            return try JSONDecoder().decode(Timeline.self, from: data)
        } catch {
            HollrLog.error("timeline decode: \(error) \(String(decoding: data.prefix(200), as: UTF8.self))")
            throw HollrError.badResponse
        }
    }

    static func spaces(_ server: Server) async throws -> [Space] {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.executeCommand("spaces").readableBytesView)
        struct R: Decodable { let spaces: [Space] }
        return try JSONDecoder().decode(R.self, from: data).spaces
    }

    /// Web pages listening on the server's loopback (for the browser's quick links).
    static func ports(_ server: Server) async throws -> [WebPort] {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.executeCommand("ports").readableBytesView)
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
        let data = Data(try await client.executeCommand(refresh ? "usage refresh" : "usage").readableBytesView)
        struct R: Decodable { let limits: [UsageLimit]; let capacity: [UsageCapacity]? }
        let r = try JSONDecoder().decode(R.self, from: data)
        return (r.limits, r.capacity ?? [])
    }

    /// Read-only git / file access inside a space (server checks the path stays inside).
    static func fs<T: Decodable>(_ server: Server, _ body: [String: Any], as: T.Type, command: String = "fs") async throws -> T {
        let client = try await SSHPool.shared.client(for: server)
        var payload = try JSONSerialization.data(withJSONObject: body)
        payload.append(0x0a)
        var collected = Data()
        do {
            try await client.withExec(command) { inbound, outbound in
                try await outbound.write(ByteBuffer(bytes: payload))
                for try await output in inbound {
                    if case .stdout(let buffer) = output { collected.append(contentsOf: buffer.readableBytesView) }
                }
            }
        } catch {
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
        let buffer = try await client.executeCommand("history \(pane) \(limit)")
        let data = Data(buffer.readableBytesView)
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let events = obj["events"] as? [[String: Any]]
        else { throw HollrError.badResponse }
        return events.compactMap { (try? JSONSerialization.data(withJSONObject: $0)).map(LiveEvent.init(json:)) }
    }

    /// Agent CLIs installed on the server (omp, claude, codex).
    static func kinds(_ server: Server) async throws -> [String] {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.executeCommand("kinds").readableBytesView)
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
        let line = try await requestLine(client, command: "new", body: body)
        guard let obj = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
            throw HollrError.badResponse
        }
        if let pane = obj["pane"] as? String { return pane }
        throw HollrError.server((obj["error"] as? String) ?? String(localized: "Chat konnte nicht geöffnet werden."))
    }

    static func close(_ server: Server, pane: String) async throws {
        let client = try await SSHPool.shared.client(for: server)
        _ = try await client.executeCommand("close \(pane)")
    }

    /// Visible terminal screen of a pane (for agents without a parsed history, or prompts).
    static func screen(_ server: Server, pane: String, lines: Int = 40) async throws -> String {
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.executeCommand("screen \(pane) \(lines)").readableBytesView)
        struct R: Decodable { let text: String? }
        return (try? JSONDecoder().decode(R.self, from: data))?.text ?? ""
    }

    static func keys(_ server: Server, pane: String, keys: [String]) async throws {
        let client = try await SSHPool.shared.client(for: server)
        _ = try await client.executeCommand("keys \(pane) \(keys.joined(separator: " "))")
    }

    static func prompt(_ server: Server, pane: String, text: String) async throws {
        let client = try await SSHPool.shared.client(for: server)
        _ = try await requestLine(client, command: "prompt \(pane)", body: ["text": text])
    }

    /// Sends one JSON line on stdin and returns the first line of stdout.
    private static func requestLine(_ client: SSHClient, command: String, body: [String: String]) async throws -> String {
        var result = ""
        try await client.withExec(command) { inbound, outbound in
            var payload = try JSONSerialization.data(withJSONObject: body)
            payload.append(0x0a)
            try await outbound.write(ByteBuffer(bytes: payload))
            var collected = Data()
            for try await output in inbound {
                if case .stdout(let buffer) = output {
                    collected.append(contentsOf: buffer.readableBytesView)
                    if let nl = collected.firstIndex(of: 0x0a) {
                        result = String(decoding: collected[..<nl], as: UTF8.self)
                        return
                    }
                }
            }
            result = String(decoding: collected, as: UTF8.self)
        }
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
        if let client = clients.removeValue(forKey: server.id) { try? await client.close() }
    }

    func closeAll() async {
        for client in clients.values { try? await client.close() }
        clients.removeAll()
    }
}
