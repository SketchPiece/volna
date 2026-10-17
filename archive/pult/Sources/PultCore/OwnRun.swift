import Foundation
import Observation

/// A permission or approval request an own run is blocked on; `decide` resumes the agent.
public struct PendingApproval: Sendable {
    public var summary: String
    let decide: @Sendable (Bool) -> Void
}

/// A session Пульт started itself: the agent runs as a child process, the answer comes back here.
/// The conversation is stored by the agent as usual, so it can be opened in Claude Desktop or Codex afterwards.
@Observable @MainActor
public final class OwnRun: Identifiable {
    public enum Phase: Sendable { case starting, running, needsYou, done, failed }

    public let id = UUID().uuidString
    public let agent: HubSession.Agent
    public let name: String
    public let cwd: String
    public let prompt: String
    public let startedAt = Date()
    public private(set) var phase: Phase = .starting
    public private(set) var pending: PendingApproval?
    public private(set) var result: String?
    public private(set) var error: String?
    public private(set) var externalId: String?
    public private(set) var finishedAt: Date?
    var onUpdate: (@MainActor () -> Void)?

    private var claude: ClaudeStreamSession?
    private var codex: CodexClient?
    private var decided = false

    init(agent: HubSession.Agent, cwd: String, prompt: String) {
        self.agent = agent
        self.cwd = cwd
        self.prompt = prompt
        let firstLine = prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? prompt
        name = firstLine.count > 48 ? String(firstLine.prefix(46)).trimmingCharacters(in: .whitespaces) + "…" : firstLine
    }

    public var openURL: URL? {
        guard let externalId else { return nil }
        return URL(string: agent == .claude ? "claude://resume?session=\(externalId)" : "codex://threads/\(externalId)")
    }

    public func decide(_ allow: Bool) {
        guard let pending else { return }
        self.pending = nil
        phase = .running
        pending.decide(allow)
        onUpdate?()
    }

    public func cancel() {
        claude?.terminate()
        codex?.stop()
        if phase != .done { fail("остановлено с Пульта") }
    }

    // MARK: - Claude

    func startClaude() {
        var options = ClaudeStreamSession.Options(cwd: cwd)
        options.name = name
        let session = ClaudeStreamSession(options: options)
        claude = session
        session.setPermissionHandler { [weak self] request in
            let summary = "\(request.toolName): \(Self.short(request.input))"
            return await withCheckedContinuation { continuation in
                Task { @MainActor in
                    guard let self else { continuation.resume(returning: .deny(message: "Пульт закрыт")); return }
                    self.block(summary) { allow in
                        continuation.resume(returning: allow ? .allow(updatedInput: nil) : .deny(message: "Отклонено с Пульта"))
                    }
                }
            }
        }
        do {
            try session.start()
            try session.send(text: prompt)
            phase = .running
        } catch {
            fail("\(error)")
            return
        }
        Task { [weak self] in
            var lastText = ""
            for await event in session.events {
                switch event {
                case .initialized(let id, _, _): await self?.setExternalId(id)
                case .assistantText(let text): lastText = text
                case .result(_, let text, let isError, _, _):
                    await self?.finish(text: text ?? lastText, isError: isError)
                    session.end()
                default: break
                }
            }
            await self?.finishIfStillRunning()
        }
    }

    // MARK: - Codex

    func startCodex() {
        let client = CodexClient()
        codex = client
        client.setApprovalHandler { [weak self] request in
            let summary: String
            switch request.kind {
            case .command(let command, _, let reason): summary = "команда: \(command ?? "?")" + (reason.map { " (\($0))" } ?? "")
            case .fileChange(let reason, _): summary = "правка файлов" + (reason.map { ": \($0)" } ?? "")
            case .permissions: summary = "доступ вне песочницы"
            case .userInput, .elicitation: summary = "вопрос агента"
            }
            return await withCheckedContinuation { continuation in
                Task { @MainActor in
                    guard let self else { continuation.resume(returning: .decline); return }
                    self.block(summary) { allow in continuation.resume(returning: allow ? .accept : .decline) }
                }
            }
        }
        Task { [weak self] in
            var text = ""
            do {
                try await client.start()
                let thread = try await client.startThread(cwd: self?.cwd)
                await self?.setExternalId(thread.id)
                if let name = self?.name { try? await client.setThreadName(threadId: thread.id, name: name) }
                _ = try await client.startTurn(threadId: thread.id, text: self?.prompt ?? "")
                await self?.markRunning()
            } catch {
                await self?.fail("\(error)")
                client.stop()
                return
            }
            for await event in client.events {
                switch event {
                case .agentMessageDelta(_, _, _, let delta): text += delta
                case .itemCompleted(_, _, let item) where item["type"]?.string == "agentMessage":
                    if let full = item["text"]?.string { text = full }
                case .turnCompleted(_, _, let status, let message):
                    await self?.finish(text: text, isError: status != "completed", errorMessage: message)
                    client.stop()
                default: break
                }
            }
            await self?.finishIfStillRunning()
        }
    }

    // MARK: - State

    private func block(_ summary: String, decide: @escaping @Sendable (Bool) -> Void) {
        pending = PendingApproval(summary: summary, decide: decide)
        phase = .needsYou
        onUpdate?()
    }

    private func setExternalId(_ id: String) { externalId = id; onUpdate?() }
    private func markRunning() { if phase == .starting { phase = .running; onUpdate?() } }

    private func finish(text: String, isError: Bool, errorMessage: String? = nil) {
        guard phase != .done, phase != .failed else { return }
        finishedAt = Date()
        if isError { phase = .failed; error = errorMessage ?? (text.isEmpty ? "ошибка" : text) } else { phase = .done; result = text }
        PultLog.write("run \(agent.rawValue) \(isError ? "failed" : "done"): \(name)")
        onUpdate?()
    }

    private func finishIfStillRunning() { if phase == .running || phase == .starting || phase == .needsYou { fail("процесс завершился без ответа") } }

    private func fail(_ message: String) {
        guard phase != .done, phase != .failed else { return }
        phase = .failed; error = message; finishedAt = Date()
        PultLog.write("run \(agent.rawValue) failed: \(message)")
        onUpdate?()
    }

    nonisolated private static func short(_ input: JSONValue) -> String {
        if let command = input["command"]?.string { return command }
        if let path = input["file_path"]?.string { return path }
        return String((try? input.serialized())?.prefix(100) ?? "")
    }
}

public extension HubSession {
    @MainActor init(run: OwnRun) {
        id = "run:" + run.id
        agent = run.agent
        origin = .pult
        switch run.phase {
        case .starting, .running: state = .working
        case .needsYou: state = .needsYou
        case .done: state = .idle
        case .failed: state = .failed
        }
        name = run.name
        cwd = run.cwd
        if let pending = run.pending { detail = pending.summary }
        else if let result = run.result { detail = result.replacingOccurrences(of: "\n", with: " ") }
        else if let error = run.error { detail = error }
        else { detail = nil }
        updatedAt = run.finishedAt ?? run.startedAt
        openURL = run.openURL
        inboxSocket = nil
        model = nil
        effort = nil
        lastReply = run.result
    }
}
