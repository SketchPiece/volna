import Foundation

/// A task for Codex (model Астра) to do on this Mac through Computer Use (docs/mac-agent-hub.md, 2.3).
/// Computer Use only answers processes signed by OpenAI, so Pult never drives apps itself: it starts a Codex thread,
/// and every app Codex wants to operate becomes a `computer_app` confirmation that only a tap on the phone approves.
public struct ComputerJob: Equatable, Sendable, Identifiable {
    public enum State: String, Sendable { case starting, working, needsYou = "needs_you", done, failed, cancelled }

    public let id: String
    public let task: String
    public let createdAt: Date
    /// Id of the bridge's background task this job works for (`server/src/tasks`); its title and progress come from there.
    public var ref: String?
    public var state: State = .starting
    public var threadId: String?
    public var turnId: String?
    /// The app waiting for the owner's tap right now.
    public var pendingApp: String?
    public var allowedApps: [String] = []
    public var declinedApps: [String] = []
    /// Codex's final answer, meant to be retold by voice.
    public var reply: String?
    /// Short reason on failure: timeout, codex_exited, turn_failed, start_failed.
    public var error: String?
    public var finishedAt: Date?
    /// The latest steps of the work (Codex's remarks, reasoning summaries, tool calls), oldest first, at most `activityKeep`.
    /// The bridge folds them into a one-line "what is happening now" (server/src/tasks/progress.ts).
    public var activity: [String] = []
    /// How many steps there were in total, so the bridge can tell new ones from those it already saw.
    public var activityTotal = 0
    /// «What is happening now», one sentence the bridge writes every half a minute.
    public var progress: String?
    var lastMessage: String?

    static let activityKeep = 30
    static let activityChars = 300

    public init(id: String, task: String, createdAt: Date, ref: String? = nil) {
        self.id = id; self.task = task; self.createdAt = createdAt; self.ref = ref
    }

    /// The thread in the Codex app; on the shared server it is live there.
    public var openURL: URL? { threadId.map { URL(string: "codex://threads/\($0)")! } }

    public var isFinished: Bool { state == .done || state == .failed || state == .cancelled }

    /// Folds one app-server event of this job's thread into the job.
    public func applying(_ event: CodexEvent, now: Date) -> ComputerJob {
        var job = self
        guard !job.isFinished else { return job }
        switch event {
        case .turnStarted(_, let turnId):
            job.turnId = turnId
            if job.state == .starting { job.state = .working }
        case .itemCompleted(_, _, let item) where item["type"]?.string == "agentMessage":
            guard let text = item["text"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { break }
            job.lastMessage = text
            if item["phase"]?.string == "final_answer" { job.reply = text } else { job.note(text) }
        case .itemCompleted(_, _, let item):
            if let step = Self.step(item) { job.note(step) }
        case .turnCompleted(_, _, let status, let message):
            job.finishedAt = now
            job.pendingApp = nil
            switch status {
            case "completed":
                job.state = .done
                job.reply = job.reply ?? job.lastMessage
            case "interrupted":
                job.state = .cancelled
            default:
                job.state = .failed
                job.error = job.error ?? "turn_failed"
                job.reply = job.reply ?? message
            }
        default:
            break
        }
        return job
    }

    mutating func note(_ line: String) {
        let text = line.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        activity.append(String(text.prefix(Self.activityChars)))
        activity = Array(activity.suffix(Self.activityKeep))
        activityTotal += 1
    }

    /// One line for a finished app-server item other than a message: a reasoning summary or a tool call.
    static func step(_ item: JSONValue) -> String? {
        switch item["type"]?.string {
        case "reasoning":
            let parts = (item["summary"]?.array ?? []).compactMap { $0.string ?? $0["text"]?.string }
            let text = parts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : "размышляет: \(text)"
        case "mcpToolCall":
            let name = [item["server"]?.string, item["tool"]?.string].compactMap { $0 }.joined(separator: ".")
            return name.isEmpty ? nil : "действие: \(name)"
        case "commandExecution":
            return item["command"]?.string.map { "команда: \($0)" }
        default:
            return nil
        }
    }

    /// What Codex gets: the rules first, then the owner's task word for word. Since 23.09.2026 every «Работа» task
    /// comes here, research included, so Computer Use is only for tasks that need apps (docs/tools-routing.md).
    public static func prompt(for task: String) -> String {
        """
        Задание от голосового ассистента «Волна» для владельца этого Mac. Это может быть исследование, план или разбор: тогда ищи в интернете и думай сам, приложения не открывай. Если задание требует действий в приложениях Mac, делай их через Computer Use (node_repl и @oai/sky).
        Владелец сейчас не у экрана и на вопросы не ответит. Доступ к каждому приложению он подтверждает кнопкой на телефоне; отказ значит: это приложение не трогать, сделай что можно без него.
        Нельзя: вводить пароли, коды и платёжные данные; покупать, платить и переводить деньги; удалять файлы, письма и другие данные; отправлять сообщения, письма и публикации от имени владельца; менять системные настройки и настройки безопасности. Если без этого задачу не сделать, остановись и скажи, что владельцу нужно сделать самому.
        В конце ответь по-русски 2–5 предложениями живой речи, без списков и разметки: главный итог или что сделано, что не получилось; для исследования назови источник. Ответ перескажут голосом.

        Задание: \(task)
        """
    }
}

/// Reads Codex's `mcpServer/elicitation/request` for Computer Use: `{ serverName: "node_repl", message: "Allow Computer Use to use \"Finder\"?",
/// _meta: { connector_id: "computer-use", tool_name, tool_params: { app }, tool_params_display: [{ name: "app", value: "Finder" }] } }`.
public enum ComputerAppRequest {
    /// The app's display name, or nil when the elicitation is not a Computer Use app request.
    public static func app(in params: JSONValue) -> String? {
        let meta = params["_meta"]
        guard meta?["connector_id"]?.string == "computer-use" else { return nil }
        if let shown = meta?["tool_params_display"]?.array?.first(where: { $0["name"]?.string == "app" })?["value"]?.string, !shown.isEmpty {
            return shown
        }
        if let app = meta?["tool_params"]?["app"]?.string, !app.isEmpty { return app }
        let message = params["message"]?.string ?? ""
        guard let open = message.firstIndex(of: "\""), let close = message[message.index(after: open)...].firstIndex(of: "\"") else { return nil }
        let name = String(message[message.index(after: open)..<close])
        return name.isEmpty ? nil : name
    }
}

/// Runs computer jobs in a dedicated `codex app-server`, started on the first job and kept for the next ones.
@MainActor
public final class ComputerJobs {
    /// Asks the owner (panel of Pult, card on the phone) whether Codex may operate `app` for the job; true only after a tap.
    public typealias Ask = @MainActor (ComputerJob, String) async -> Bool
    /// The request was answered in another client (the Codex app on the shared server): the open question is withdrawn.
    public typealias Withdraw = @MainActor (ComputerJob) -> Void

    /// The model the owner chose for computer work (Астра); nil would take `model` from ~/.codex/config.toml.
    nonisolated public static let model = "gpt-6-astra"
    /// A job longer than this is interrupted.
    public static let lifetime: TimeInterval = 15 * 60
    static let keep = 20

    public private(set) var jobs: [ComputerJob] = []
    public var onChange: (@MainActor () -> Void)?

    private let ask: Ask
    private let withdraw: Withdraw
    private let prepare: @MainActor () async -> Void
    private let makeClient: @MainActor () -> CodexClient
    private let workdir: URL
    private let now: () -> Date
    private var client: CodexClient?
    private var timers: [String: Task<Void, Never>] = [:]
    /// The request each job is waiting on, and jobs whose request someone answered elsewhere.
    private var waiting: [String: JSONValue] = [:]
    private var answeredElsewhere: Set<String> = []

    /// `prepare` runs before the first connection (Pult starts the shared server there); `makeClient` then connects.
    public init(workdir: URL = ComputerJobs.defaultWorkdir, now: @escaping () -> Date = Date.init,
                prepare: @escaping @MainActor () async -> Void = {},
                makeClient: @escaping @MainActor () -> CodexClient = { CodexClient() },
                withdraw: @escaping Withdraw = { _ in }, ask: @escaping Ask) {
        self.workdir = workdir; self.now = now; self.prepare = prepare; self.makeClient = makeClient; self.withdraw = withdraw; self.ask = ask
    }

    /// Codex needs a working folder; jobs get an empty one of their own.
    nonisolated public static var defaultWorkdir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("VolnaPult/computer", isDirectory: true)
    }

    public func job(_ id: String) -> ComputerJob? { jobs.first { $0.id == id } }

    /// Starts a job: a new thread with Астра and one turn with the task. Progress lands in `jobs`.
    public func start(task: String, ref: String? = nil) async throws -> ComputerJob {
        let job = ComputerJob(id: ConfirmationCenter.randomId(), task: task, createdAt: now(), ref: ref)
        jobs.append(job)
        jobs = Array(jobs.suffix(Self.keep))
        PultLog.write("computer job \(job.id.prefix(6)) queued: \(task.prefix(80))")
        do {
            let client = try await ensureClient()
            try FileManager.default.createDirectory(at: workdir, withIntermediateDirectories: true)
            let thread = try await client.startThread(cwd: workdir.path, model: Self.model, approvalPolicy: "on-request")
            update(job.id) { $0.threadId = thread.id }
            try? await client.setThreadName(threadId: thread.id, name: "Волна: \(task.prefix(40))")
            let turnId = try await client.startTurn(threadId: thread.id, text: ComputerJob.prompt(for: task))
            update(job.id) { if $0.turnId == nil { $0.turnId = turnId }; if $0.state == .starting { $0.state = .working } }
        } catch {
            PultLog.write("computer job \(job.id.prefix(6)) failed to start: \(error)")
            update(job.id) { $0.state = .failed; $0.error = "start_failed"; $0.finishedAt = self.now() }
            return self.job(job.id) ?? job
        }
        timers[job.id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.lifetime))
            guard !Task.isCancelled else { return }
            await self?.stop(job.id, reason: "timeout")
        }
        return self.job(job.id) ?? job
    }

    /// Interrupts a running job. Nil for an unknown id; a finished job comes back unchanged.
    public func cancel(_ id: String) async -> ComputerJob? {
        guard job(id) != nil else { return nil }
        await stop(id, reason: nil)
        return job(id)
    }

    private func stop(_ id: String, reason: String?) async {
        guard let current = job(id), !current.isFinished else { return }
        if let client, let thread = current.threadId, let turn = current.turnId {
            try? await client.interrupt(threadId: thread, turnId: turn)
        }
        update(id) {
            $0.state = reason == nil ? .cancelled : .failed
            $0.error = reason
            $0.pendingApp = nil
            $0.finishedAt = self.now()
        }
        PultLog.write("computer job \(id.prefix(6)) \(reason ?? "cancelled")")
    }

    private func ensureClient() async throws -> CodexClient {
        if let client { return client }
        await prepare()
        let client = makeClient()
        client.setApprovalHandler { [weak self] request in
            await self?.decide(request) ?? .decline
        }
        try await client.start()
        self.client = client
        Task { [weak self] in
            for await event in client.events { self?.handle(event) }
            self?.clientExited(client)
        }
        return client
    }

    private func clientExited(_ gone: CodexClient) {
        guard client === gone else { return }
        client = nil
        for job in jobs where !job.isFinished {
            update(job.id) { $0.state = .failed; $0.error = "codex_exited"; $0.pendingApp = nil; $0.finishedAt = self.now() }
        }
        PultLog.write("computer app-server exited")
    }

    private func handle(_ event: CodexEvent) {
        let threadId: String
        switch event {
        case .requestResolved(let t, let requestId):
            resolved(threadId: t, requestId: requestId)
            return
        case .turnStarted(let t, _), .turnCompleted(let t, _, _, _), .itemCompleted(let t, _, _): threadId = t
        default: return
        }
        guard let job = jobs.first(where: { $0.threadId == threadId }) else { return }
        let next = job.applying(event, now: now())
        guard next != job else { return }
        update(job.id) { $0 = next }
        if next.isFinished {
            timers.removeValue(forKey: job.id)?.cancel()
            PultLog.write("computer job \(job.id.prefix(6)) \(next.state.rawValue)")
        }
    }

    /// Codex asks for something. Only Computer Use app requests of our own jobs go to the phone; everything else is declined:
    /// a computer job has no business running commands outside the sandbox or answering other servers' forms.
    private func decide(_ request: CodexApprovalRequest) async -> CodexApprovalDecision {
        guard case .elicitation(let params) = request.kind, let app = ComputerAppRequest.app(in: params),
              let job = jobs.first(where: { $0.threadId == request.threadId && !$0.isFinished }) else {
            PultLog.write("computer: declined \(request.method)")
            return .decline
        }
        update(job.id) { $0.state = .needsYou; $0.pendingApp = app }
        waiting[job.id] = request.requestId
        let approved = await ask(self.job(job.id) ?? job, app)
        waiting[job.id] = nil
        let elsewhere = answeredElsewhere.remove(job.id) != nil
        update(job.id) {
            guard !$0.isFinished else { return }
            $0.state = .working
            $0.pendingApp = nil
            // Answered in the Codex app: the server does not say how, so the app lands in neither list.
            if elsewhere { $0.note("доступ к \(app) решён в Codex") }
            else if approved { $0.allowedApps.append(app) } else { $0.declinedApps.append(app) }
        }
        PultLog.write("computer job \(job.id.prefix(6)) app \(app): \(elsewhere ? "answered in Codex" : approved ? "allowed for the thread" : "declined")")
        // Our late answer to a resolved request is ignored by the server.
        return approved ? .acceptForSession : .decline
    }

    /// Someone answered a request first. If it is the one a job waits on and the job still waits, the owner did it in Codex.
    private func resolved(threadId: String, requestId: JSONValue) {
        guard let job = jobs.first(where: { $0.threadId == threadId && $0.state == .needsYou }),
              let pending = waiting[job.id], pending == requestId else { return }
        answeredElsewhere.insert(job.id)
        withdraw(job)
    }

    /// The bridge's one-line summary of what the job is doing (`server/src/tasks/progress.ts`).
    public func setProgress(ref: String, _ text: String?) {
        guard let job = jobs.first(where: { $0.ref == ref }) else { return }
        update(job.id) { $0.progress = text }
    }

    private func update(_ id: String, _ change: (inout ComputerJob) -> Void) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        change(&jobs[index])
        onChange?()
    }
}
