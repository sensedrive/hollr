import Foundation

/// Something shared to Hollr from another app (Safari, Mail, Photos). The share extension can't
/// open SSH connections, so it leaves the item in the shared keychain; the app asks which agent gets it.
struct SharedItem: Codable, Identifiable, Equatable {
    var id = UUID()
    var text: String
    var fileName: String?
    /// image or file (images are shrunk first – the keychain is no place for big files)
    var file: Data?
    var at = Date()

    /// files above this are left out (the share sheet says so)
    static let maxFile = 3 * 1024 * 1024

    static func pending() -> [SharedItem] {
        guard let data = SharedKeychain.load("shared-inbox"),
              let items = try? JSONDecoder().decode([SharedItem].self, from: data) else { return [] }
        return items
    }

    @discardableResult
    static func save(_ items: [SharedItem]) -> Bool {
        guard let data = try? JSONEncoder().encode(Array(items.suffix(3))) else { return false }
        return SharedKeychain.save("shared-inbox", data)
    }

    @discardableResult
    static func add(_ item: SharedItem) -> Bool { save(pending() + [item]) }

    static func remove(_ item: SharedItem) { save(pending().filter { $0.id != item.id }) }
}
