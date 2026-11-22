import Foundation
import os

/// Logs to the unified log (Console.app, subsystem app.hollr), stdout (devicectl --console) and the
/// diagnostics file that goes to a server (Diagnostics).
enum HollrLog {
    private static let logger = Logger(subsystem: "app.hollr", category: "app")

    static func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
        print("[hollr] \(message)")
        Diagnostics.shared.note(message)
    }

    static func error(_ message: String) {
        logger.error("\(message, privacy: .public)")
        print("[hollr] ERROR \(message)")
        Diagnostics.shared.note("ERROR \(message)")
    }
}
