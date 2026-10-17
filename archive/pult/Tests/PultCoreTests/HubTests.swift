import XCTest
@testable import PultCore

final class HubTests: XCTestCase {
    private func claude(_ status: String, state: String? = nil, waitingFor: String? = nil, entry: String = "claude-desktop") throws -> HubSession {
        var object: [String: JSONValue] = ["sessionId": "s1", "name": "Инструменты", "cwd": "/p/CallAssistant", "kind": "interactive", "status": .string(status)]
        if let state { object["state"] = .string(state) }
        if let waitingFor { object["waitingFor"] = .string(waitingFor) }
        let live = try XCTUnwrap(ClaudeLiveSession(.object(object)))
        let record = ClaudeSessionRecord(["pid": 1, "sessionId": "s1", "entrypoint": .string(entry), "hostSessionId": "local_1", "messagingSocketPath": "/tmp/cc-socks/1.sock"])
        return HubSession(claude: live, record: record)
    }

    func testClaudeMapping() throws {
        let waiting = try claude("waiting", waitingFor: "permission prompt")
        XCTAssertEqual(waiting.state, .needsYou)
        XCTAssertEqual(waiting.detail, "permission prompt")
        XCTAssertEqual(waiting.origin, .claudeDesktop)
        XCTAssertEqual(waiting.openURL?.absoluteString, "claude://claude.ai/epitaxy/local_1")
        XCTAssertEqual(waiting.project, "CallAssistant")
        XCTAssertEqual(try claude("busy").state, .working)
        XCTAssertEqual(try claude("idle").state, .idle)
        XCTAssertEqual(try claude("idle", state: "failed").state, .failed)
        XCTAssertEqual(try claude("idle", entry: "cli").origin, .claudeCLI)
    }

    func testModelAndEffortFromProcessArguments() throws {
        let live = try XCTUnwrap(ClaudeLiveSession(["sessionId": "s1", "cwd": "/p", "kind": "interactive", "status": "busy"]))
        let args = "/x/claude --output-format stream-json --effort high --model claude-fable-5-1 --permission-prompt-tool stdio"
        let session = HubSession(claude: live, record: nil, processArguments: args)
        XCTAssertEqual(session.model, "claude-fable-5-1")
        XCTAssertEqual(session.effort, "high")
        XCTAssertEqual(session.modelLabel, "Fable 5.1")
        var s2 = session; s2.model = "claude-opus-5"; XCTAssertEqual(s2.modelLabel, "Opus 5")
        s2.model = "gpt-5.6-terra"; XCTAssertEqual(s2.modelLabel, "GPT 5.6 Terra")
        XCTAssertNil(HubSession.argument("--model", in: "claude --model --effort low"))
    }

    func testCodexMappingUsesRecentActivityWhenNotLoaded() throws {
        let now = Date()
        var object: [String: JSONValue] = ["id": "t1", "preview": "Собери билд\nи тесты", "cwd": "/p/X", "createdAt": .number(now.timeIntervalSince1970 - 600),
                                           "updatedAt": .number(now.timeIntervalSince1970 - 30), "source": "vscode", "status": ["type": "notLoaded"], "originator": "Codex Desktop"]
        let recent = HubSession(codex: try XCTUnwrap(CodexThread(.object(object))), now: now)
        XCTAssertEqual(recent.state, .working)
        XCTAssertEqual(recent.origin, .codexApp)
        XCTAssertEqual(recent.name, "Собери билд и тесты")
        XCTAssertEqual(recent.openURL?.absoluteString, "codex://threads/t1")
        object["updatedAt"] = .number(now.timeIntervalSince1970 - 3600)
        XCTAssertEqual(HubSession(codex: try XCTUnwrap(CodexThread(.object(object))), now: now).state, .off)
        object["status"] = ["type": "active", "activeFlags": []]
        XCTAssertEqual(HubSession(codex: try XCTUnwrap(CodexThread(.object(object))), now: now).state, .working)
    }

    func testChangesOnlyOnTransitions() throws {
        let working = try claude("busy")
        let waiting = try claude("waiting", waitingFor: "permission prompt")
        let idle = try claude("idle")
        XCTAssertEqual(HubChange.compute(from: [working], to: [waiting]), [.needsYou(waiting)])
        XCTAssertEqual(HubChange.compute(from: [working], to: [idle]), [.finished(idle)])
        XCTAssertEqual(HubChange.compute(from: [idle], to: [idle]), [])
        XCTAssertEqual(HubChange.compute(from: [], to: [waiting]), [], "a session seen for the first time is not a transition")
        XCTAssertEqual(HubChange.compute(from: [idle], to: [working]), [])
    }

    func testHooksInstallAndUninstallPreserveOtherHooks() throws {
        let original: JSONValue = ["theme": "dark", "hooks": ["Stop": [["hooks": [["type": "command", "command": "say done"]]]]]]
        let installed = ClaudeHooksInstaller.install(port: 48611, into: original)
        XCTAssertTrue(ClaudeHooksInstaller.isInstalled(in: installed, port: 48611))
        XCTAssertFalse(ClaudeHooksInstaller.isInstalled(in: installed, port: 1))
        XCTAssertEqual(installed["hooks"]?["Stop"]?.array?.count, 2)
        XCTAssertEqual(installed["hooks"]?["Notification"]?[0]?["hooks"]?[0]?["url"]?.string, "http://127.0.0.1:48611/pult/hook")
        XCTAssertEqual(installed["theme"]?.string, "dark")
        let again = ClaudeHooksInstaller.install(port: 48612, into: installed)
        XCTAssertEqual(again["hooks"]?["Stop"]?.array?.count, 2, "reinstall replaces instead of stacking")
        let removed = ClaudeHooksInstaller.uninstall(from: again)
        XCTAssertEqual(removed, original)
    }
}
