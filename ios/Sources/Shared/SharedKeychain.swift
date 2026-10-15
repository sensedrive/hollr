import Foundation
import Security

/// Data shared between the app and its extensions (widgets, share sheet) through a shared keychain
/// group – keychain sharing needs no App Group registration in the developer portal.
enum SharedKeychain {
    /// "<team>.app.hollr.shared" – the team prefix comes from the app's own keychain entitlement
    static var group: String? {
        guard let prefix = Bundle.main.object(forInfoDictionaryKey: "HollrTeamID") as? String, !prefix.isEmpty,
              !prefix.hasPrefix("$(") else { return nil }
        return "\(prefix).app.hollr.shared"
    }

    private static func query(_ key: String) -> [String: Any]? {
        guard let group else { return nil }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "app.hollr.shared",
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: group,
        ]
    }

    static func load(_ key: String) -> Data? {
        guard var q = query(key) else { return nil }
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    @discardableResult
    static func save(_ key: String, _ data: Data) -> Bool {
        guard let q = query(key) else { return false }
        let update: [String: Any] = [kSecValueData as String: data]
        if SecItemUpdate(q as CFDictionary, update as CFDictionary) == errSecSuccess { return true }
        var add = q
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
}
