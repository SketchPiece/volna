import Foundation

public enum ClaudeEvent: Sendable {
    case initialized(sessionId: String, model: String?, info: JSONValue)
    case assistantText(String)
    case assistantToolUse(name: String, input: JSONValue, id: String)
    case toolResult(toolUseId: String, content: JSONValue, isError: Bool)
    case textDelta(String)
    case result(sessionId: String, text: String?, isError: Bool, costUSD: Double?, durationMs: Int?)
    case system(subtype: String, payload: JSONValue)
    case other(JSONValue)
}

public struct ClaudePermissionRequest: Sendable {
    public var requestId: String
    public var toolName: String
    public var input: JSONValue
    public var toolUseId: String?
    public var suggestions: JSONValue?
    public var decisionReason: String?
}

public enum ClaudePermissionDecision: Sendable {
    case allow(updatedInput: JSONValue?)
    case deny(message: String)
}

/// One `claude -p` process in streaming mode: many turns over stdin, permissions answered by us.
/// This is the same protocol Claude Desktop uses for its own sessions.
public final class ClaudeStreamSession: @unchecked Sendable {
    public typealias PermissionHandler = @Sendable (ClaudePermissionRequest) async -> ClaudePermissionDecision

    public struct Options: Sendable {
        public var cwd: String
        public var resumeSessionId: String?
        public var forkSession = false
        public var name: String?
        public var model: String?
        public var effort: String?
        public var permissionMode: String?
        public var includePartialMessages = false
        public var extraArguments: [String] = []
        public init(cwd: String) { self.cwd = cwd }
    }

    public let events: AsyncStream<ClaudeEvent>
    private let eventContinuation: AsyncStream<ClaudeEvent>.Continuation
    private let process: LineProcess
    private var permissionHandler: PermissionHandler = { _ in .deny(message: "no permission host") }
    public private(set) var sessionId: String?
    private var pump: Task<Void, Never>?

    public init(options: Options) {
        var arguments = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"]
        if let id = options.resumeSessionId { arguments += ["--resume", id] }
        if options.forkSession { arguments.append("--fork-session") }
        if let name = options.name { arguments += ["--name", name] }
        if let model = options.model { arguments += ["--model", model] }
        if let effort = options.effort { arguments += ["--effort", effort] }
        if let mode = options.permissionMode { arguments += ["--permission-mode", mode] }
        if options.includePartialMessages { arguments.append("--include-partial-messages") }
        arguments += options.extraArguments
        process = LineProcess(name: "claude", arguments: arguments, currentDirectory: options.cwd)
        var continuation: AsyncStream<ClaudeEvent>.Continuation!
        events = AsyncStream { continuation = $0 }
        eventContinuation = continuation
    }

    public func setPermissionHandler(_ handler: @escaping PermissionHandler) { permissionHandler = handler }

    public func start() throws {
        try process.start()
        pump = Task { [weak self, process] in
            for await line in process.lines { self?.handle(line: line) }
            self?.eventContinuation.finish()
        }
    }

    public func send(text: String) throws {
        let message: JSONValue = ["type": "user", "message": ["role": "user", "content": .string(text)], "parent_tool_use_id": .null]
        try process.send(line: try message.serialized())
    }

    public func interrupt() throws {
        let request: JSONValue = ["type": "control_request", "request_id": .string(UUID().uuidString), "request": ["subtype": "interrupt"]]
        try process.send(line: try request.serialized())
    }

    /// Ends the conversation: closing stdin lets the process finish the current turn and exit.
    public func end() { process.closeInput() }
    public func terminate() { process.terminate() }
    public func waitUntilExit() async -> Int32 { await process.waitUntilExit() }

    private func handle(line: String) {
        guard let value = try? JSONValue.parse(line), let type = value["type"]?.string else { return }
        switch type {
        case "system":
            let subtype = value["subtype"]?.string ?? ""
            if subtype == "init" {
                sessionId = value["session_id"]?.string
                eventContinuation.yield(.initialized(sessionId: sessionId ?? "", model: value["model"]?.string, info: value))
            } else {
                eventContinuation.yield(.system(subtype: subtype, payload: value))
            }
        case "assistant":
            for block in value["message"]?["content"]?.array ?? [] {
                switch block["type"]?.string {
                case "text": eventContinuation.yield(.assistantText(block["text"]?.string ?? ""))
                case "tool_use": eventContinuation.yield(.assistantToolUse(name: block["name"]?.string ?? "", input: block["input"] ?? .null, id: block["id"]?.string ?? ""))
                default: break
                }
            }
        case "user":
            for block in value["message"]?["content"]?.array ?? [] where block["type"]?.string == "tool_result" {
                eventContinuation.yield(.toolResult(toolUseId: block["tool_use_id"]?.string ?? "", content: block["content"] ?? .null, isError: block["is_error"]?.bool ?? false))
            }
        case "stream_event":
            if let delta = value["event"]?["delta"], delta["type"]?.string == "text_delta" { eventContinuation.yield(.textDelta(delta["text"]?.string ?? "")) }
        case "result":
            eventContinuation.yield(.result(sessionId: value["session_id"]?.string ?? "", text: value["result"]?.string,
                                            isError: value["is_error"]?.bool ?? false, costUSD: value["total_cost_usd"]?.double, durationMs: value["duration_ms"]?.int))
        case "control_request":
            handleControlRequest(value)
        default:
            eventContinuation.yield(.other(value))
        }
    }

    private func handleControlRequest(_ value: JSONValue) {
        let requestId = value["request_id"]?.string ?? ""
        let request = value["request"] ?? .null
        guard request["subtype"]?.string == "can_use_tool" else {
            respond(requestId: requestId, error: "unsupported control request \(request["subtype"]?.string ?? "?")")
            return
        }
        let permission = ClaudePermissionRequest(requestId: requestId, toolName: request["tool_name"]?.string ?? "", input: request["input"] ?? .null,
                                                 toolUseId: request["tool_use_id"]?.string, suggestions: request["permission_suggestions"],
                                                 decisionReason: request["decision_reason"]?.string)
        Task { [weak self] in
            guard let self else { return }
            let decision = await self.permissionHandler(permission)
            let payload: JSONValue
            switch decision {
            case .allow(let updated): payload = ["behavior": "allow", "updatedInput": updated ?? permission.input]
            case .deny(let message): payload = ["behavior": "deny", "message": .string(message)]
            }
            self.respond(requestId: requestId, result: payload)
        }
    }

    private func respond(requestId: String, result: JSONValue) {
        let response: JSONValue = ["type": "control_response", "response": ["subtype": "success", "request_id": .string(requestId), "response": result]]
        if let line = try? response.serialized() { try? process.send(line: line) }
    }

    private func respond(requestId: String, error: String) {
        let response: JSONValue = ["type": "control_response", "response": ["subtype": "error", "request_id": .string(requestId), "error": .string(error)]]
        if let line = try? response.serialized() { try? process.send(line: line) }
    }
}
