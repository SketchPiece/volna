import Foundation

/// A thread as `thread/list` and `thread/read` describe it. Only the fields the app shows are typed.
public struct CodexThread: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String?
    public var preview: String
    public var cwd: String
    public var createdAt: Date
    public var updatedAt: Date
    public var sourceKind: String
    public var originator: String?
    public var statusKind: String
    public var model: String?
    public var raw: JSONValue

    init?(_ value: JSONValue) {
        guard let id = value["id"]?.string else { return nil }
        self.id = id
        name = value["name"]?.string
        preview = value["preview"]?.string ?? ""
        cwd = value["cwd"]?.string ?? ""
        createdAt = Date(timeIntervalSince1970: value["createdAt"]?.double ?? 0)
        updatedAt = Date(timeIntervalSince1970: value["updatedAt"]?.double ?? 0)
        sourceKind = value["source"]?.string ?? value["source"]?["type"]?.string ?? "unknown"
        originator = value["originator"]?.string
        statusKind = value["status"]?["type"]?.string ?? "unknown"
        model = value["model"]?.string
        raw = value
    }
}

public enum CodexEvent: Sendable {
    case threadStarted(threadId: String)
    case threadStatusChanged(threadId: String, status: String)
    case turnStarted(threadId: String, turnId: String)
    case turnCompleted(threadId: String, turnId: String, status: String, errorMessage: String?)
    case agentMessageDelta(threadId: String, turnId: String, itemId: String, delta: String)
    case reasoningDelta(threadId: String, itemId: String, delta: String)
    case commandOutputDelta(threadId: String, itemId: String, delta: String)
    case itemStarted(threadId: String, turnId: String, item: JSONValue)
    case itemCompleted(threadId: String, turnId: String, item: JSONValue)
    case tokenUsage(threadId: String, usage: JSONValue)
    /// Another client (ChatGPT.app on the shared server) or this one answered a server request; the answer itself is not included.
    case requestResolved(threadId: String, requestId: JSONValue)
    case other(method: String, params: JSONValue)
}

public struct CodexApprovalRequest: Sendable {
    public enum Kind: Sendable {
        case command(command: String?, cwd: String?, reason: String?)
        case fileChange(reason: String?, changes: JSONValue?)
        case permissions(JSONValue)
        case userInput(JSONValue)
        case elicitation(JSONValue)
    }
    public var kind: Kind
    public var method: String
    public var threadId: String?
    public var turnId: String?
    /// JSON-RPC id of the request, matched by `requestResolved` when someone else answers first.
    public var requestId: JSONValue = .null
    public var itemId: String?
    public var raw: JSONValue
}

public enum CodexApprovalDecision: String, Sendable {
    case accept, acceptForSession, decline, cancel
}

/// One `codex app-server`, as a child over stdio or shared over WebSocket (`CodexTransport`).
/// Threads on disk are shared with every other Codex client on the machine (ChatGPT.app, CLI),
/// so `listThreads` sees them all; only *loaded* state is per server.
public final class CodexClient: @unchecked Sendable {
    public typealias ApprovalHandler = @Sendable (CodexApprovalRequest) async -> CodexApprovalDecision

    public let events: AsyncStream<CodexEvent>
    private let eventContinuation: AsyncStream<CodexEvent>.Continuation
    private let transport: CodexTransport
    private let rpc: JSONRPCClient
    private var pump: Task<Void, Never>?
    private var approvalHandler: ApprovalHandler = { _ in .decline }
    public private(set) var serverInfo: JSONValue = .null

    public convenience init(executable: String = "codex", extraArguments: [String] = []) {
        self.init(transport: StdioCodexTransport(executable: executable, arguments: ["app-server"] + extraArguments))
    }

    public init(transport: CodexTransport) {
        self.transport = transport
        rpc = JSONRPCClient { line in try transport.send(line: line) }
        var continuation: AsyncStream<CodexEvent>.Continuation!
        events = AsyncStream { continuation = $0 }
        eventContinuation = continuation
    }

    public func setApprovalHandler(_ handler: @escaping ApprovalHandler) { approvalHandler = handler }

    /// Spawns the server and completes the `initialize` / `initialized` handshake.
    public func start(clientName: String = "volna_pult", clientTitle: String = "Волна: Пульт", version: String = "0.1.0") async throws {
        try await transport.open()
        await rpc.setServerRequestHandler { [weak self] request in
            guard let self else { return .failure(JSONRPCError(code: -32000, message: "client gone")) }
            return await self.handleServerRequest(request)
        }
        pump = Task { [transport, rpc, eventContinuation] in
            for await line in transport.lines { await rpc.receive(line: line) }
            await rpc.close(error: CodexError.serverExited)
            eventContinuation.finish()
        }
        Task { [rpc, eventContinuation] in
            for await notification in rpc.notifications { eventContinuation.yield(Self.event(from: notification)) }
        }
        serverInfo = try await rpc.request("initialize", params: [
            "clientInfo": ["name": .string(clientName), "title": .string(clientTitle), "version": .string(version)],
            "capabilities": ["experimentalApi": true],
        ])
        try await rpc.notify("initialized", params: [:])
    }

    public func stop() {
        pump?.cancel()
        transport.close()
    }

    public func listThreads(limit: Int = 25, cursor: String? = nil, sourceKinds: [String]? = nil, archived: Bool = false,
                            sortKey: String = "updated_at", cwd: String? = nil, searchTerm: String? = nil) async throws -> (threads: [CodexThread], nextCursor: String?) {
        var params: [String: JSONValue] = ["limit": .number(Double(limit)), "archived": .bool(archived), "sortKey": .string(sortKey)]
        if let cursor { params["cursor"] = .string(cursor) }
        if let sourceKinds { params["sourceKinds"] = .array(sourceKinds.map(JSONValue.string)) }
        if let cwd { params["cwd"] = .string(cwd) }
        if let searchTerm { params["searchTerm"] = .string(searchTerm) }
        let result = try await rpc.request("thread/list", params: .object(params))
        let threads = (result["data"]?.array ?? []).compactMap(CodexThread.init)
        return (threads, result["nextCursor"]?.string)
    }

    public func loadedThreadIds() async throws -> [String] {
        let result = try await rpc.request("thread/loaded/list", params: [:])
        return (result["data"]?.array ?? []).compactMap(\.string)
    }

    public func startThread(cwd: String? = nil, model: String? = nil, approvalPolicy: String? = nil, sandbox: String? = nil) async throws -> CodexThread {
        var params: [String: JSONValue] = [:]
        if let cwd { params["cwd"] = .string(cwd) }
        if let model { params["model"] = .string(model) }
        if let approvalPolicy { params["approvalPolicy"] = .string(approvalPolicy) }
        if let sandbox { params["sandbox"] = .string(sandbox) }
        let result = try await rpc.request("thread/start", params: .object(params))
        guard let thread = result["thread"].flatMap(CodexThread.init) else { throw CodexError.malformed("thread/start", result) }
        return thread
    }

    public func resumeThread(id: String) async throws -> CodexThread {
        let result = try await rpc.request("thread/resume", params: ["threadId": .string(id)])
        guard let thread = result["thread"].flatMap(CodexThread.init) else { throw CodexError.malformed("thread/resume", result) }
        return thread
    }

    public func readThread(id: String, includeTurns: Bool = true) async throws -> JSONValue {
        try await rpc.request("thread/read", params: ["threadId": .string(id), "includeTurns": .bool(includeTurns)])
    }

    public func listItems(threadId: String, limit: Int? = nil, cursor: String? = nil) async throws -> JSONValue {
        var params: [String: JSONValue] = ["threadId": .string(threadId)]
        if let limit { params["limit"] = .number(Double(limit)) }
        if let cursor { params["cursor"] = .string(cursor) }
        return try await rpc.request("thread/items/list", params: .object(params))
    }

    /// Starts a turn and returns its id; progress arrives on `events`.
    @discardableResult
    public func startTurn(threadId: String, text: String, cwd: String? = nil, model: String? = nil, effort: String? = nil,
                          approvalPolicy: String? = nil, sandboxPolicy: JSONValue? = nil) async throws -> String {
        var params: [String: JSONValue] = ["threadId": .string(threadId), "input": [["type": "text", "text": .string(text)]]]
        if let cwd { params["cwd"] = .string(cwd) }
        if let model { params["model"] = .string(model) }
        if let effort { params["effort"] = .string(effort) }
        if let approvalPolicy { params["approvalPolicy"] = .string(approvalPolicy) }
        if let sandboxPolicy { params["sandboxPolicy"] = sandboxPolicy }
        let result = try await rpc.request("turn/start", params: .object(params))
        guard let turnId = result["turn"]?["id"]?.string else { throw CodexError.malformed("turn/start", result) }
        return turnId
    }

    public func steer(threadId: String, expectedTurnId: String, text: String) async throws {
        _ = try await rpc.request("turn/steer", params: ["threadId": .string(threadId), "expectedTurnId": .string(expectedTurnId), "input": [["type": "text", "text": .string(text)]]])
    }

    public func interrupt(threadId: String, turnId: String) async throws {
        _ = try await rpc.request("turn/interrupt", params: ["threadId": .string(threadId), "turnId": .string(turnId)])
    }

    public func setThreadName(threadId: String, name: String) async throws {
        _ = try await rpc.request("thread/name/set", params: ["threadId": .string(threadId), "name": .string(name)])
    }

    public func listModels() async throws -> JSONValue { try await rpc.request("model/list", params: [:]) }
    public func readAccount() async throws -> JSONValue { try await rpc.request("account/read", params: [:]) }

    /// Escape hatch for methods without a typed wrapper.
    public func call(_ method: String, params: JSONValue = [:]) async throws -> JSONValue { try await rpc.request(method, params: params) }

    // MARK: - Server-initiated requests

    private func handleServerRequest(_ request: JSONRPCServerRequest) async -> Result<JSONValue, JSONRPCError> {
        let params = request.params
        let kind: CodexApprovalRequest.Kind
        switch request.method {
        case "item/commandExecution/requestApproval":
            kind = .command(command: params["command"]?.string, cwd: params["cwd"]?.string, reason: params["reason"]?.string)
        case "item/fileChange/requestApproval":
            kind = .fileChange(reason: params["reason"]?.string, changes: params["changes"])
        case "item/permissions/requestApproval":
            kind = .permissions(params)
        case "item/tool/requestUserInput":
            kind = .userInput(params)
        case "mcpServer/elicitation/request":
            kind = .elicitation(params)
        default:
            return .failure(JSONRPCError(code: -32601, message: "unsupported server request \(request.method)"))
        }
        var approval = CodexApprovalRequest(kind: kind, method: request.method, threadId: params["threadId"]?.string,
                                            turnId: params["turnId"]?.string, itemId: params["itemId"]?.string, raw: params)
        approval.requestId = request.id
        let decision = await approvalHandler(approval)
        switch kind {
        case .command, .fileChange:
            return .success(["decision": .string(decision.rawValue)])
        case .permissions:
            // Permissions are granted or declined as a whole; anything but accept declines.
            return .success(["decision": .string(decision == .accept || decision == .acceptForSession ? "accept" : "decline")])
        case .elicitation:
            return .success(Self.elicitationResponse(decision))
        case .userInput:
            return .failure(JSONRPCError(code: -32000, message: "user input is not supported yet"))
        }
    }

    /// Answer to `mcpServer/elicitation/request` in the shape the Codex TUI sends (codex-rs/tui, mcp_server_elicitation.rs):
    /// approval elicitations take no form content, and «remember for this thread» is `_meta.persist = "session"`.
    /// `always` is never sent from Pult.
    static func elicitationResponse(_ decision: CodexApprovalDecision) -> JSONValue {
        switch decision {
        case .accept: return ["action": "accept", "content": .null]
        case .acceptForSession: return ["action": "accept", "content": .null, "_meta": ["persist": "session"]]
        case .decline: return ["action": "decline", "content": .null]
        case .cancel: return ["action": "cancel", "content": .null]
        }
    }

    private static func event(from notification: JSONRPCNotification) -> CodexEvent {
        let p = notification.params
        let threadId = p["threadId"]?.string ?? p["thread"]?["id"]?.string ?? ""
        switch notification.method {
        case "thread/started": return .threadStarted(threadId: threadId)
        case "thread/status/changed": return .threadStatusChanged(threadId: threadId, status: p["status"]?["type"]?.string ?? "unknown")
        case "turn/started": return .turnStarted(threadId: threadId, turnId: p["turn"]?["id"]?.string ?? "")
        case "turn/completed":
            return .turnCompleted(threadId: threadId, turnId: p["turn"]?["id"]?.string ?? "", status: p["turn"]?["status"]?.string ?? "unknown",
                                  errorMessage: p["turn"]?["error"]?["message"]?.string)
        case "item/agentMessage/delta":
            return .agentMessageDelta(threadId: threadId, turnId: p["turnId"]?.string ?? "", itemId: p["itemId"]?.string ?? "", delta: p["delta"]?.string ?? "")
        case "item/reasoning/textDelta", "item/reasoning/summaryTextDelta":
            return .reasoningDelta(threadId: threadId, itemId: p["itemId"]?.string ?? "", delta: p["delta"]?.string ?? "")
        case "item/commandExecution/outputDelta":
            return .commandOutputDelta(threadId: threadId, itemId: p["itemId"]?.string ?? "", delta: p["delta"]?.string ?? "")
        case "item/started": return .itemStarted(threadId: threadId, turnId: p["turnId"]?.string ?? "", item: p["item"] ?? .null)
        case "item/completed": return .itemCompleted(threadId: threadId, turnId: p["turnId"]?.string ?? "", item: p["item"] ?? .null)
        case "thread/tokenUsage/updated": return .tokenUsage(threadId: threadId, usage: p)
        case "serverRequest/resolved": return .requestResolved(threadId: threadId, requestId: p["requestId"] ?? .null)
        default: return .other(method: notification.method, params: p)
        }
    }
}

public enum CodexError: Error, CustomStringConvertible {
    case serverExited
    case malformed(String, JSONValue)
    public var description: String {
        switch self {
        case .serverExited: return "codex app-server exited"
        case .malformed(let method, let value): return "unexpected \(method) response: \(value.pretty())"
        }
    }
}
