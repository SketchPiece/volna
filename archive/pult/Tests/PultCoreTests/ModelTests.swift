import XCTest
@testable import PultCore

final class ModelTests: XCTestCase {
    func testCodexThreadTimestampsAreSeconds() throws {
        let value = try JSONValue.parse(#"{"id":"01a0","name":null,"preview":"Собери билд","cwd":"/tmp/x","createdAt":1790000000,"updatedAt":1790073924,"source":"vscode","status":{"type":"notLoaded"},"originator":"Codex Desktop"}"#)
        let thread = try XCTUnwrap(CodexThread(value))
        XCTAssertEqual(Int(thread.updatedAt.timeIntervalSince1970), 1790073924)
        XCTAssertEqual(thread.sourceKind, "vscode")
        XCTAssertEqual(thread.statusKind, "notLoaded")
        XCTAssertEqual(thread.preview, "Собери билд")
        XCTAssertNil(thread.name)
    }

    func testClaudeSessionRecordDesktopLink() throws {
        let value = try JSONValue.parse(#"{"pid":38509,"sessionId":"be1d70b5","cwd":"/p","entrypoint":"claude-desktop","hostSessionId":"local_d7418c83","messagingSocketPath":"/tmp/cc-socks/38509.sock","name":"Инструменты","status":"idle"}"#)
        let record = try XCTUnwrap(ClaudeSessionRecord(value))
        XCTAssertEqual(record.desktopLink?.absoluteString, "claude://claude.ai/epitaxy/local_d7418c83")
        XCTAssertEqual(record.messagingSocketPath, "/tmp/cc-socks/38509.sock")
        var cli = value.object!
        cli["entrypoint"] = "cli"
        XCTAssertNil(ClaudeSessionRecord(.object(cli))?.desktopLink)
    }

    func testClaudeLiveSessionParsesAgentsJSON() throws {
        let value = try JSONValue.parse(#"{"cwd":"/p","kind":"background","startedAt":1699564800000,"id":"7c5dcf5d","state":"blocked","pid":12345,"status":"waiting","waitingFor":"permission prompt","sessionId":"1f0e2c9a","name":"flaky-test-fix"}"#)
        let session = try XCTUnwrap(ClaudeLiveSession(value))
        XCTAssertEqual(session.id, "7c5dcf5d")
        XCTAssertEqual(session.waitingFor, "permission prompt")
        XCTAssertEqual(Int(session.startedAt!.timeIntervalSince1970), 1699564800)
    }

    func testInboxFrameMatchesStreamJSONUserMessage() throws {
        let frame = ClaudeInbox.userFrame(text: "привет", from: "Волна: Пульт")
        XCTAssertEqual(frame["type"]?.string, "user")
        XCTAssertEqual(frame["message"]?["role"]?.string, "user")
        XCTAssertEqual(frame["message"]?["content"]?.string, "привет")
        XCTAssertEqual(frame["from"]?.string, "Волна: Пульт")
    }

    func testHookRequestParsingWaitsForFullBody() {
        let head = "POST /hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 27\r\n\r\n"
        let body = #"{"hook_event_name":"Stop"}"#  // 26 bytes
        XCTAssertNil(ClaudeHookReceiver.parse(Data((head + body).utf8)), "one byte short of Content-Length")
        let parsed = ClaudeHookReceiver.parse(Data((head + body + "\n").utf8))
        XCTAssertEqual(parsed?.path, "/hook")
        XCTAssertEqual(parsed.map { String(decoding: $0.body, as: UTF8.self) }, body + "\n")
    }
}

final class NewSessionLinkTests: XCTestCase {
    func testClaudeLinkCarriesFolderAndPrompt() throws {
        let url = try XCTUnwrap(NewSessionLink.claude(folder: "/Users/me/proj", prompt: "Собери билд"))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(url.scheme, "claude"); XCTAssertEqual(url.host, "code"); XCTAssertEqual(url.path, "/new")
        XCTAssertEqual(components.queryItems?.first { $0.name == "folder" }?.value, "/Users/me/proj")
        XCTAssertEqual(components.queryItems?.first { $0.name == "q" }?.value, "Собери билд")
        XCTAssertNil(URLComponents(url: try XCTUnwrap(NewSessionLink.claude(folder: nil, prompt: "x")), resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "folder" })
    }

    func testCodexLinkCarriesPrompt() throws {
        let url = try XCTUnwrap(NewSessionLink.codex(prompt: "Прогони тесты"))
        XCTAssertEqual(url.scheme, "codex"); XCTAssertEqual(url.host, "threads"); XCTAssertEqual(url.path, "/new")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "prompt" }?.value, "Прогони тесты")
    }
}
