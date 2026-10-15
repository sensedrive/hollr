import CommonCrypto
import CryptoKit
import Foundation
import Network

/// Pairing by one-time code (`hollr pair` shows it next to the QR code) – same payload, other way in.
///   code = Crockford-base32( IPv4 ‖ 6-byte secret ), e.g. "K7Q2-M9XA-3PLD-W8RT"
/// The app asks that address on port 47820, proves it knows the code (HMAC) and gets the QR
/// payload AES-GCM encrypted with a key from the code (PBKDF2-SHA256, 600 000 rounds).
/// Counterpart: `server/src/otp.ts`.
enum PairingCode {
    static let port: UInt16 = 47820
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    enum CodeError: LocalizedError {
        case format, wrong, locked, expired, unreachable(String, tailscale: Bool), damaged
        var errorDescription: String? {
            switch self {
            case .format: return String(localized: "Der Code hat 16 Zeichen, z. B. K7Q2-M9XA-3PLD-W8RT.")
            case .wrong: return String(localized: "Der Code stimmt nicht. Bitte genau so eingeben, wie er am Rechner steht.")
            case .locked: return String(localized: "Zu viele falsche Versuche – der Code ist gesperrt. Am Rechner einen neuen erzeugen („n“ + Enter).")
            case .expired: return String(localized: "Der Code ist abgelaufen oder wurde schon benutzt. Am Rechner einen neuen erzeugen: hollr pair")
            case let .unreachable(ip, tailscale):
                return tailscale
                    ? String(localized: "Der Rechner (\(ip)) ist nicht erreichbar. Ist Tailscale auf dem iPhone verbunden und läuft „hollr pair“ am Rechner noch?")
                    : String(localized: "Der Rechner (\(ip)) ist nicht erreichbar. Gleiches WLAN? Läuft „hollr pair“ am Rechner noch?")
            case .damaged: return String(localized: "Die Antwort des Rechners passt nicht zum Code.")
            }
        }
    }

    /// "k7q2 m9xa-3pld w8rt" → "K7Q2-M9XA-3PLD-W8RT" (while typing)
    static func format(_ input: String) -> String {
        let clean = input.uppercased().compactMap { c -> Character? in
            if c == "O" { return "0" }
            if c == "I" || c == "L" { return "1" }
            return alphabet.contains(c) ? c : nil
        }.prefix(16)
        return stride(from: 0, to: clean.count, by: 4).map { i in
            String(clean[clean.index(clean.startIndex, offsetBy: i)..<clean.index(clean.startIndex, offsetBy: min(i + 4, clean.count))])
        }.joined(separator: "-")
    }

    static func decode(_ code: String) -> (ip: String, secret: Data)? {
        let clean = format(code).replacingOccurrences(of: "-", with: "")
        guard clean.count == 16 else { return nil }
        var bits = 0, value = 0
        var bytes: [UInt8] = []
        for c in clean {
            guard let v = alphabet.firstIndex(of: c) else { return nil }
            value = (value << 5) | v
            bits += 5
            if bits >= 8 {
                bytes.append(UInt8((value >> (bits - 8)) & 0xFF))
                bits -= 8
            }
        }
        guard bytes.count >= 10 else { return nil }
        let ip = bytes[0..<4].map(String.init).joined(separator: ".")
        return (ip, Data(bytes[4..<10]))
    }

    static func deriveKeys(ip: String, secret: Data) -> (auth: SymmetricKey, enc: SymmetricKey) {
        let salt = Array("hollr-pair:\(ip)".utf8)
        var out = [UInt8](repeating: 0, count: 64)
        secret.withUnsafeBytes { pw in
            _ = CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2), pw.bindMemory(to: CChar.self).baseAddress, secret.count,
                salt, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 600_000, &out, out.count
            )
        }
        return (SymmetricKey(data: out[0..<32]), SymmetricKey(data: out[32..<64]))
    }

    /// Code → the same payload a QR code carries.
    static func fetchPayload(_ code: String) async throws -> PairingPayload {
        guard let (ip, secret) = decode(code) else { throw CodeError.format }
        let keys = await Task.detached(priority: .userInitiated) { deriveKeys(ip: ip, secret: secret) }.value
        let proof = Data(HMAC<SHA256>.authenticationCode(for: Data("hollr-pair-v1".utf8), using: keys.auth))
        let body = try JSONSerialization.data(withJSONObject: ["proof": proof.base64EncodedString()])
        let (status, response): (Int, Data)
        do {
            (status, response) = try await post(ip: ip, path: "/hollr/pair", body: body)
        } catch {
            throw CodeError.unreachable(ip, tailscale: Tailscale.isAddress(ip))
        }
        let obj = (try? JSONSerialization.jsonObject(with: response)) as? [String: Any] ?? [:]
        switch (status, obj["error"] as? String) {
        case (200, _): break
        case (403, "locked"): throw CodeError.locked
        case (403, _): throw CodeError.wrong
        case (410, _): throw CodeError.expired
        default: throw CodeError.damaged
        }
        guard let b64 = obj["box"] as? String, let box = Data(base64Encoded: b64),
              let plain = try? AES.GCM.open(AES.GCM.SealedBox(combined: box), using: keys.enc),
              let payload = try? JSONDecoder().decode(PairingPayload.self, from: plain)
        else { throw CodeError.damaged }
        if payload.isExpired { throw CodeError.expired }
        return payload
    }

    /// Minimal HTTP/1.1 over a plain TCP connection (Network.framework – no ATS for a raw IP;
    /// the body is encrypted with the code's key, and on Tailscale WireGuard sits underneath).
    private static func post(ip: String, path: String, body: Data) async throws -> (Int, Data) {
        let connection = NWConnection(host: NWEndpoint.Host(ip), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        defer { connection.cancel() }
        // one serial queue for the state handler and the timeout: the continuation is resumed exactly once
        let queue = DispatchQueue(label: "app.hollr.pair")
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            var resumed = false
            var lastWaiting: Error?
            connection.stateUpdateHandler = { state in
                guard !resumed else { return }
                switch state {
                case .ready: resumed = true; cont.resume()
                case let .failed(error): resumed = true; cont.resume(throwing: error)
                // .waiting is not fatal: the first LAN connection waits for the "local network" permission
                case let .waiting(error): lastWaiting = error
                default: break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 20) {
                if !resumed { resumed = true; cont.resume(throwing: lastWaiting ?? URLError(.timedOut)) }
            }
        }
        // the whole exchange has a deadline too: cancelling the connection fails a pending receive
        queue.asyncAfter(deadline: .now() + 30) { connection.cancel() }
        var request = Data("POST \(path) HTTP/1.1\r\nHost: \(ip):\(port)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
        request.append(body)
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            connection.send(content: request, completion: .contentProcessed { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            })
        }
        var received = Data()
        while true {
            let (chunk, done): (Data?, Bool) = try await withCheckedThrowingContinuation { cont in
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
                    if let error { cont.resume(throwing: error) } else { cont.resume(returning: (data, complete)) }
                }
            }
            if let chunk { received.append(chunk) }
            if done || received.count > 1_000_000 { break }
        }
        guard let split = received.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: received[..<split.lowerBound], encoding: .utf8),
              let status = head.split(separator: " ").dropFirst().first.flatMap({ Int($0) })
        else { throw URLError(.badServerResponse) }
        return (status, Data(received[split.upperBound...]))
    }
}
