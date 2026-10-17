import Foundation
import PultCore

// Stage-0 probe: exercises each protocol brick from the terminal.
// Usage:
//   pult-probe codex list [--all] [--limit N]
//   pult-probe codex turn <cwd> "<text>" [--accept]
//   pult-probe codex read <threadId>
//   pult-probe claude hooks <on|off> [port]   hooks of Пульт in ~/.claude/settings.json, same as the settings toggle

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func formatDate(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "dd.MM HH:mm"
    return formatter.string(from: date)
}

extension JSONValue { var serializedOrEmpty: String { (try? serialized()) ?? "" } }
@MainActor enum ProbeHolder { static let hub = AgentHub() }

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2 else { fail("usage: pult-probe <codex|claude> <command> ...") }

Task {
    do {
        switch (arguments[0], arguments[1]) {
        case ("claude", "hooks"):
            guard arguments.count >= 3, ["on", "off"].contains(arguments[2]) else { fail("usage: pult-probe claude hooks <on|off> [port]") }
            let port = arguments.count >= 4 ? UInt16(arguments[3]) ?? 48611 : 48611
            try ClaudeHooksInstaller.apply(installed: arguments[2] == "on", port: port)
            print(arguments[2] == "on" ? "hooks on, port \(port), ask hook \(ClaudeHooksInstaller.askURL(port: port))" : "hooks off")
        case ("codex", "list"):
            let client = CodexClient()
            try await client.start()
            let all = arguments.contains("--all")
            let limit = arguments.firstIndex(of: "--limit").flatMap { Int(arguments[$0 + 1]) } ?? 10
            let kinds: [String]? = all ? ["cli", "vscode", "exec", "appServer", "subAgent", "unknown"] : nil
            let (threads, next) = try await client.listThreads(limit: limit, sourceKinds: kinds)
            for thread in threads {
                let title = thread.name ?? String(thread.preview.replacingOccurrences(of: "\n", with: " ").prefix(60))
                print("\(formatDate(thread.updatedAt))  \(thread.sourceKind.padding(toLength: 9, withPad: " ", startingAt: 0)) \(thread.statusKind.padding(toLength: 9, withPad: " ", startingAt: 0)) \(thread.id)  \(title)  [\(thread.cwd)]")
            }
            print("next cursor: \(next ?? "-")")
            client.stop()
        case ("codex", "read"):
            guard arguments.count >= 3 else { fail("usage: pult-probe codex read <threadId>") }
            let client = CodexClient()
            try await client.start()
            let thread = try await client.readThread(id: arguments[2])
            print(thread.pretty().prefix(4000))
            client.stop()
        case ("codex", "turn"):
            guard arguments.count >= 4 else { fail("usage: pult-probe codex turn <cwd> \"<text>\" [--accept]") }
            let accept = arguments.contains("--accept")
            let client = CodexClient()
            client.setApprovalHandler { request in
                print("\n[approval] \(request.method) \(request.kind) → \(accept ? "accept" : "decline")")
                return accept ? .accept : .decline
            }
            try await client.start()
            print("server: \(client.serverInfo.pretty())")
            let thread = try await client.startThread(cwd: arguments[2])
            print("thread \(thread.id) in \(thread.cwd)")
            let turnId = try await client.startTurn(threadId: thread.id, text: arguments[3])
            print("turn \(turnId)")
            for await event in client.events {
                switch event {
                case .agentMessageDelta(_, _, _, let delta): print(delta, terminator: ""); fflush(stdout)
                case .reasoningDelta: break
                case .itemStarted(_, _, let item): print("\n[item started] \(item["type"]?.string ?? "?") \(item["command"]?.string ?? "")")
                case .itemCompleted(_, _, let item): print("\n[item completed] \(item["type"]?.string ?? "?")")
                case .turnCompleted(_, _, let status, let error):
                    print("\n[turn completed] \(status) \(error ?? "")")
                    client.stop()
                case .other(let method, _): print("\n[\(method)]")
                default: break
                }
            }
        case ("claude", "agents"):
            let sessions = try await ClaudeSessions.live(includeCompleted: arguments.contains("--all"))
            let records = Dictionary(uniqueKeysWithValues: ClaudeSessions.records().map { ($0.sessionId, $0) })
            for session in sessions {
                let record = records[session.sessionId]
                print("\(session.status.padding(toLength: 8, withPad: " ", startingAt: 0)) \(session.kind.padding(toLength: 12, withPad: " ", startingAt: 0)) \(session.sessionId)  \(session.name ?? "-")  [\(session.cwd)]")
                if let record { print("         pid \(record.pid)  entry \(record.entrypoint ?? "-")  sock \(record.messagingSocketPath ?? "-")  link \(record.desktopLink?.absoluteString ?? "-")") }
            }
        case ("claude", "turn"):
            guard arguments.count >= 4 else { fail("usage: pult-probe claude turn <cwd> \"<text>\" [--resume id] [--allow]") }
            var options = ClaudeStreamSession.Options(cwd: arguments[2])
            options.name = "Пульт: проба"
            if let index = arguments.firstIndex(of: "--resume") { options.resumeSessionId = arguments[index + 1] }
            let allow = arguments.contains("--allow")
            let session = ClaudeStreamSession(options: options)
            session.setPermissionHandler { request in
                print("\n[permission] \(request.toolName) \(request.input.serializedOrEmpty.prefix(200)) → \(allow ? "allow" : "deny")")
                return allow ? .allow(updatedInput: nil) : .deny(message: "declined by probe")
            }
            try session.start()
            try session.send(text: arguments[3])
            var turns = 0
            for await event in session.events {
                switch event {
                case .initialized(let id, let model, _): print("[init] session \(id) model \(model ?? "?")")
                case .assistantText(let text): print("[assistant] \(text)")
                case .assistantToolUse(let name, let input, _): print("[tool_use] \(name) \(input.serializedOrEmpty.prefix(200))")
                case .toolResult(_, let content, let isError): print("[tool_result] error=\(isError) \(content.serializedOrEmpty.prefix(200))")
                case .result(let id, let text, let isError, let cost, let ms):
                    turns += 1
                    print("[result] session \(id) error=\(isError) cost=\(cost ?? 0) ms=\(ms ?? 0) text=\(text ?? "")")
                    if turns == 1 { try session.send(text: "А теперь ответь одним словом: второе.") } else { session.end() }
                case .system(let subtype, _): print("[system] \(subtype)")
                case .textDelta: break
                case .other(let value): print("[other] \(value.serializedOrEmpty.prefix(200))")
                }
            }
            print("exit \(await session.waitUntilExit())")
        case ("claude", "inbox"):
            guard arguments.count >= 4 else { fail("usage: pult-probe claude inbox <socketPath> '<json line>' ['<json line>' …]") }
            let replies = try ClaudeInbox.send(lines: Array(arguments[3...]), to: arguments[2])
            print(replies.isEmpty ? "(no reply)" : replies.joined(separator: "\n"))
        case ("claude", "hooks"):
            // Starts a receiver, then a scratch session whose hooks post here; prints what arrives.
            guard arguments.count >= 3 else { fail("usage: pult-probe claude hooks <cwd>") }
            let receiver = ClaudeHookReceiver()
            try await receiver.start()
            print("listening on 127.0.0.1:\(receiver.port)")
            Task { for await event in receiver.events { print("[hook] \(event.name) session \(event.sessionId) \(event.payload.serializedOrEmpty.prefix(220))") } }
            var options = ClaudeStreamSession.Options(cwd: arguments[2])
            options.name = "Пульт: хуки"
            options.extraArguments = ["--settings", try receiver.settings().serialized()]
            let session = ClaudeStreamSession(options: options)
            try session.start()
            try session.send(text: "Ответь одним словом: хук.")
            for await event in session.events {
                if case .result = event { session.end() }
            }
            try await Task.sleep(nanoseconds: 1_500_000_000)
            print("exit \(await session.waitUntilExit())")
        case ("claude", "inbox-test"):
            // Starts a scratch session that accepts peer messages, then posts candidate frames to its inbox.
            guard arguments.count >= 3 else { fail("usage: pult-probe claude inbox-test <cwd>") }
            let debugFile = arguments[2] + "/inbox-debug.log"
            var options = ClaudeStreamSession.Options(cwd: arguments[2])
            options.name = "Пульт: инбокс"
            options.extraArguments = ["--settings", "{\"crossSessionInbound\":\"accept\"}", "--debug-file", debugFile]
            let session = ClaudeStreamSession(options: options)
            try session.start()
            try session.send(text: "Ответь одним словом: жду. Дальше тебе придут сообщения от другой сессии; на каждое отвечай одним словом: получил.")
            var sent = false
            var results = 0
            for await event in session.events {
                switch event {
                case .assistantText(let text): print("[assistant] \(text)")
                case .result:
                    results += 1
                    if !sent, let id = session.sessionId {
                        sent = true
                        let record = ClaudeSessions.records().first { $0.sessionId == id }
                        guard let socket = record?.messagingSocketPath else { fail("no socket for session \(id)") }
                        print("socket \(socket)")
                        let candidates: [JSONValue] = [
                            ["type": "user", "message": ["role": "user", "content": "проба 1: минимальный кадр"]],
                            ["type": "user", "from": "Волна: Пульт", "msgV": 1, "msg_id": .string(UUID().uuidString.lowercased()),
                             "message": ["role": "user", "content": "проба 2: кадр с отправителем"]],
                        ]
                        for candidate in candidates {
                            let replies = try ClaudeInbox.send(lines: [try candidate.serialized()], to: socket, timeout: 2)
                            print("sent \(candidate.serializedOrEmpty.prefix(80)) → \(replies.isEmpty ? "(no reply)" : replies.joined(separator: " | "))")
                        }
                    } else if results >= 3 {
                        session.end()
                    }
                case .system(let subtype, _): print("[system] \(subtype)")
                case .other(let value): print("[other] \(value.serializedOrEmpty.prefix(160))")
                default: break
                }
            }
            print("exit \(await session.waitUntilExit())")
            let log = (try? String(contentsOfFile: debugFile, encoding: .utf8)) ?? ""
            for line in log.split(separator: "\n") where line.contains("uds-messaging") || line.contains("peer") { print("[debug] \(line.prefix(300))") }
        case ("run", _):
            // pult-probe run <claude|codex> <cwd> "<text>" [--allow]: drives an own run like the panel does.
            guard arguments.count >= 4 else { fail("usage: pult-probe run <claude|codex> <cwd> \"<text>\" [--allow]") }
            let allow = arguments.contains("--allow")
            let agent: HubSession.Agent = arguments[1] == "codex" ? .codex : .claude
            let (cwd, text) = (arguments[2], arguments[3])
            let run = await MainActor.run { ProbeHolder.hub.startRun(agent: agent, cwd: cwd, prompt: text) }
            var last = ""
            for _ in 0..<600 {
                try await Task.sleep(nanoseconds: 500_000_000)
                let snapshot: (String, String?, String?, String?, Bool) = await MainActor.run {
                    let phase = "\(run.phase)"
                    if let pending = run.pending { print("[approval] \(pending.summary) → \(allow ? "allow" : "deny")"); run.decide(allow) }
                    return (phase, run.externalId, run.result, run.error, run.phase == .done || run.phase == .failed)
                }
                if snapshot.0 != last { last = snapshot.0; print("[phase] \(last) id=\(snapshot.1 ?? "-")") }
                if snapshot.4 { print("[result] \(snapshot.2 ?? "")\n[error] \(snapshot.3 ?? "")"); print("[open] \(await MainActor.run { run.openURL?.absoluteString ?? "-" })"); break }
            }
        default:
            fail("unknown command \(arguments[0]) \(arguments[1])")
        }
    } catch {
        fail("error: \(error)")
    }
    exit(0)
}
// Keep the main thread serving the main actor: own runs and the hub live there.
dispatchMain()
