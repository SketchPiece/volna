import XCTest
@testable import PultCore

/// Drives the client with a scripted transport: no process, no sockets.
final class JSONRPCClientTests: XCTestCase {
    final class Wire: @unchecked Sendable {
        var sent: [JSONValue] = []
        func record(_ line: String) throws { sent.append(try JSONValue.parse(line)) }
    }

    func testRequestResolvesWithResult() async throws {
        let wire = Wire()
        let client = JSONRPCClient { try wire.record($0) }
        async let result = client.request("thread/list", params: ["limit": 3])
        try await Task.sleep(nanoseconds: 50_000_000)
        let request = wire.sent.first
        XCTAssertEqual(request?["method"]?.string, "thread/list")
        XCTAssertEqual(request?["params"]?["limit"]?.int, 3)
        XCTAssertNil(request?["jsonrpc"], "Codex wire omits the version header")
        let id = request?["id"]?.int ?? -1
        await client.receive(line: #"{"id":\#(id),"result":{"data":[]}}"#)
        let value = try await result
        XCTAssertEqual(value["data"]?.array?.count, 0)
    }

    func testErrorResponseThrows() async throws {
        let wire = Wire()
        let client = JSONRPCClient { try wire.record($0) }
        async let result = client.request("turn/start")
        try await Task.sleep(nanoseconds: 50_000_000)
        let id = wire.sent.first?["id"]?.int ?? -1
        await client.receive(line: #"{"id":\#(id),"error":{"code":-32001,"message":"Server overloaded; retry later."}}"#)
        do { _ = try await result; XCTFail("expected error") } catch let error as JSONRPCError {
            XCTAssertEqual(error.code, -32001)
        }
    }

    func testNotificationsAndServerRequests() async throws {
        let wire = Wire()
        let client = JSONRPCClient { try wire.record($0) }
        await client.setServerRequestHandler { request in
            XCTAssertEqual(request.method, "item/commandExecution/requestApproval")
            return .success(["decision": "decline"])
        }
        await client.receive(line: #"{"method":"turn/started","params":{"turn":{"id":"turn_1"}}}"#)
        await client.receive(line: #"{"id":"srv-1","method":"item/commandExecution/requestApproval","params":{"command":"rm -rf /"}}"#)
        var iterator = client.notifications.makeAsyncIterator()
        let notification = await iterator.next()
        XCTAssertEqual(notification?.method, "turn/started")
        XCTAssertEqual(notification?.params["turn"]?["id"]?.string, "turn_1")
        try await Task.sleep(nanoseconds: 50_000_000)
        let response = wire.sent.first { $0["id"]?.string == "srv-1" }
        XCTAssertEqual(response?["result"]?["decision"]?.string, "decline")
    }

    func testCloseFailsPendingRequests() async throws {
        let client = JSONRPCClient { _ in }
        async let result = client.request("model/list")
        try await Task.sleep(nanoseconds: 20_000_000)
        await client.close(error: CodexError.serverExited)
        do { _ = try await result; XCTFail("expected failure") } catch { XCTAssertTrue(error is CodexError) }
    }
}
