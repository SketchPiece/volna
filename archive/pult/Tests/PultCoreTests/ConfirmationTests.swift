import XCTest
@testable import PultCore

@MainActor
final class ConfirmationTests: XCTestCase {
    private final class Clock: @unchecked Sendable { var now = Date(timeIntervalSince1970: 1_000_000) }
    private final class Presses: @unchecked Sendable { var calls: [(String, Bool)] = [] }

    private func center(_ clock: Clock, _ presses: Presses, outcome: ConfirmationOutcome = ConfirmationOutcome(state: .approved, result: "sent", sessionId: "claude:new")) -> ConfirmationCenter {
        ConfirmationCenter(now: { clock.now }) { item, approve in
            presses.calls.append((item.folder, approve))
            return approve ? outcome : ConfirmationOutcome(state: .declined)
        }
    }

    func testApproveRunsTheActionOnceAndKeepsTheResultVisibleForAWhile() async {
        let clock = Clock(), presses = Presses()
        let center = center(clock, presses)
        let item = center.add(.trustFolder, folder: "/p/CallAssistant", prompt: "Прогони тесты")
        XCTAssertEqual(item.id.count, 32)
        XCTAssertEqual(center.visible().map(\.state), [.pending])

        let decided = await center.decide(item.id, approve: true)
        XCTAssertEqual(decided?.state, .approved)
        XCTAssertEqual(decided?.result, "sent")
        XCTAssertEqual(decided?.sessionId, "claude:new")
        XCTAssertEqual(presses.calls.count, 1)

        let again = await center.decide(item.id, approve: false)
        XCTAssertEqual(again?.state, .approved, "an answered decision cannot be answered again")
        XCTAssertEqual(presses.calls.count, 1)

        clock.now += ConfirmationCenter.keepResolved + 1
        XCTAssertTrue(center.visible().isEmpty)
        let unknown = await center.decide("nope", approve: true)
        XCTAssertNil(unknown)
    }

    func testLateTapExpiresAndPressesCancelInstead() async {
        let clock = Clock(), presses = Presses()
        let center = center(clock, presses)
        let item = center.add(.trustFolder, folder: "/p/CallAssistant", prompt: "x")
        clock.now += ConfirmationCenter.lifetime + 1
        let decided = await center.decide(item.id, approve: true)
        XCTAssertEqual(decided?.state, .expired)
        XCTAssertEqual(presses.calls.first?.1, false, "an expired decision closes the dialog with Cancel")
    }

    func testANewRequestForTheSameFolderSupersedesTheOldOne() {
        let center = center(Clock(), Presses())
        let first = center.add(.trustFolder, folder: "/p/A", prompt: "1")
        let second = center.add(.trustFolder, folder: "/p/A", prompt: "2")
        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(center.visible().map(\.state), [.expired, .pending])
    }

    func testRoutesListAndDecideWithTheBridgeToken() async throws {
        let center = center(Clock(), Presses())
        let item = center.add(.trustFolder, folder: "/p/CallAssistant", prompt: "Прогони тесты")
        let router = BridgeRouter(token: "t0k", actions: BridgeActions(
            sessions: { [] }, send: { _, _ in }, open: { _ in },
            confirmations: { center.visible() },
            decide: { id, approve in await center.decide(id, approve: approve) }))

        let unauthorized = await router.handle(BridgeRequest(method: "GET", path: "/confirmations"))
        XCTAssertEqual(unauthorized.status, 401)
        let list = await router.handle(BridgeRequest(method: "GET", path: "/confirmations", authorization: "Bearer t0k"))
        XCTAssertEqual(list.json["confirmations"]?[0]?["kind"]?.string, "trust_folder")
        XCTAssertEqual(list.json["confirmations"]?[0]?["project"]?.string, "CallAssistant")
        XCTAssertEqual(list.json["confirmations"]?[0]?["state"]?.string, "pending")

        let bad = await router.handle(BridgeRequest(method: "POST", path: "/confirmations/\(item.id)", authorization: "Bearer t0k", body: Data("{\"decision\":\"yes\"}".utf8)))
        XCTAssertEqual(bad.status, 400)
        let missing = await router.handle(BridgeRequest(method: "POST", path: "/confirmations/nope", authorization: "Bearer t0k", body: Data("{\"decision\":\"approve\"}".utf8)))
        XCTAssertEqual(missing.status, 404)
        let approved = await router.handle(BridgeRequest(method: "POST", path: "/confirmations/\(item.id)", authorization: "Bearer t0k", body: Data("{\"decision\":\"approve\"}".utf8)))
        XCTAssertEqual(approved.status, 200)
        XCTAssertEqual(approved.json["confirmation"]?["state"]?.string, "approved")
        XCTAssertEqual(approved.json["confirmation"]?["result"]?.string, "sent")
        let twice = await router.handle(BridgeRequest(method: "POST", path: "/confirmations/\(item.id)", authorization: "Bearer t0k", body: Data("{\"decision\":\"decline\"}".utf8)))
        XCTAssertEqual(twice.status, 409)
    }
}
