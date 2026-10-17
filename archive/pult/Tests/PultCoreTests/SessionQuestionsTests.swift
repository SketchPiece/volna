import XCTest
@testable import PultCore

@MainActor
final class SessionQuestionsTests: XCTestCase {
    private func payload(id: String = "toolu_1", questions: [JSONValue]? = nil) -> JSONValue {
        let one: JSONValue = ["question": "Какой цвет?", "header": "Цвет", "multiSelect": false,
                              "options": [["label": "Красный", "description": "красный"], ["label": "Зелёный", "description": "зелёный"]]]
        return ["hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_use_id": .string(id), "session_id": "abc",
                "cwd": "/p/CallAssistant/.claude/worktrees/bridge-cse_1", "tool_input": ["questions": .array(questions ?? [one])]]
    }

    func testParsesTheHookBodyAndFillsAnswersIntoTheCall() throws {
        var question = try XCTUnwrap(SessionQuestion(hook: payload(), wait: 60))
        XCTAssertEqual(question.project, "CallAssistant", "a worktree belongs to the repo above it")
        XCTAssertEqual(question.items.first?.options.map(\.label), ["Красный", "Зелёный"])
        question.answers = ["Какой цвет?": "Зелёный"]
        let out = question.hookOutput["hookSpecificOutput"]
        XCTAssertEqual(out?["permissionDecision"]?.string, "allow")
        XCTAssertEqual(out?["updatedInput"]?["answers"]?["Какой цвет?"]?.string, "Зелёный")
        XCTAssertEqual(out?["updatedInput"]?["questions"]?[0]?["header"]?.string, "Цвет", "the original input stays")
        var other = payload()
        if case .object(var o) = other { o["tool_name"] = "Bash"; other = .object(o) }
        XCTAssertNil(SessionQuestion(hook: other, wait: 60))
    }

    func testWithoutALiveCallTheQuestionGoesStraightToTheSession() async {
        let desk = QuestionDesk()
        let output = await desk.ask(payload())
        XCTAssertNil(output)
        XCTAssertTrue(desk.questions.isEmpty)
    }

    func testHeldQuestionIsAnsweredByVolna() async throws {
        let desk = QuestionDesk(tick: .milliseconds(10))
        desk.heardListener()
        let waiting = Task { await desk.ask(payload()) }
        while desk.questions.isEmpty { await Task.yield() }
        XCTAssertEqual(desk.visible().first?.state, .pending)
        XCTAssertEqual(desk.answer("toolu_1", answers: ["Чужой вопрос": "x"]), .failure(.mismatch("no such question: Чужой вопрос")))
        guard case .success(let answered) = desk.answer("toolu_1", single: " Зелёный ") else { return XCTFail("answer refused") }
        XCTAssertEqual(answered.answers, ["Какой цвет?": "Зелёный"])
        let output = await waiting.value
        XCTAssertEqual(output?["hookSpecificOutput"]?["updatedInput"]?["answers"]?["Какой цвет?"]?.string, "Зелёный")
        XCTAssertEqual(desk.answer("toolu_1", single: "Красный"), .failure(.notPending(.answered)))
    }

    func testCallEndOrPassHandsTheQuestionBack() async {
        let desk = QuestionDesk(listenerWindow: 0.05, tick: .milliseconds(10))
        desk.heardListener()
        let output = await desk.ask(payload(id: "toolu_2"))
        XCTAssertNil(output, "no poll within the window: the call is over")
        XCTAssertEqual(desk.questions.first?.state, .passed)

        let desk2 = QuestionDesk(tick: .milliseconds(10))
        desk2.heardListener()
        let waiting = Task { await desk2.ask(payload(id: "toolu_3")) }
        while desk2.questions.isEmpty { await Task.yield() }
        XCTAssertNotNil(try? desk2.pass("toolu_3").get())
        let passed = await waiting.value
        XCTAssertNil(passed)

        let desk3 = QuestionDesk(wait: 0.05, tick: .milliseconds(10))
        desk3.heardListener()
        let expired = await desk3.ask(payload(id: "toolu_4"))
        XCTAssertNil(expired)
        XCTAssertEqual(desk3.questions.first?.state, .expired)
    }

    func testSeveralQuestionsNeedAnAnswerEach() async {
        let q2: JSONValue = ["question": "Какой размер?", "options": [["label": "S"], ["label": "M"]]]
        let q1: JSONValue = ["question": "Какой цвет?", "options": [["label": "Красный"]]]
        let desk = QuestionDesk(tick: .milliseconds(10))
        desk.heardListener()
        let waiting = Task { await desk.ask(payload(id: "toolu_5", questions: [q1, q2])) }
        while desk.questions.isEmpty { await Task.yield() }
        XCTAssertEqual(desk.answer("toolu_5", single: "S"), .failure(.mismatch("this call has 2 questions; answer each by its text")))
        XCTAssertEqual(desk.answer("toolu_5", answers: ["Какой цвет?": "Красный"]), .failure(.mismatch("no answer for: Какой размер?")))
        XCTAssertNotNil(try? desk.answer("toolu_5", answers: ["Какой цвет?": "Красный", "Какой размер?": "M"]).get())
        let output = await waiting.value
        XCTAssertEqual(output?["hookSpecificOutput"]?["updatedInput"]?["answers"]?["Какой размер?"]?.string, "M")
    }

    func testRoutesListenAnswerAndPass() async throws {
        let desk = QuestionDesk(tick: .milliseconds(10))
        let session = HubSession(id: "claude:abc", agent: .claude, origin: .claudeDesktop, state: .needsYou, name: "Тест цвета",
                                 cwd: "/p/CallAssistant", detail: nil, updatedAt: nil, openURL: nil, inboxSocket: nil)
        let router = BridgeRouter(token: "t", actions: BridgeActions(
            sessions: { [session] }, send: { _, _ in }, open: { _ in },
            questions: { desk.visible() }, listen: { desk.heardListener() },
            answerQuestion: { id, answers, single in desk.answer(id, answers: answers, single: single) },
            passQuestion: { id in desk.pass(id) }))
        func call(_ method: String, _ path: String, _ body: JSONValue? = nil) async throws -> BridgeResponse {
            await router.handle(BridgeRequest(method: method, path: path, authorization: "Bearer t", body: Data(try (body ?? [:]).serialized().utf8)))
        }
        XCTAssertFalse(desk.isListening())
        _ = try await call("GET", "/questions")
        XCTAssertFalse(desk.isListening(), "a plain read does not claim a live call")
        _ = try await call("GET", "/questions?listen=1")
        XCTAssertTrue(desk.isListening())
        let waiting = Task { await desk.ask(payload(id: "toolu_6")) }
        while desk.questions.isEmpty { await Task.yield() }
        let list = try await call("GET", "/questions?listen=1")
        XCTAssertEqual(list.json["questions"]?[0]?["session"]?.string, "Тест цвета")
        XCTAssertEqual(list.json["questions"]?[0]?["questions"]?[0]?["options"]?[1]?["label"]?.string, "Зелёный")
        let bad = try await call("POST", "/questions/toolu_6", ["nope": true])
        XCTAssertEqual(bad.status, 400)
        let ok = try await call("POST", "/questions/toolu_6", ["answer": "Красный"])
        XCTAssertEqual(ok.json["question"]?["state"]?.string, "answered")
        _ = await waiting.value
        let again = try await call("POST", "/questions/toolu_6", ["pass": true])
        XCTAssertEqual(again.status, 409)
        let missing = try await call("POST", "/questions/nope", ["pass": true])
        XCTAssertEqual(missing.status, 404)
    }

    func testInstallerAddsTheQuestionHookAndRemovesIt() {
        let other: JSONValue = ["hooks": ["PreToolUse": [["matcher": "Bash", "hooks": [["type": "command", "command": "x"]]]]]]
        let installed = ClaudeHooksInstaller.install(port: 48611, into: other)
        let pre = installed["hooks"]?["PreToolUse"]?.array ?? []
        XCTAssertEqual(pre.count, 2)
        XCTAssertEqual(pre[1]["matcher"]?.string, "AskUserQuestion")
        XCTAssertEqual(pre[1]["hooks"]?[0]?["url"]?.string, "http://127.0.0.1:48611/pult/ask")
        XCTAssertFalse(ClaudeHooksInstaller.lacksAskHook(in: installed))
        let removed = ClaudeHooksInstaller.uninstall(from: installed)
        XCTAssertEqual(removed["hooks"]?["PreToolUse"]?.array?.count, 1, "the user's own hook stays")
        XCTAssertNil(removed["hooks"]?["Stop"])
        let old: JSONValue = ["hooks": ["Stop": [["hooks": [["type": "http", "url": "http://127.0.0.1:48611/pult/hook"]]]]]]
        XCTAssertTrue(ClaudeHooksInstaller.lacksAskHook(in: old))
        XCTAssertFalse(ClaudeHooksInstaller.lacksAskHook(in: other), "hooks that are off stay off")
    }
}
