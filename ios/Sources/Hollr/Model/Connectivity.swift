import Darwin
import Foundation
import Observation

/// How the phone reaches a server – chosen in `hollr pair` (QR field `n`), changeable later.
enum NetworkMode: String, Codable, CaseIterable, Identifiable {
    case lan, tailscale, auto
    var id: String { rawValue }

    var title: String {
        switch self {
        case .lan: return String(localized: "Lokales Netzwerk")
        case .tailscale: return String(localized: "Tailscale / Fernzugriff")
        case .auto: return String(localized: "Automatisch")
        }
    }

    var explanation: String {
        switch self {
        case .lan: return String(localized: "Nur im selben WLAN bzw. hinter demselben Router (Cloud-Server: direkt über ihre Adresse).")
        case .tailscale: return String(localized: "Über dein Tailnet – auch von unterwegs, ohne offene Ports. Zu Hause wird zusätzlich das lokale Netzwerk probiert.")
        case .auto: return String(localized: "Alle bekannten Adressen der Reihe nach.")
        }
    }
}

/// Which address a server answered on, or why it didn't (for the connection status).
@MainActor
@Observable
final class ConnectionInfo {
    static let shared = ConnectionInfo()
    /// host key fingerprint → address of the last successful connection
    private(set) var via: [String: String] = [:]
    private(set) var at: [String: Date] = [:]

    func connected(fingerprint: String, host: String) {
        via[fingerprint] = host
        at[fingerprint] = .now
    }

    func failed(fingerprint: String) {
        via[fingerprint] = nil
    }
}

enum Tailscale {
    /// 100.64.0.0/10
    static func isAddress(_ host: String) -> Bool {
        let parts = host.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 100 && (64...127).contains(parts[1])
    }

    static func isName(_ host: String) -> Bool { host.hasSuffix(".ts.net") }

    static func isTailscale(_ host: String) -> Bool { isAddress(host) || isName(host) }

    /// The Tailscale VPN is up on this phone (it has an address in 100.64.0.0/10).
    static var isActiveOnDevice: Bool {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return false }
        defer { freeifaddrs(list) }
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let ifa = cursor {
            defer { cursor = ifa.pointee.ifa_next }
            guard let addr = ifa.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0,
               isAddress(String(cString: host)) {
                return true
            }
        }
        return false
    }
}

/// `hollr gate hello` → what the server can offer (LAN addresses, Tailscale).
struct ServerNetwork: Decodable {
    struct TS: Decodable {
        let installed: Bool
        let state: String?
        let addresses: [String]
    }
    let lan: [String]
    let tailscale: TS

    /// Addresses for a mode, in the order the app tries them (same rule as the server).
    func addresses(for mode: NetworkMode) -> [String] {
        switch mode {
        case .lan: return lan
        case .tailscale: return Array(NSOrderedSet(array: tailscale.addresses + lan)) as? [String] ?? lan
        case .auto: return Array(NSOrderedSet(array: lan + tailscale.addresses)) as? [String] ?? lan
        }
    }
}

extension HollrClient {
    static func network(_ server: Server) async throws -> ServerNetwork {
        struct Hello: Decodable { let network: ServerNetwork? }
        let client = try await SSHPool.shared.client(for: server)
        let data = Data(try await client.executeCommand("hello").readableBytesView)
        guard let network = try JSONDecoder().decode(Hello.self, from: data).network else {
            throw HollrError.server(String(localized: "Der Hollr-Server ist zu alt – bitte aktualisieren."))
        }
        return network
    }
}
