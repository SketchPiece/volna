import Foundation

public struct JSONRPCError: Error, Equatable, Sendable, CustomStringConvertible {
    public var code: Int
    public var message: String
    public var data: JSONValue?
    public init(code: Int, message: String, data: JSONValue? = nil) { self.code = code; self.message = message; self.data = data }
    public var description: String { "JSON-RPC \(code): \(message)" }
}

public struct JSONRPCServerRequest: Sendable {
    public var id: JSONValue
    public var method: String
    public var params: JSONValue
}

public struct JSONRPCNotification: Sendable {
    public var method: String
    public var params: JSONValue
}

/// Bidirectional JSON-RPC 2.0 over a line transport, as used by `codex app-server`.
/// The wire omits the `jsonrpc` header, matching the Codex documentation.
public actor JSONRPCClient {
    public typealias ServerRequestHandler = @Sendable (JSONRPCServerRequest) async -> Result<JSONValue, JSONRPCError>

    public nonisolated let notifications: AsyncStream<JSONRPCNotification>
    private let notificationContinuation: AsyncStream<JSONRPCNotification>.Continuation
    private let sendLine: @Sendable (String) throws -> Void
    private var nextId = 0
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var serverRequestHandler: ServerRequestHandler?
    private var closed: Error?

    public init(sendLine: @escaping @Sendable (String) throws -> Void) {
        self.sendLine = sendLine
        var continuation: AsyncStream<JSONRPCNotification>.Continuation!
        notifications = AsyncStream { continuation = $0 }
        notificationContinuation = continuation
    }

    public func setServerRequestHandler(_ handler: @escaping ServerRequestHandler) {
        serverRequestHandler = handler
    }

    public func request(_ method: String, params: JSONValue? = nil) async throws -> JSONValue {
        if let closed { throw closed }
        nextId += 1
        let id = nextId
        var message: [String: JSONValue] = ["id": .number(Double(id)), "method": .string(method)]
        if let params { message["params"] = params }
        let line = try JSONValue.object(message).serialized()
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do { try sendLine(line) } catch { pending[id] = nil; continuation.resume(throwing: error) }
        }
    }

    public func notify(_ method: String, params: JSONValue? = nil) throws {
        var message: [String: JSONValue] = ["method": .string(method)]
        if let params { message["params"] = params }
        try sendLine(try JSONValue.object(message).serialized())
    }

    /// Feed one line from the transport. Malformed lines are ignored (agents may print diagnostics).
    public func receive(line: String) {
        guard let value = try? JSONValue.parse(line), let object = value.object else { return }
        let hasId = object["id"] != nil && !(object["id"]?.isNull ?? true)
        if let method = object["method"]?.string {
            let params = object["params"] ?? .null
            if hasId, let id = object["id"] {
                handleServerRequest(JSONRPCServerRequest(id: id, method: method, params: params))
            } else {
                notificationContinuation.yield(JSONRPCNotification(method: method, params: params))
            }
            return
        }
        guard let id = object["id"]?.int, let continuation = pending.removeValue(forKey: id) else { return }
        if let error = object["error"] {
            continuation.resume(throwing: JSONRPCError(code: error["code"]?.int ?? -1, message: error["message"]?.string ?? "unknown error", data: error["data"]))
        } else {
            continuation.resume(returning: object["result"] ?? .null)
        }
    }

    /// The transport closed: fail every outstanding request and end the notification stream.
    public func close(error: Error) {
        closed = error
        let waiting = pending
        pending = [:]
        waiting.values.forEach { $0.resume(throwing: error) }
        notificationContinuation.finish()
    }

    private func handleServerRequest(_ request: JSONRPCServerRequest) {
        guard let handler = serverRequestHandler else {
            respond(id: request.id, result: .failure(JSONRPCError(code: -32601, message: "no handler for \(request.method)")))
            return
        }
        Task {
            let result = await handler(request)
            await self.respond(id: request.id, result: result)
        }
    }

    private func respond(id: JSONValue, result: Result<JSONValue, JSONRPCError>) {
        var message: [String: JSONValue] = ["id": id]
        switch result {
        case .success(let value): message["result"] = value
        case .failure(let error):
            var payload: [String: JSONValue] = ["code": .number(Double(error.code)), "message": .string(error.message)]
            if let data = error.data { payload["data"] = data }
            message["error"] = .object(payload)
        }
        if let line = try? JSONValue.object(message).serialized() { try? sendLine(line) }
    }
}
