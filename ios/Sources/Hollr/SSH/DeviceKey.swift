import CryptoKit
import Foundation
import NIOSSH
import Security
import UIKit

/// The phone's own SSH identity (Ed25519). Generated once, kept in the Keychain,
/// never leaves the device. The server only ever sees the public key.
enum DeviceKey {
    private static let service = "app.hollr.ssh"
    private static let account = "device-ed25519"

    static func load() throws -> Curve25519.Signing.PrivateKey {
        if let existing = try read() { return existing }
        let key = Curve25519.Signing.PrivateKey()
        try store(key)
        return key
    }

    /// "ssh-ed25519 AAAA…" line for authorized_keys.
    static func publicLine(for key: Curve25519.Signing.PrivateKey) -> String {
        String(openSSHPublicKey: NIOSSHPrivateKey(ed25519Key: key).publicKey)
    }

    static var defaultDeviceName: String {
        UIDevice.current.name == "iPhone" ? "iPhone" : UIDevice.current.name
    }

    private static func read() throws -> Curve25519.Signing.PrivateKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return try Curve25519.Signing.PrivateKey(rawRepresentation: data)
    }

    private static func store(_ key: Curve25519.Signing.PrivateKey) throws {
        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: key.rawRepresentation,
        ]
        let status = SecItemAdd(attrs as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
}

/// SHA256 fingerprint of an SSH public key, OpenSSH style ("SHA256:…", no padding).
func sshFingerprint(_ key: NIOSSHPublicKey) -> String {
    let line = String(openSSHPublicKey: key)
    let parts = line.split(separator: " ")
    guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else { return "" }
    let digest = Data(SHA256.hash(data: blob)).base64EncodedString()
    return "SHA256:" + digest.trimmingCharacters(in: CharacterSet(charactersIn: "="))
}
