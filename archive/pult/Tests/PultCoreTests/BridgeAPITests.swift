import XCTest
@testable import PultCore

@MainActor
final class BridgeAPITests: XCTestCase {
    private final class Box: @unchecked Sendable { var sent: [(String, String)] = []; var opened: [String] = []; var started: [(String, String)] = [] }

    private func session(_ id: String, state: HubSession.State = .idle, socket: String? = "/tmp/cc-socks/1.sock", url: String? = "claude://x") -> HubSession {
        HubSession(id: id, agent: id.hasPrefix("codex") ? .codex : .claude, origin: id.hasPrefix("codex") ? .codexApp : .claudeDesktop,
                   state: state, name: "Сессия \(id)", cwd: "/p/CallAssistant", detail: nil, updatedAt: nil,
                   openURL: url.flatMap(URL.init(string:)), inboxSocket: socket)
    }

    private func router(_ box: Box, sessions: [HubSession]) -> BridgeRouter {
        BridgeRouter(token: "t0k", actions: BridgeActions(
            sessions: { sessions },
            send: { s, text in box.sent.append((s.id, text)) },
            open: { s in box.opened.append(s.id) },
            projects: { ["/p/CallAssistant", "/w/Mono/apps/Studio3D", "/w/Mono/apps/Studio2D"] },
            start: { folder, text in box.started.append((folder, text)); return BridgeStarted(opened: true, sent: true, sessionId: "claude:new") }))
    }

    func testNewDesktopChatResolvesTheProjectByName() async throws {
        let box = Box()
        let router = router(box, sessions: [])
        func post(_ body: JSONValue) async throws -> BridgeResponse {
            await router.handle(BridgeRequest(method: "POST", path: "/sessions", authorization: "Bearer t0k", body: Data(try body.serialized().utf8)))
        }
        let ok = try await post(["project": "call assistant", "text": "Прогони тесты"])
        XCTAssertEqual(ok.status, 200)
        XCTAssertEqual(ok.json["opened"]?.bool, true)
        XCTAssertEqual(ok.json["sent"]?.bool, true)
        XCTAssertEqual(ok.json["id"]?.string, "claude:new")
        XCTAssertEqual(ok.json["cwd"]?.string, "/p/CallAssistant")
        XCTAssertEqual(ClaudeDesktopComposer.normalized("  Прогони\n\nтесты  "), "Прогони тесты", "composer text is compared whitespace-insensitively")
        XCTAssertEqual(box.started.first?.0, "/p/CallAssistant")
        XCTAssertEqual(box.started.first?.1, "Прогони тесты")
        let ambiguous = try await post(["project": "studio", "text": "x"])
        XCTAssertEqual(ambiguous.status, 409)
        XCTAssertEqual(ambiguous.json["projects"]?[1]?["name"]?.string, "Studio2D")
        let unknown = try await post(["project": "bim", "text": "x"])
        XCTAssertEqual(unknown.status, 404)
        XCTAssertEqual(unknown.json["projects"]?[0]?["name"]?.string, "CallAssistant")
        let r10 = try await post(["project": "studio3d"])
        XCTAssertEqual(r10.status, 400)
        XCTAssertEqual(box.started.count, 1)
        let projects = await router.handle(BridgeRequest(method: "GET", path: "/projects", authorization: "Bearer t0k"))
        XCTAssertEqual(projects.json["projects"]?[2]?["cwd"]?.string, "/w/Mono/apps/Studio2D")
    }

    func testProjectMatchPrefersExactNameThenUniqueSubstringThenExistingPath() {
        let folders = ["/a/CallAssistant", "/b/Studio3D", "/c/Studio3D-old"]
        XCTAssertEqual(ProjectMatch.resolve("studio3d", among: folders), .found("/b/Studio3D"))
        XCTAssertEqual(ProjectMatch.resolve("call", among: folders), .found("/a/CallAssistant"))
        XCTAssertEqual(ProjectMatch.resolve("studio", among: folders), .ambiguous(["/b/Studio3D", "/c/Studio3D-old"]))
        XCTAssertEqual(ProjectMatch.resolve("  ", among: folders), .unknown)
        XCTAssertEqual(ProjectMatch.resolve("/x/New", among: folders, isDirectory: { $0 == "/x/New" }), .found("/x/New"))
        XCTAssertEqual(ProjectMatch.resolve("/x/Missing", among: folders, isDirectory: { _ in false }), .unknown)
    }

    func testLastReplyComesFromTheHookOrTheTranscriptTail() {
        XCTAssertEqual(ClaudeTranscript.lastReply(["last_assistant_message": " Готово. "]), "Готово.")
        let jsonl = """
        {"type":"assistant","message":{"content":[{"type":"text","text":"Сначала"}]}}
        {"type":"user","message":{"content":"ok"}}
        {"type":"assistant","message":{"content":[{"type":"text","text":"Тесты зелёные"}]}}
        {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}
        """
        XCTAssertEqual(ClaudeTranscript.lastReply(jsonl: jsonl), "Тесты зелёные")
        XCTAssertNil(ClaudeTranscript.lastReply(["transcript_path": "/nonexistent.jsonl"]))
    }

    func testHealthIsOpenEverythingElseNeedsTheToken() async {
        let router = router(Box(), sessions: [session("claude:a")])
        let r1 = await router.handle(BridgeRequest(method: "GET", path: "/health"))
        XCTAssertEqual(r1.status, 200)
        let r2 = await router.handle(BridgeRequest(method: "GET", path: "/sessions"))
        XCTAssertEqual(r2.status, 401)
        let r3 = await router.handle(BridgeRequest(method: "GET", path: "/sessions", authorization: "Bearer wrong"))
        XCTAssertEqual(r3.status, 401)
        let ok = await router.handle(BridgeRequest(method: "GET", path: "/sessions", authorization: "Bearer t0k"))
        XCTAssertEqual(ok.status, 200)
        let first = ok.json["sessions"]?[0]
        XCTAssertEqual(first?["id"]?.string, "claude:a")
        XCTAssertEqual(first?["state"]?.string, "idle")
        XCTAssertEqual(first?["stateLabel"]?.string, "ЖДЁТ ЗАДАЧУ")
        XCTAssertEqual(first?["project"]?.string, "CallAssistant")
        XCTAssertEqual(first?["canMessage"]?.bool, true)
        let empty = await BridgeRouter(token: "", actions: router.actions).handle(BridgeRequest(method: "GET", path: "/sessions", authorization: "Bearer "))
        XCTAssertEqual(empty.status, 401, "an empty token never matches")
    }

    func testMessageAndOpenRoutes() async throws {
        let box = Box()
        let router = router(box, sessions: [session("claude:a", state: .needsYou), session("codex:b", socket: nil), session("claude:c", url: nil)])
        let body = try JSONValue.object(["text": "Прогони тесты"]).serialized()
        let sent = await router.handle(BridgeRequest(method: "POST", path: "/sessions/claude%3Aa/message", authorization: "Bearer t0k", body: Data(body.utf8)))
        XCTAssertEqual(sent.status, 200)
        XCTAssertEqual(sent.json["name"]?.string, "Сессия claude:a")
        XCTAssertEqual(box.sent.first?.1, "Прогони тесты")
        let r4 = await router.handle(BridgeRequest(method: "POST", path: "/sessions/codex:b/message", authorization: "Bearer t0k", body: Data(body.utf8)))
        XCTAssertEqual(r4.status, 409)
        let r5 = await router.handle(BridgeRequest(method: "POST", path: "/sessions/claude:a/message", authorization: "Bearer t0k", body: Data("{\"text\":\"  \"}".utf8)))
        XCTAssertEqual(r5.status, 400)
        let r6 = await router.handle(BridgeRequest(method: "POST", path: "/sessions/nope/message", authorization: "Bearer t0k", body: Data(body.utf8)))
        XCTAssertEqual(r6.status, 404)
        let r7 = await router.handle(BridgeRequest(method: "POST", path: "/sessions/codex:b/open", authorization: "Bearer t0k"))
        XCTAssertEqual(r7.status, 200)
        XCTAssertEqual(box.opened, ["codex:b"])
        let r8 = await router.handle(BridgeRequest(method: "POST", path: "/sessions/claude:c/open", authorization: "Bearer t0k"))
        XCTAssertEqual(r8.status, 409)
        let r9 = await router.handle(BridgeRequest(method: "DELETE", path: "/sessions/claude:a", authorization: "Bearer t0k"))
        XCTAssertEqual(r9.status, 404)
    }

    func testHTTPParsingWaitsForTheWholeBodyAndSerializesJSON() {
        let head = "POST /sessions/x/message HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer abc\r\nContent-Length: 13\r\n\r\n"
        XCTAssertNil(BridgeAPIServer.parse(Data((head + "{\"text\":").utf8)))
        let request = BridgeAPIServer.parse(Data((head + "{\"text\":\"hi\"}").utf8))
        XCTAssertEqual(request?.method, "POST")
        XCTAssertEqual(request?.path, "/sessions/x/message")
        XCTAssertEqual(request?.authorization, "Bearer abc")
        XCTAssertEqual(request.map { String(decoding: $0.body, as: UTF8.self) }, "{\"text\":\"hi\"}")
        let bytes = BridgeAPIServer.serialize(.error(401, "no"))
        let text = String(decoding: bytes, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("HTTP/1.1 401 Unauthorized\r\n"))
        XCTAssertTrue(text.hasSuffix("{\"error\":\"no\"}"))
    }

    func testServerRoundTripOverLoopback() async throws {
        let server = BridgeAPIServer { request in
            request.path == "/health" ? .ok(["ok": true]) : .error(404, "nope")
        }
        try await server.start(port: 0)
        defer { server.stop() }
        let (data, response) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(server.port)/health")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data)["ok"]?.bool, true)
        XCTAssertEqual(server.requestCount, 1)
    }

    func testTokenGeneratorIsHexAndLongEnough() {
        let token = BridgeToken.generate()
        XCTAssertEqual(token.count, 48)
        XCTAssertTrue(token.allSatisfy { $0.isHexDigit })
        XCTAssertNotEqual(token, BridgeToken.generate())
    }
}
