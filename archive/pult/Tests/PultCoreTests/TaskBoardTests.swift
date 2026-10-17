import XCTest
@testable import PultCore

/// An app-server that answers the job's calls and lets the test speak for the server afterwards.
final class FakeCodexTransport: CodexTransport, @unchecked Sendable {
    let lines: AsyncStream<String>
    private let continuation: AsyncStream<String>.Continuation
    private(set) var sent: [JSONValue] = []

    init() {
        var continuation: AsyncStream<String>.Continuation!
        lines = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func open() async throws {}
    func close() { continuation.finish() }
    func push(_ message: JSONValue) { continuation.yield(try! message.serialized()) }

    func send(line: String) throws {
        let message = try JSONValue.parse(line)
        sent.append(message)
        guard let id = message["id"], let method = message["method"]?.string else { return }
        let result: JSONValue = switch method {
        case "thread/start": ["thread": ["id": "t1"]]
        case "turn/start": ["turn": ["id": "u1"]]
        default: [:]
        }
        push(["id": id, "result": result])
    }
}

@MainActor
final class TaskBoardTests: XCTestCase {
    private let calculatorRequest: JSONValue = [
        "threadId": "t1", "serverName": "cua_repl", "message": "Allow Computer Use to use \"Calculator\"?",
        "_meta": ["connector_id": "computer-use", "tool_params_display": [["name": "app", "value": "Calculator"]]]
    ]

    private func settle() async { for _ in 0..<20 { await Task.yield(); try? await Task.sleep(for: .milliseconds(5)) } }

    func testAnAppRequestAnsweredInTheCodexAppIsWithdrawnEverywhereElse() async throws {
        let transport = FakeCodexTransport()
        var asked: [String] = []
        var withdrawn: [String] = []
        var answer: CheckedContinuation<Bool, Never>?
        let jobs = ComputerJobs(workdir: FileManager.default.temporaryDirectory,
                                makeClient: { CodexClient(transport: transport) },
                                withdraw: { job in withdrawn.append(job.id); answer?.resume(returning: false); answer = nil },
                                ask: { _, app in asked.append(app); return await withCheckedContinuation { answer = $0 } })
        let job = try await jobs.start(task: "Посчитай 12 × 7", ref: "b1")
        XCTAssertEqual(job.ref, "b1")
        XCTAssertEqual(jobs.job(job.id)?.openURL?.absoluteString, "codex://threads/t1")

        transport.push(["id": 99, "method": "mcpServer/elicitation/request", "params": calculatorRequest])
        await settle()
        XCTAssertEqual(asked, ["Calculator"])
        XCTAssertEqual(jobs.job(job.id)?.state, .needsYou)

        transport.push(["method": "serverRequest/resolved", "params": ["threadId": "t1", "requestId": 99]])
        await settle()
        XCTAssertEqual(withdrawn, [job.id], "the phone card and the panel buttons go away")
        let after = try XCTUnwrap(jobs.job(job.id))
        XCTAssertEqual(after.state, .working)
        XCTAssertEqual(after.declinedApps, [], "the owner's answer in Codex is unknown, not a refusal")
        XCTAssertEqual(after.allowedApps, [])

        transport.push(["method": "serverRequest/resolved", "params": ["threadId": "t1", "requestId": 100]])
        await settle()
        XCTAssertEqual(withdrawn.count, 1, "a resolution of some other request changes nothing")
    }

    func testAnAppRequestAnsweredInPultIsNotWithdrawn() async throws {
        let transport = FakeCodexTransport()
        var withdrawn = 0
        let jobs = ComputerJobs(workdir: FileManager.default.temporaryDirectory, makeClient: { CodexClient(transport: transport) },
                                withdraw: { _ in withdrawn += 1 }, ask: { _, _ in true })
        let job = try await jobs.start(task: "x")
        transport.push(["id": 7, "method": "mcpServer/elicitation/request", "params": calculatorRequest])
        await settle()
        transport.push(["method": "serverRequest/resolved", "params": ["threadId": "t1", "requestId": 7]])
        await settle()
        XCTAssertEqual(withdrawn, 0, "our own answer comes back as resolved too")
        XCTAssertEqual(jobs.job(job.id)?.allowedApps, ["Calculator"])
        let reply = transport.sent.first { $0["id"] == 7 }
        XCTAssertEqual(reply?["result"]?["action"]?.string, "accept")
    }

    func testRowsJoinAstraJobsWithTheBridgesTasks() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var working = ComputerJob(id: "j1", task: "Найди счёт в Почте", createdAt: t0, ref: "b1")
        working.state = .working
        working.threadId = "t1"
        var waiting = ComputerJob(id: "j2", task: "Скриншоты", createdAt: t0.addingTimeInterval(5))
        waiting.state = .needsYou
        waiting.pendingApp = "Preview"
        var done = ComputerJob(id: "j3", task: "Заметки", createdAt: t0)
        done.state = .done
        done.reply = "Список нашёлся в заметке. Восемь пунктов."
        done.finishedAt = t0.addingTimeInterval(60)
        let tasks = [
            BackgroundTask(id: "b1", title: "Счёт за сентябрь", kind: .computer, status: .running, progress: "Открыта папка «Счета».", createdAt: t0),
            BackgroundTask(id: "b2", title: "Отели в Лиссабоне", kind: .think, status: .running, progress: "Сравниваются районы.", createdAt: t0),
            BackgroundTask(id: "b3", title: "План поездки", kind: .think, status: .failed, error: "TimeoutError", createdAt: t0, finishedAt: t0.addingTimeInterval(30)),
            BackgroundTask(id: "b4", title: "Потерянная работа на Mac", kind: .computer, status: .running, createdAt: t0)
        ]
        let center = ConfirmationCenter { _, _ in ConfirmationOutcome(state: .approved) }
        let card = center.add(.computerApp, folder: "", prompt: "Скриншоты", app: "Preview")
        let rows = TaskBoard.rows(jobs: [working, waiting, done], tasks: tasks, confirmations: center.visible())

        XCTAssertEqual(rows.map(\.state), [.needsYou, .working, .working, .working, .done, .failed])
        XCTAssertEqual(rows[0].line, "ждёт разрешения: Preview")
        XCTAssertEqual(rows[0].confirmationId, card.id, "the panel answers the same confirmation the phone shows")
        let mail = rows.first { $0.id == "job:j1" }
        XCTAssertEqual(mail?.title, "Счёт за сентябрь", "the bridge's title wins over the raw task")
        XCTAssertEqual(mail?.line, "Открыта папка «Счета».")
        XCTAssertEqual(mail?.openURL?.absoluteString, "codex://threads/t1")
        XCTAssertNil(rows.first { $0.id == "task:b1" }, "the bridge's side of a known job is not shown twice")
        XCTAssertNotNil(rows.first { $0.id == "task:b4" }, "a job Pult lost still shows from the bridge")
        XCTAssertEqual(rows.first { $0.id == "task:b2" }?.line, "Сравниваются районы.")
        XCTAssertNil(rows.first { $0.id == "task:b2" }?.openURL)
        XCTAssertEqual(rows.first { $0.id == "job:j3" }?.line, "Список нашёлся в заметке.")
        XCTAssertEqual(rows.last?.line, "Не получилось: TimeoutError.")
    }

    func testBridgeTaskSnapshotsAndTheirRoute() async throws {
        final class Box: @unchecked Sendable { var tasks: [BackgroundTask] = []; var refs: [String?] = [] }
        let box = Box()
        let router = BridgeRouter(token: "t0k", actions: BridgeActions(
            sessions: { [] }, send: { _, _ in }, open: { _ in },
            computerStart: { text, ref in box.refs.append(ref); return ComputerJob(id: "j", task: text, createdAt: Date(), ref: ref) },
            taskReport: { box.tasks.append($0) }))
        func call(_ method: String, _ path: String, _ body: JSONValue) async throws -> BridgeResponse {
            await router.handle(BridgeRequest(method: method, path: path, authorization: "Bearer t0k", body: Data(try body.serialized().utf8)))
        }
        let put = try await call("PUT", "/tasks/b2", ["title": "Отели", "kind": "think", "status": "running", "progress": "Идёт поиск.",
                                                      "createdAt": "2026-09-23T10:00:00.123Z", "finishedAt": .null])
        XCTAssertEqual(put.status, 200)
        XCTAssertEqual(box.tasks.first?.progress, "Идёт поиск.")
        XCTAssertEqual(box.tasks.first?.createdAt.timeIntervalSince1970 ?? 0, 1_790_157_600.123, accuracy: 0.001, "the bridge's toISOString has milliseconds")
        let bad = try await call("PUT", "/tasks/b3", ["status": "running"])
        XCTAssertEqual(bad.status, 400)
        let started = try await call("POST", "/computer", ["text": "Открой Калькулятор", "ref": "b9"])
        XCTAssertEqual(box.refs, ["b9"])
        XCTAssertEqual(started.json["job"]?["ref"]?.string, "b9")

        let store = BackgroundTasks()
        for i in 0..<14 {
            store.upsert(BackgroundTask(id: "d\(i)", title: "x", kind: .think, status: .done, createdAt: Date(), finishedAt: Date(timeIntervalSince1970: Double(i))))
        }
        store.upsert(BackgroundTask(id: "r", title: "y", kind: .think, status: .running, createdAt: Date()))
        XCTAssertEqual(store.items.count, BackgroundTasks.keep + 1, "finished tasks beyond the last ten go away; running ones stay")
        XCTAssertFalse(store.items.contains { $0.id == "d0" })
    }

    func testCodexAppLinkIsReadFromLsof() {
        XCTAssertTrue(CodexHost.appConnected(lsof: "p65041\nccodex\np67380\ncChatGPT\n"))
        XCTAssertFalse(CodexHost.appConnected(lsof: "p65041\nccodex\np41176\ncPult\n"), "Pult's own connection does not count")
        XCTAssertEqual(CodexHost.serverArguments(port: 48613).suffix(2), ["--listen", "ws://127.0.0.1:48613"])
    }
}
