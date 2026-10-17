import Foundation
import Network

/// A hook event as Claude Code posts it to an HTTP hook (`"type": "http"` in settings).
public struct ClaudeHookEvent: Sendable {
    public var name: String            // hook_event_name
    public var sessionId: String
    public var cwd: String?
    public var payload: JSONValue
    public var receivedAt: Date
}

/// Minimal loopback HTTP server for Claude Code HTTP hooks.
/// One listener serves every session on the machine; the hook config points all events here.
public final class ClaudeHookReceiver: @unchecked Sendable {
    public let events: AsyncStream<ClaudeHookEvent>
    private let continuation: AsyncStream<ClaudeHookEvent>.Continuation
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "pult.hooks")
    public private(set) var port: UInt16 = 0
    /// Answers hooks that wait for a decision (`ClaudeHooksInstaller.askPath`). The returned JSON is the hook's output;
    /// nil answers `{}` and the session goes on as if Пульт were not there. These requests are not put on `events`.
    public var responder: (@Sendable (_ path: String, _ event: ClaudeHookEvent) async -> JSONValue?)?

    public init() {
        var continuation: AsyncStream<ClaudeHookEvent>.Continuation!
        events = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    /// Binds 127.0.0.1 on `port` (0 = any free port) and resolves once the port is known.
    public func start(port requested: UInt16 = 0) async throws {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        let listener = try NWListener(using: parameters, on: requested == 0 ? .any : NWEndpoint.Port(rawValue: requested)!)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        let gate = ResumeOnce()
        try await withCheckedThrowingContinuation { (resolve: CheckedContinuation<Void, Error>) in
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.port = listener.port?.rawValue ?? 0
                    gate.run { resolve.resume() }
                case .failed(let error):
                    gate.run { resolve.resume(throwing: error) }
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    public func stop() { listener?.cancel(); continuation.finish() }

    /// Hook settings that route the given events here. Pass to `claude --settings` or merge into settings.json.
    public func settings(events names: [String] = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "Notification", "PermissionRequest"]) -> JSONValue {
        var hooks: [String: JSONValue] = [:]
        for name in names {
            hooks[name] = [["hooks": [["type": "http", "url": .string("http://127.0.0.1:\(port)/hook"), "timeout": 5]]]]
        }
        return ["hooks": .object(hooks)]
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        var received = Data()
        func readMore() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
                if let data { received.append(data) }
                if let request = Self.parse(received) {
                    if let responder = self?.responder, request.path.hasSuffix(ClaudeHooksInstaller.askPath), let event = Self.event(from: request.body) {
                        Task {
                            let output = await responder(request.path, event)
                            Self.reply(connection, (try? output?.serialized()) ?? "{}")
                        }
                        return
                    }
                    self?.deliver(request.body)
                    Self.reply(connection, "{}")
                } else if isComplete || error != nil {
                    connection.cancel()
                } else {
                    readMore()
                }
            }
        }
        readMore()
    }

    private func deliver(_ body: Data) {
        guard let event = Self.event(from: body) else { return }
        continuation.yield(event)
    }

    static func event(from body: Data) -> ClaudeHookEvent? {
        guard let payload = try? JSONDecoder().decode(JSONValue.self, from: body) else { return nil }
        return ClaudeHookEvent(name: payload["hook_event_name"]?.string ?? "unknown", sessionId: payload["session_id"]?.string ?? "",
                               cwd: payload["cwd"]?.string, payload: payload, receivedAt: Date())
    }

    private static func reply(_ connection: NWConnection, _ body: String) {
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
    }

    /// Returns the body once the whole request (headers + Content-Length bytes) has arrived.
    static func parse(_ data: Data) -> (body: Data, path: String)? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[..<headerEnd.lowerBound], as: UTF8.self)
        let lines = head.components(separatedBy: "\r\n")
        let path = lines.first?.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
        let length = lines.compactMap { line -> Int? in
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" else { return nil }
            return Int(parts[1].trimmingCharacters(in: .whitespaces))
        }.first ?? 0
        let body = data[headerEnd.upperBound...]
        guard body.count >= length else { return nil }
        return (Data(body.prefix(length)), path)
    }
}

/// Runs its block at most once; state handlers can fire `.ready` more than once.
final class ResumeOnce: @unchecked Sendable {
    private var done = false
    private let lock = NSLock()
    func run(_ block: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard !done else { return }
        done = true
        block()
    }
}

/// The session's last answer for the Stop hook: `last_assistant_message` when the CLI sends it,
/// otherwise the last assistant text in the transcript (`transcript_path`, internal format, read from the tail).
public enum ClaudeTranscript {
    public static func lastReply(_ payload: JSONValue, maxTailBytes: Int = 262_144) -> String? {
        if let text = payload["last_assistant_message"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { return text }
        guard let path = payload["transcript_path"]?.string, let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > UInt64(maxTailBytes) ? size - UInt64(maxTailBytes) : 0)
        guard let data = try? handle.readToEnd() else { return nil }
        return lastReply(jsonl: String(decoding: data, as: UTF8.self))
    }

    static func lastReply(jsonl: String) -> String? {
        for line in jsonl.split(separator: "\n").reversed() {
            guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)), value["type"]?.string == "assistant",
                  case .array(let blocks)? = value["message"]?["content"] else { continue }
            let text = blocks.compactMap { $0["type"]?.string == "text" ? $0["text"]?.string : nil }.joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return text }
        }
        return nil
    }
}
