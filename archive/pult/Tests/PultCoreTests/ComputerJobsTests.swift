import XCTest
@testable import PultCore

@MainActor
final class ComputerJobsTests: XCTestCase {
    /// The request as Codex 0.155.1 sent it on 22.09.2026 (docs/mac-agent-hub.md, 2.3), trimmed.
    private let finderRequest: JSONValue = [
        "threadId": "t1", "serverName": "node_repl", "mode": "form",
        "message": "Allow Computer Use to use \"Finder\"?",
        "_meta": [
            "codex_approval_kind": "mcp_tool_call", "connector_id": "computer-use", "connector_name": "Computer Use",
            "persist": ["session", "always"], "riskLevel": "low", "tool_name": "get_app_state",
            "tool_params": ["app": "com.apple.finder"],
            "tool_params_display": [["display_name": "App", "name": "app", "value": "Finder"]]
        ],
        "requestedSchema": ["type": "object", "properties": [:]]
    ]

    func testAppRequestIsReadFromTheDisplayedParams() {
        XCTAssertEqual(ComputerAppRequest.app(in: finderRequest), "Finder")
        let bare: JSONValue = ["message": "Allow Computer Use to use \"Notes\"?", "_meta": ["connector_id": "computer-use"]]
        XCTAssertEqual(ComputerAppRequest.app(in: bare), "Notes", "falls back to the quoted name in the message")
        let other: JSONValue = ["message": "Allow \"x\"?", "_meta": ["connector_id": "gmail"]]
        XCTAssertNil(ComputerAppRequest.app(in: other), "other connectors are not app requests")
    }

    func testElicitationAnswersNeverRememberForever() {
        XCTAssertEqual(CodexClient.elicitationResponse(.acceptForSession)["_meta"]?["persist"]?.string, "session")
        XCTAssertEqual(CodexClient.elicitationResponse(.acceptForSession)["action"]?.string, "accept")
        XCTAssertNil(CodexClient.elicitationResponse(.accept)["_meta"])
        XCTAssertEqual(CodexClient.elicitationResponse(.decline)["action"]?.string, "decline")
        for decision in [CodexApprovalDecision.accept, .acceptForSession, .decline, .cancel] {
            XCTAssertNotEqual(CodexClient.elicitationResponse(decision)["_meta"]?["persist"]?.string, "always")
        }
    }

    func testJobTakesTheFinalAnswerAndEnds() {
        let start = Date(timeIntervalSince1970: 0)
        var job = ComputerJob(id: "j", task: "Открой Заметки", createdAt: start)
        job.threadId = "t1"
        job = job.applying(.turnStarted(threadId: "t1", turnId: "u1"), now: start)
        XCTAssertEqual(job.state, .working)
        job = job.applying(.itemCompleted(threadId: "t1", turnId: "u1", item: ["type": "agentMessage", "text": "Смотрю.", "phase": "commentary"]), now: start)
        job = job.applying(.itemCompleted(threadId: "t1", turnId: "u1", item: ["type": "agentMessage", "text": " Заметки открыты. ", "phase": "final_answer"]), now: start)
        job = job.applying(.itemCompleted(threadId: "t1", turnId: "u1", item: ["type": "agentMessage", "text": "PS", "phase": "commentary"]), now: start)
        job = job.applying(.turnCompleted(threadId: "t1", turnId: "u1", status: "completed", errorMessage: nil), now: start.addingTimeInterval(5))
        XCTAssertEqual(job.state, .done)
        XCTAssertEqual(job.reply, "Заметки открыты.")
        XCTAssertEqual(job.finishedAt, start.addingTimeInterval(5))
        let late = job.applying(.turnCompleted(threadId: "t1", turnId: "u2", status: "failed", errorMessage: "x"), now: start)
        XCTAssertEqual(late, job, "a finished job does not change")
    }

    func testJobKeepsAnActivityTrailForProgress() {
        var job = ComputerJob(id: "j", task: "x", createdAt: Date())
        job = job.applying(.itemCompleted(threadId: "t", turnId: "u", item: ["type": "reasoning", "summary": ["Нужно открыть Finder"]]), now: Date())
        job = job.applying(.itemCompleted(threadId: "t", turnId: "u", item: ["type": "mcpToolCall", "server": "node_repl", "tool": "js"]), now: Date())
        job = job.applying(.itemCompleted(threadId: "t", turnId: "u", item: ["type": "agentMessage", "text": "Открываю\nFinder.", "phase": "commentary"]), now: Date())
        job = job.applying(.itemCompleted(threadId: "t", turnId: "u", item: ["type": "agentMessage", "text": "Готово.", "phase": "final_answer"]), now: Date())
        job = job.applying(.itemCompleted(threadId: "t", turnId: "u", item: ["type": "userMessage"]), now: Date())
        XCTAssertEqual(job.activity, ["размышляет: Нужно открыть Finder", "действие: node_repl.js", "Открываю Finder."])
        XCTAssertEqual(job.activityTotal, 3, "the final answer is the reply, not a step")
        for i in 0..<40 { job.note("шаг \(i)") }
        XCTAssertEqual(job.activity.count, ComputerJob.activityKeep)
        XCTAssertEqual(job.activity.last, "шаг 39")
        XCTAssertEqual(job.activityTotal, 43)
        XCTAssertEqual(BridgeRouter.json(job)["activityTotal"], JSONValue.number(43))
    }

    func testFailedAndInterruptedTurns() {
        let job = ComputerJob(id: "j", task: "x", createdAt: Date())
        let failed = job.applying(.turnCompleted(threadId: "t", turnId: "u", status: "failed", errorMessage: "rate limit"), now: Date())
        XCTAssertEqual(failed.state, .failed)
        XCTAssertEqual(failed.error, "turn_failed")
        XCTAssertEqual(failed.reply, "rate limit")
        XCTAssertEqual(job.applying(.turnCompleted(threadId: "t", turnId: "u", status: "interrupted", errorMessage: nil), now: Date()).state, .cancelled)
    }

    func testPromptPutsTheRulesBeforeTheTask() {
        let prompt = ComputerJob.prompt(for: "Сделай скриншот календаря")
        XCTAssertTrue(prompt.hasSuffix("Задание: Сделай скриншот календаря"))
        XCTAssertTrue(prompt.contains("пароли"))
    }

    func testAppRequestsDoNotSupersedeEachOther() {
        let center = ConfirmationCenter { _, approve in ConfirmationOutcome(state: approve ? .approved : .declined) }
        let a = center.add(.computerApp, folder: "", prompt: "x", app: "Finder")
        let b = center.add(.computerApp, folder: "", prompt: "x", app: "Notes")
        let trust = center.add(.trustFolder, folder: "", prompt: "y")
        XCTAssertEqual(center.visible().filter { $0.state == .pending }.map(\.id), [a.id, b.id, trust.id])
        XCTAssertEqual(BridgeRouter.json(a)["app"]?.string, "Finder")
        XCTAssertEqual(BridgeRouter.json(a)["kind"]?.string, "computer_app")
    }

    func testComputerRoutes() async throws {
        final class Box: @unchecked Sendable { var started: [String] = []; var cancelled: [String] = [] }
        let box = Box()
        var job = ComputerJob(id: "j1", task: "Открой Заметки", createdAt: Date(timeIntervalSince1970: 0))
        job.state = .needsYou
        job.pendingApp = "Notes"
        let snapshot = job
        let router = BridgeRouter(token: "t0k", actions: BridgeActions(
            sessions: { [] }, send: { _, _ in }, open: { _ in },
            computerStart: { text, _ in box.started.append(text); return snapshot },
            computerJobs: { [snapshot] },
            computerCancel: { id in box.cancelled.append(id); return id == "j1" ? snapshot : nil }))
        func call(_ method: String, _ path: String, _ body: JSONValue? = nil, token: String = "t0k") async throws -> BridgeResponse {
            await router.handle(BridgeRequest(method: method, path: path, authorization: "Bearer \(token)",
                                              body: try body.map { Data(try $0.serialized().utf8) } ?? Data()))
        }
        let started = try await call("POST", "/computer", ["text": " Открой Заметки "])
        XCTAssertEqual(started.status, 200)
        XCTAssertEqual(box.started, ["Открой Заметки"])
        XCTAssertEqual(started.json["job"]?["state"]?.string, "needs_you")
        XCTAssertEqual(started.json["job"]?["pendingApp"]?.string, "Notes")
        let empty = try await call("POST", "/computer", ["text": "  "])
        let list = try await call("GET", "/computer")
        let one = try await call("GET", "/computer/j1")
        let missing = try await call("GET", "/computer/nope")
        let cancel = try await call("POST", "/computer/j1/cancel")
        let cancelMissing = try await call("POST", "/computer/nope/cancel")
        let unauthorized = try await call("GET", "/computer", token: "bad")
        XCTAssertEqual(empty.status, 400)
        XCTAssertEqual(list.json["jobs"]?.array?.count, 1)
        XCTAssertEqual(one.json["job"]?["id"]?.string, "j1")
        XCTAssertEqual(missing.status, 404)
        XCTAssertEqual(cancel.status, 200)
        XCTAssertEqual(cancelMissing.status, 404)
        XCTAssertEqual(box.cancelled, ["j1", "nope"])
        XCTAssertEqual(unauthorized.status, 401)
    }
}
