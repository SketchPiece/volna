import Foundation
import Network
import Security

// MARK: - Router (pure, testable)

/// One HTTP request the bridge sent. Only what the router needs.
public struct BridgeRequest: Sendable, Equatable {
    public var method: String
    public var path: String
    public var authorization: String?
    public var body: Data
    public init(method: String, path: String, authorization: String? = nil, body: Data = Data()) {
        self.method = method; self.path = path; self.authorization = authorization; self.body = body
    }
}

public struct BridgeResponse: Sendable, Equatable {
    public var status: Int
    public var json: JSONValue
    public init(_ status: Int, _ json: JSONValue) { self.status = status; self.json = json }
    public static func ok(_ json: JSONValue) -> BridgeResponse { BridgeResponse(200, json) }
    public static func error(_ status: Int, _ message: String) -> BridgeResponse { BridgeResponse(status, ["error": .string(message)]) }
}

/// What happened when the bridge asked for a new Claude Desktop chat.
public struct BridgeStarted: Equatable, Sendable {
    /// Claude Desktop took the deep link: a new chat is open in the folder with the text typed in.
    public var opened: Bool
    /// Pult pressed Return and the composer emptied; otherwise the chat waits for Return on the Mac.
    public var sent: Bool
    /// Why it was not sent: needs_confirmation (the owner decides on the phone), auto_send_off, no_accessibility,
    /// composer_not_found, send_not_confirmed.
    public var reason: String?
    /// `claude:<sessionId>` once the sent chat showed up in the session registry.
    public var sessionId: String?
    public init(opened: Bool, sent: Bool = false, reason: String? = nil, sessionId: String? = nil) {
        self.opened = opened; self.sent = sent; self.reason = reason; self.sessionId = sessionId
    }
}

/// What the bridge may do with Pult. The hub supplies the closures; tests supply fakes.
public struct BridgeActions: Sendable {
    public var sessions: @Sendable @MainActor () -> [HubSession]
    public var send: @Sendable @MainActor (HubSession, String) throws -> Void
    public var open: @Sendable @MainActor (HubSession) throws -> Void
    /// Known project folders, most recent first.
    public var projects: @Sendable @MainActor () -> [String]
    /// New Claude Desktop chat in the folder with the text; Pult sends it when Accessibility allows (`ClaudeDesktopComposer`).
    public var start: @Sendable @MainActor (_ folder: String, _ text: String) async throws -> BridgeStarted
    /// Decisions waiting for a tap on the phone, and recently resolved ones.
    public var confirmations: @Sendable @MainActor () -> [Confirmation]
    /// The tap itself. Nil for an unknown id.
    public var decide: @Sendable @MainActor (_ id: String, _ approve: Bool) async -> Confirmation?
    /// A computer job for Codex (Астра): `ComputerJobs.start`. `ref` is the bridge's task id.
    public var computerStart: @Sendable @MainActor (_ text: String, _ ref: String?) async throws -> ComputerJob
    public var computerJobs: @Sendable @MainActor () -> [ComputerJob]
    /// Nil for an unknown id.
    public var computerCancel: @Sendable @MainActor (_ id: String) async -> ComputerJob?
    /// A snapshot of one of the bridge's background tasks for the «Работа» tab.
    public var taskReport: @Sendable @MainActor (BackgroundTask) -> Void
    /// Session questions held for Волна (`QuestionDesk`); `listen` marks that a call is live and questions may be held.
    public var questions: @Sendable @MainActor () -> [SessionQuestion]
    public var listen: @Sendable @MainActor () -> Void
    public var answerQuestion: @Sendable @MainActor (_ id: String, _ answers: [String: String], _ single: String?) -> Result<SessionQuestion, QuestionAnswerError>
    public var passQuestion: @Sendable @MainActor (_ id: String) -> Result<SessionQuestion, QuestionAnswerError>
    public init(sessions: @escaping @Sendable @MainActor () -> [HubSession],
                send: @escaping @Sendable @MainActor (HubSession, String) throws -> Void,
                open: @escaping @Sendable @MainActor (HubSession) throws -> Void,
                projects: @escaping @Sendable @MainActor () -> [String] = { [] },
                start: @escaping @Sendable @MainActor (String, String) async throws -> BridgeStarted = { _, _ in throw ClaudeError.socket("not supported") },
                confirmations: @escaping @Sendable @MainActor () -> [Confirmation] = { [] },
                decide: @escaping @Sendable @MainActor (String, Bool) async -> Confirmation? = { _, _ in nil },
                computerStart: @escaping @Sendable @MainActor (String, String?) async throws -> ComputerJob = { _, _ in throw ClaudeError.socket("not supported") },
                computerJobs: @escaping @Sendable @MainActor () -> [ComputerJob] = { [] },
                computerCancel: @escaping @Sendable @MainActor (String) async -> ComputerJob? = { _ in nil },
                taskReport: @escaping @Sendable @MainActor (BackgroundTask) -> Void = { _ in },
                questions: @escaping @Sendable @MainActor () -> [SessionQuestion] = { [] },
                listen: @escaping @Sendable @MainActor () -> Void = {},
                answerQuestion: @escaping @Sendable @MainActor (String, [String: String], String?) -> Result<SessionQuestion, QuestionAnswerError> = { _, _, _ in .failure(.unknown) },
                passQuestion: @escaping @Sendable @MainActor (String) -> Result<SessionQuestion, QuestionAnswerError> = { _ in .failure(.unknown) }) {
        self.sessions = sessions; self.send = send; self.open = open; self.projects = projects; self.start = start
        self.confirmations = confirmations; self.decide = decide
        self.computerStart = computerStart; self.computerJobs = computerJobs; self.computerCancel = computerCancel
        self.taskReport = taskReport
        self.questions = questions; self.listen = listen; self.answerQuestion = answerQuestion; self.passQuestion = passQuestion
    }
}

/// Matches a spoken project name against known folders: an absolute path, then the folder name, then a unique substring.
public enum ProjectMatch: Equatable, Sendable {
    case found(String)
    case ambiguous([String])
    case unknown

    public static func resolve(_ query: String, among folders: [String], isDirectory: (String) -> Bool = { path in
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && directory.boolValue
    }) -> ProjectMatch {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .unknown }
        let expanded = (trimmed as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") { return isDirectory(expanded) ? .found((expanded as NSString).standardizingPath) : .unknown }
        let key = simplified(trimmed)
        let exact = folders.filter { simplified(($0 as NSString).lastPathComponent) == key }
        if exact.count == 1 { return .found(exact[0]) }
        if exact.count > 1 { return .ambiguous(exact) }
        let partial = folders.filter { simplified(($0 as NSString).lastPathComponent).contains(key) }
        if partial.count == 1 { return .found(partial[0]) }
        return partial.isEmpty ? .unknown : .ambiguous(partial)
    }

    /// Case, spaces, dashes and underscores do not matter: «call assistant» finds CallAssistant.
    static func simplified(_ text: String) -> String {
        text.lowercased().filter { !$0.isWhitespace && $0 != "-" && $0 != "_" && $0 != "." }
    }
}

/// Routes the bridge's calls: `GET /health`, `GET /sessions`, `GET /projects`, `POST /sessions` (new Claude Desktop chat),
/// `POST /sessions/{id}/message`, `POST /sessions/{id}/open`, `GET /confirmations`, `POST /confirmations/{id}`,
/// `POST /computer` (a job for Codex with Computer Use), `GET /computer`, `GET /computer/{id}`, `POST /computer/{id}/cancel`,
/// `PUT /tasks/{id}` (a snapshot of the bridge's background task for the «Работа» tab),
/// `GET /questions[?listen=1]` (session questions held for Волна; `listen=1` only while a call is live),
/// `POST /questions/{id}` with `{"answer": …}`, `{"answers": {question: answer}}` or `{"pass": true}`.
/// The confirmation routes are for the phone only: the bridge proxies them to the app and never gives them to the model.
/// Every route but `/health` needs `Authorization: Bearer <token>`. Contract mirrored in `server/src/assistant/tools/pult.ts`.
public struct BridgeRouter: Sendable {
    public var token: String
    public var actions: BridgeActions
    public init(token: String, actions: BridgeActions) { self.token = token; self.actions = actions }

    @MainActor
    public func handle(_ request: BridgeRequest) async -> BridgeResponse {
        let parts = request.path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? request.path
        let segments = parts.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }
        if request.method == "GET", segments == ["health"] {
            return .ok(["ok": true, "sessions": .number(Double(actions.sessions().count))])
        }
        guard !token.isEmpty, request.authorization == "Bearer \(token)" else { return .error(401, "bad or missing bridge token") }
        switch (request.method, segments.count, segments.first) {
        case ("GET", 1, "sessions"):
            return .ok(["sessions": .array(actions.sessions().map(Self.json))])
        case ("GET", 1, "projects"):
            return .ok(["projects": .array(actions.projects().map(Self.project))])
        case ("POST", 1, "sessions"):
            return await start(request.body)
        case ("GET", 1, "confirmations"):
            return .ok(["confirmations": .array(actions.confirmations().map(Self.json))])
        case ("POST", 2, "confirmations"):
            let decision = (try? JSONDecoder().decode(JSONValue.self, from: request.body))?["decision"]?.string
            guard decision == "approve" || decision == "decline" else { return .error(400, "body must be {\"decision\": \"approve\" | \"decline\"}") }
            guard let before = actions.confirmations().first(where: { $0.id == segments[1] }) else { return .error(404, "no such confirmation") }
            guard before.state == .pending else { return BridgeResponse(409, ["error": "already answered", "confirmation": Self.json(before)]) }
            guard let after = await actions.decide(segments[1], decision == "approve") else { return .error(404, "no such confirmation") }
            return .ok(["confirmation": Self.json(after)])
        case ("POST", 1, "computer"):
            guard let text = Self.text(in: request.body) else { return .error(400, "body must be {\"text\": …}") }
            let ref = (try? JSONDecoder().decode(JSONValue.self, from: request.body))?["ref"]?.string
            do { return .ok(["job": Self.json(try await actions.computerStart(text, ref))]) } catch { return .error(502, "start failed: \(error)") }
        case ("GET", 1, "questions"):
            if request.path.contains("listen=1") { actions.listen() }
            let sessions = actions.sessions()
            return .ok(["questions": .array(actions.questions().map { Self.json($0, sessions: sessions) })])
        case ("POST", 2, "questions"):
            guard let body = try? JSONDecoder().decode(JSONValue.self, from: request.body) else {
                return .error(400, "body must be {\"answer\": …}, {\"answers\": {…}} or {\"pass\": true}")
            }
            let result: Result<SessionQuestion, QuestionAnswerError>
            if body["pass"]?.bool == true {
                result = actions.passQuestion(segments[1])
            } else if let single = body["answer"]?.string {
                result = actions.answerQuestion(segments[1], [:], single)
            } else if let given = body["answers"]?.object {
                result = actions.answerQuestion(segments[1], given.compactMapValues(\.string), nil)
            } else {
                return .error(400, "body must be {\"answer\": …}, {\"answers\": {…}} or {\"pass\": true}")
            }
            let sessions = actions.sessions()
            switch result {
            case .success(let question): return .ok(["question": Self.json(question, sessions: sessions)])
            case .failure(.unknown): return .error(404, "no such question")
            case .failure(.notPending(let state)):
                return BridgeResponse(409, ["error": .string("question is \(state.rawValue)"),
                                            "question": actions.questions().first { $0.id == segments[1] }.map { Self.json($0, sessions: sessions) } ?? .null])
            case .failure(.mismatch(let why)): return .error(400, why)
            }
        case ("PUT", 2, "tasks"):
            guard let body = try? JSONDecoder().decode(JSONValue.self, from: request.body),
                  let task = BackgroundTask(id: segments[1], json: body) else { return .error(400, "body must be a task snapshot {title, status, …}") }
            actions.taskReport(task)
            return .ok(["ok": true])
        case ("GET", 1, "computer"):
            return .ok(["jobs": .array(actions.computerJobs().map(Self.json))])
        case ("GET", 2, "computer"):
            guard let job = actions.computerJobs().first(where: { $0.id == segments[1] }) else { return .error(404, "no such job") }
            return .ok(["job": Self.json(job)])
        case ("POST", 3, "computer") where segments[2] == "cancel":
            guard let job = await actions.computerCancel(segments[1]) else { return .error(404, "no such job") }
            return .ok(["job": Self.json(job)])
        case ("POST", 3, "sessions"):
            guard let session = actions.sessions().first(where: { $0.id == segments[1] }) else { return .error(404, "no such session") }
            switch segments[2] {
            case "message":
                guard let text = Self.text(in: request.body) else { return .error(400, "body must be {\"text\": …}") }
                guard session.inboxSocket != nil else { return .error(409, "\(session.origin.label) sessions cannot receive messages yet") }
                do { try actions.send(session, text) } catch { return .error(502, "send failed: \(error)") }
                return .ok(["sent": true, "id": .string(session.id), "name": .string(session.name)])
            case "open":
                guard session.openURL != nil else { return .error(409, "session has no deep link") }
                do { try actions.open(session) } catch { return .error(502, "open failed: \(error)") }
                return .ok(["opened": true, "id": .string(session.id), "name": .string(session.name)])
            default:
                return .error(404, "unknown action")
            }
        default:
            return .error(404, "unknown route")
        }
    }

    @MainActor
    private func start(_ body: Data) async -> BridgeResponse {
        guard let text = Self.text(in: body) else { return .error(400, "body must be {\"project\": …, \"text\": …}") }
        let query = (try? JSONDecoder().decode(JSONValue.self, from: body))?["project"]?.string ?? ""
        let projects = actions.projects()
        let folder: String
        switch ProjectMatch.resolve(query, among: projects) {
        case .found(let path): folder = path
        case .ambiguous(let paths):
            return BridgeResponse(409, ["error": "ambiguous project", "projects": .array(paths.map(Self.project))])
        case .unknown:
            return BridgeResponse(404, ["error": "unknown project", "projects": .array(projects.prefix(12).map(Self.project))])
        }
        do {
            let started = try await actions.start(folder, text)
            guard started.opened else { return .error(502, "Claude Desktop did not take the link") }
            return .ok(["opened": true, "sent": .bool(started.sent), "reason": started.reason.map(JSONValue.string) ?? .null,
                        "id": started.sessionId.map(JSONValue.string) ?? .null,
                        "project": .string((folder as NSString).lastPathComponent), "cwd": .string(folder)])
        } catch {
            return .error(502, "start failed: \(error)")
        }
    }

    /// Confirmation as the phone sees it; the card's words are the phone's (`CallCopy`).
    public static func json(_ c: Confirmation) -> JSONValue {
        let formatter = ISO8601DateFormatter()
        return .object([
            "id": .string(c.id), "kind": .string(c.kind.rawValue), "state": .string(c.state.rawValue),
            "folder": .string(c.folder), "project": .string(c.project), "prompt": .string(String(c.prompt.prefix(300))),
            "expiresAt": .string(formatter.string(from: c.expiresAt)),
            "result": c.result.map(JSONValue.string) ?? .null, "sessionId": c.sessionId.map(JSONValue.string) ?? .null,
            "app": c.app.map(JSONValue.string) ?? .null
        ])
    }

    /// Session question as the bridge sees it: who asks, what, the options, and what became of it.
    public static func json(_ q: SessionQuestion, sessions: [HubSession] = []) -> JSONValue {
        let formatter = ISO8601DateFormatter()
        let session = sessions.first { $0.id == "claude:\(q.sessionId)" }
        return .object([
            "id": .string(q.id), "state": .string(q.state.rawValue),
            "sessionId": .string("claude:\(q.sessionId)"), "session": session.map { .string($0.name) } ?? .null, "project": .string(q.project),
            "questions": .array(q.items.map { item in
                .object(["question": .string(item.question), "header": item.header.map(JSONValue.string) ?? .null, "multiSelect": .bool(item.multiSelect),
                         "options": .array(item.options.map { ["label": .string($0.label), "description": $0.description.map(JSONValue.string) ?? .null] })])
            }),
            "answers": .object(q.answers.mapValues(JSONValue.string)),
            "expiresAt": .string(formatter.string(from: q.expiresAt))
        ])
    }

    /// Computer job as the bridge sees it; `reply` is what Волна retells.
    public static func json(_ j: ComputerJob) -> JSONValue {
        let formatter = ISO8601DateFormatter()
        return .object([
            "id": .string(j.id), "state": .string(j.state.rawValue), "task": .string(String(j.task.prefix(300))),
            "pendingApp": j.pendingApp.map(JSONValue.string) ?? .null,
            "allowedApps": .array(j.allowedApps.map(JSONValue.string)), "declinedApps": .array(j.declinedApps.map(JSONValue.string)),
            "reply": j.reply.map { .string(String($0.prefix(2000))) } ?? .null, "error": j.error.map(JSONValue.string) ?? .null,
            "threadId": j.threadId.map(JSONValue.string) ?? .null,
            "activity": .array(j.activity.map(JSONValue.string)), "activityTotal": .number(Double(j.activityTotal)),
            "ref": j.ref.map(JSONValue.string) ?? .null, "progress": j.progress.map(JSONValue.string) ?? .null,
            "createdAt": .string(formatter.string(from: j.createdAt)),
            "finishedAt": j.finishedAt.map { .string(formatter.string(from: $0)) } ?? .null
        ])
    }

    static func project(_ path: String) -> JSONValue {
        ["name": .string((path as NSString).lastPathComponent), "cwd": .string(path)]
    }

    static func text(in body: Data) -> String? {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: body), let text = value["text"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    /// Session as the bridge sees it: states in snake_case for the model, labels for speech.
    public static func json(_ s: HubSession) -> JSONValue {
        let state: String
        switch s.state {
        case .needsYou: state = "needs_you"
        case .working: state = "working"
        case .idle: state = "idle"
        case .failed: state = "failed"
        case .off: state = "off"
        }
        let formatter = ISO8601DateFormatter()
        return .object([
            "id": .string(s.id), "agent": .string(s.agent.rawValue), "origin": .string(s.origin.label),
            "state": .string(state), "stateLabel": .string(s.state.label), "name": .string(s.name),
            "project": .string(s.project), "cwd": .string(s.cwd),
            "detail": s.detail.map(JSONValue.string) ?? .null, "model": s.model.map(JSONValue.string) ?? .null,
            "updatedAt": s.updatedAt.map { .string(formatter.string(from: $0)) } ?? .null,
            "canMessage": .bool(s.inboxSocket != nil), "canOpen": .bool(s.openURL != nil),
            "lastReply": s.lastReply.map { .string(String($0.prefix(1500))) } ?? .null
        ])
    }
}

// MARK: - Loopback HTTP server

/// Minimal HTTP/1.1 server on 127.0.0.1 for the bridge. One request per connection, JSON in and out.
public final class BridgeAPIServer: @unchecked Sendable {
    public typealias Handler = @Sendable (BridgeRequest) async -> BridgeResponse
    private let handler: Handler
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "pult.bridge")
    public private(set) var port: UInt16 = 0
    private let counter = Counter()
    public var requestCount: Int { counter.value }

    public init(handler: @escaping Handler) { self.handler = handler }

    public func start(port requested: UInt16) async throws {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true
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

    public func stop() { listener?.cancel(); listener = nil }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        var received = Data()
        func readMore() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
                if let data { received.append(data) }
                if received.count > 1 << 20 { connection.cancel(); return }
                if let request = Self.parse(received) {
                    guard let self else { connection.cancel(); return }
                    self.counter.increment()
                    Task {
                        let response = await self.handler(request)
                        connection.send(content: Self.serialize(response), completion: .contentProcessed { _ in connection.cancel() })
                    }
                } else if isComplete || error != nil {
                    connection.cancel()
                } else {
                    readMore()
                }
            }
        }
        readMore()
    }

    /// Whole request (request line, headers, Content-Length bytes) or nil while more bytes are needed.
    public static func parse(_ data: Data) -> BridgeRequest? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[..<headerEnd.lowerBound], as: UTF8.self)
        let lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.first?.split(separator: " ").map(String.init) ?? []
        guard requestLine.count >= 2 else { return nil }
        var length = 0
        var authorization: String?
        for line in lines.dropFirst() {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let name = parts[0].trimmingCharacters(in: .whitespaces).lowercased()
            let value = parts[1].trimmingCharacters(in: .whitespaces)
            if name == "content-length" { length = Int(value) ?? 0 }
            if name == "authorization" { authorization = value }
        }
        let body = data[headerEnd.upperBound...]
        guard body.count >= length else { return nil }
        return BridgeRequest(method: requestLine[0].uppercased(), path: requestLine[1], authorization: authorization, body: Data(body.prefix(length)))
    }

    public static func serialize(_ response: BridgeResponse) -> Data {
        let body = (try? response.json.serialized()) ?? "{}"
        let reason = response.status == 200 ? "OK" : response.status == 401 ? "Unauthorized" : response.status == 404 ? "Not Found" : "Error"
        let head = "HTTP/1.1 \(response.status) \(reason)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n"
        return Data((head + body).utf8)
    }
}

final class Counter: @unchecked Sendable {
    private var count = 0
    private let lock = NSLock()
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    func increment() { lock.lock(); count += 1; lock.unlock() }
}

// MARK: - Token in the Keychain

/// The shared secret the bridge presents. Generated once, kept in the login Keychain, never logged.
public enum BridgeToken {
    static let service = "dev.prototype.volna.pult"
    static let account = "bridge-token"

    public static func current() -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// Returns the stored token, creating one on first use.
    public static func ensure() throws -> String {
        if let existing = current(), !existing.isEmpty { return existing }
        let token = generate()
        let attributes: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                         kSecAttrAccount as String: account, kSecValueData as String: Data(token.utf8),
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        return token
    }

    public static func rotate() throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        return try ensure()
    }

    static func generate() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
