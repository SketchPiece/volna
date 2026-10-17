import Foundation
import os

/// Bounded development-only lifecycle telemetry; never store audio, text, URLs or credentials.
enum CallLaunchDiagnostics {
    #if DEBUG
    private static let lock = NSLock()
    private static let logger = Logger(subsystem: "dev.prototype.callassistant.launch", category: "CallLifecycle")
    #endif

    static func record(_ stage: String) {
        #if DEBUG
        lock.lock()
        defer { lock.unlock() }
        let entry = "\(Date().timeIntervalSince1970) volna-sirikit-1 \(stage)"
        var entries = UserDefaults.standard.stringArray(forKey: "volnaLaunchStages") ?? []
        entries.append(entry)
        UserDefaults.standard.set(Array(entries.suffix(80)), forKey: "volnaLaunchStages")
        UserDefaults.standard.synchronize()
        logger.notice("\(entry, privacy: .public)")
        #endif
    }
}
