import Foundation
import os

/// Logs to the unified log (Console.app, subsystem app.hollr) and stdout (devicectl --console).
enum HollrLog {
    private static let logger = Logger(subsystem: "app.hollr", category: "app")

    static func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
        print("[hollr] \(message)")
    }

    static func error(_ message: String) {
        logger.error("\(message, privacy: .public)")
        print("[hollr] ERROR \(message)")
    }
}
