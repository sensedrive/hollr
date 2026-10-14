import Foundation
import Security

/// The team's APNs auth key (.p8), imported once into the app. The app installs it on every
/// paired server (over the pinned SSH connection) so nobody has to run `hollr push setup`.
struct PushKey: Codable {
    let pem: String
    let keyId: String
    let teamId: String

    private static let service = "app.hollr.apns"

    /// Team of this build (Info.plist ← DEVELOPMENT_TEAM).
    static var buildTeam: String {
        (Bundle.main.object(forInfoDictionaryKey: "HollrTeamID") as? String) ?? ""
    }

    /// "AuthKey_ABC123DEFG.p8" → ABC123DEFG
    static func keyId(fromFilename name: String) -> String? {
        name.range(of: #"[A-Z0-9]{10}"#, options: .regularExpression).map { String(name[$0]) }
    }

    static func load() -> PushKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(PushKey.self, from: data)
    }

    func save() throws {
        let data = try JSONEncoder().encode(self)
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service] as CFDictionary)
        let status = SecItemAdd([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ] as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: "PushKey", code: Int(status)) }
    }
}
