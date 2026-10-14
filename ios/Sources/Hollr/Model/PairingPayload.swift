import Foundation

/// Content of a `hollr://pair?c=<base64url(JSON)>` QR code, created by `hollr pair` on the server.
struct PairingPayload: Codable, Equatable {
    let v: Int
    /// Addresses to try, in order
    let a: [String]
    /// SSH port
    let p: Int
    /// Unix user
    let u: String
    /// Host key fingerprint ("SHA256:…")
    let fp: String
    /// Bootstrap Ed25519 seed (base64url, 32 bytes)
    let s: String
    /// Expiry (unix seconds)
    let e: TimeInterval
    /// Server label
    let l: String
    /// How the phone connects (lan / tailscale / auto); older codes have none
    var n: String?

    var network: NetworkMode { n.flatMap(NetworkMode.init(rawValue:)) ?? .auto }

    var isExpired: Bool { Date().timeIntervalSince1970 > e }

    var bootstrapSeed: Data? { Data(base64URLEncoded: s) }

    enum ParseError: LocalizedError {
        case notHollr, malformed, expired
        var errorDescription: String? {
            switch self {
            case .notHollr: return String(localized: "Das ist kein Hollr-Kopplungscode.")
            case .malformed: return String(localized: "Der Kopplungscode ist beschädigt.")
            case .expired: return String(localized: "Der Kopplungscode ist abgelaufen. Auf dem Server neu erzeugen: hollr pair")
            }
        }
    }

    static func parse(_ string: String) throws -> PairingPayload {
        guard let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "hollr", url.host == "pair",
              let c = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "c" })?.value
        else { throw ParseError.notHollr }
        guard let data = Data(base64URLEncoded: c),
              let payload = try? JSONDecoder().decode(PairingPayload.self, from: data),
              payload.v == 1, !payload.a.isEmpty
        else { throw ParseError.malformed }
        if payload.isExpired { throw ParseError.expired }
        return payload
    }
}

extension Data {
    init?(base64URLEncoded string: String) {
        var s = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        self.init(base64Encoded: s)
    }
}
