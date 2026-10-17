import Foundation

/// A live Claude Code session on this machine, as `claude agents --json` reports it.
/// Covers CLI, background and Claude Desktop sessions alike.
public struct ClaudeLiveSession: Equatable, Sendable, Identifiable {
    public var id: String            // short id for background sessions, else the session UUID
    public var sessionId: String
    public var name: String?
    public var cwd: String
    public var kind: String          // interactive | background
    public var status: String        // busy | waiting | idle
    public var state: String?        // working | blocked | done | failed | stopped (background only)
    public var waitingFor: String?
    public var pid: Int?
    public var startedAt: Date?
    public var raw: JSONValue

    init?(_ value: JSONValue) {
        guard let sessionId = value["sessionId"]?.string else { return nil }
        self.sessionId = sessionId
        id = value["id"]?.string ?? sessionId
        name = value["name"]?.string
        cwd = value["cwd"]?.string ?? ""
        kind = value["kind"]?.string ?? "interactive"
        status = value["status"]?.string ?? "unknown"
        state = value["state"]?.string
        waitingFor = value["waitingFor"]?.string
        pid = value["pid"]?.int
        startedAt = value["startedAt"]?.double.map { Date(timeIntervalSince1970: $0 / 1000) }
        raw = value
    }
}

/// What `~/.claude/sessions/<pid>.json` adds: the desktop id and the inbox socket.
/// Undocumented format; read defensively and never write.
public struct ClaudeSessionRecord: Equatable, Sendable {
    public var pid: Int
    public var sessionId: String
    public var name: String?
    public var cwd: String?
    public var entrypoint: String?      // claude-desktop | cli | …
    public var hostSessionId: String?   // Claude Desktop's own id (local_…)
    public var messagingSocketPath: String?
    public var status: String?
    public var version: String?

    init?(_ value: JSONValue) {
        guard let pid = value["pid"]?.int, let sessionId = value["sessionId"]?.string else { return nil }
        self.pid = pid
        self.sessionId = sessionId
        name = value["name"]?.string
        cwd = value["cwd"]?.string
        entrypoint = value["entrypoint"]?.string
        hostSessionId = value["hostSessionId"]?.string
        messagingSocketPath = value["messagingSocketPath"]?.string
        status = value["status"]?.string
        version = value["version"]?.string
    }

    /// Deep link that opens the session in Claude Desktop. Observed, not documented.
    public var desktopLink: URL? {
        guard entrypoint == "claude-desktop", let hostSessionId else { return nil }
        return URL(string: "claude://claude.ai/epitaxy/\(hostSessionId)")
    }
}

public enum ClaudeSessions {
    public static var configDirectory: URL {
        if let custom = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"] { return URL(fileURLWithPath: custom) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude")
    }

    /// Documented listing of live sessions.
    public static func live(includeCompleted: Bool = false) async throws -> [ClaudeLiveSession] {
        var arguments = ["agents", "--json"]
        if includeCompleted { arguments.append("--all") }
        let result = try await Executables.run("claude", arguments)
        guard result.status == 0 else { throw ClaudeError.cli("claude agents", result.stderr) }
        let value = try JSONValue.parse(result.stdout)
        return (value.array ?? []).compactMap(ClaudeLiveSession.init)
    }

    /// Registry records for running processes (best effort, undocumented).
    public static func records() -> [ClaudeSessionRecord] {
        let directory = configDirectory.appendingPathComponent("sessions")
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return [] }
        return names.filter { $0.hasSuffix(".json") }.compactMap { name in
            guard let data = FileManager.default.contents(atPath: directory.appendingPathComponent(name).path),
                  let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
            return ClaudeSessionRecord(value)
        }
    }

    /// Command lines of running session processes (`ps`), where the desktop app leaves `--model` and `--effort`.
    public static func processArguments(pids: [Int]) async -> [Int: String] {
        guard !pids.isEmpty, let result = try? await Executables.run("ps", ["-o", "pid=,args=", "-p", pids.map(String.init).joined(separator: ",")]) else { return [:] }
        var map: [Int: String] = [:]
        for line in result.stdout.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard let space = trimmed.firstIndex(of: " "), let pid = Int(trimmed[..<space]) else { continue }
            map[pid] = String(trimmed[trimmed.index(after: space)...])
        }
        return map
    }

    /// Transcript files for a working directory, newest first.
    public static func transcripts(cwd: String) -> [URL] {
        let slug = cwd.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        let directory = configDirectory.appendingPathComponent("projects").appendingPathComponent(slug)
        guard let urls = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]) else { return [] }
        return urls.filter { $0.pathExtension == "jsonl" }.sorted { a, b in
            let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return da > db
        }
    }
}

public enum ClaudeError: Error, CustomStringConvertible {
    case cli(String, String)
    case processExited
    case socket(String)
    public var description: String {
        switch self {
        case .cli(let command, let stderr): return "\(command) failed: \(stderr)"
        case .processExited: return "claude exited"
        case .socket(let message): return "inbox socket: \(message)"
        }
    }
}
