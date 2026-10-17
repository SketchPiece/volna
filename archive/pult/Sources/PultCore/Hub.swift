import AppKit
import Foundation
import Observation

/// One row of the control panel, whichever agent it came from.
public struct HubSession: Identifiable, Equatable, Sendable {
    public enum Agent: String, Sendable { case claude, codex }
    public enum Origin: String, Sendable {
        case claudeDesktop, claudeCLI, claudeBackground, codexApp, codexCLI, codexOther, pult
        public var label: String {
            switch self {
            case .pult: return "Пульт"
            case .claudeDesktop: return "Claude Desktop"
            case .claudeCLI: return "Claude Code"
            case .claudeBackground: return "Claude, фон"
            case .codexApp: return "Codex · ChatGPT"
            case .codexCLI: return "Codex CLI"
            case .codexOther: return "Codex"
            }
        }
    }
    public enum State: String, Sendable, Comparable {
        case needsYou, working, idle, failed, off
        private var order: Int { [State.needsYou, .working, .idle, .failed, .off].firstIndex(of: self)! }
        public static func < (a: State, b: State) -> Bool { a.order < b.order }
        public var label: String {
            switch self {
            case .needsYou: return "ЖДЁТ ТЕБЯ"
            case .working: return "РАБОТАЕТ"
            case .idle: return "ЖДЁТ ЗАДАЧУ"
            case .failed: return "ПОМЕХИ"
            case .off: return "ВНЕ ЭФИРА"
            }
        }
    }

    public var id: String
    public var agent: Agent
    public var origin: Origin
    public var state: State
    public var name: String
    public var cwd: String
    public var detail: String?
    public var updatedAt: Date?
    public var openURL: URL?
    public var inboxSocket: String?
    public var model: String?
    public var effort: String?
    /// Last answer of the session: from the Stop hook for Claude, the result for Pult's own runs.
    public var lastReply: String?

    public var project: String { (cwd as NSString).lastPathComponent }

    /// Short human name for a model id: claude-fable-5-1 → Fable 5.1, gpt-5.6-terra → GPT-5.6 Terra.
    public var modelLabel: String? {
        guard let model else { return nil }
        var parts = model.split(separator: "-").map(String.init)
        if parts.first == "claude" { parts.removeFirst() }
        guard !parts.isEmpty else { return model }
        var words: [String] = []
        var version: [String] = []
        for part in parts {
            if part.allSatisfy(\.isNumber) { version.append(part) }
            else if part.hasPrefix("gpt") { words.append(part.uppercased()) }
            else if part.count == 8, part.allSatisfy(\.isNumber) { continue }
            else { words.append(part.prefix(1).uppercased() + part.dropFirst()) }
        }
        let joined = words.joined(separator: " ") + (version.isEmpty ? "" : " " + version.joined(separator: "."))
        return joined.trimmingCharacters(in: .whitespaces)
    }

    public init(id: String, agent: Agent, origin: Origin, state: State, name: String, cwd: String, detail: String? = nil,
                updatedAt: Date? = nil, openURL: URL? = nil, inboxSocket: String? = nil) {
        self.id = id; self.agent = agent; self.origin = origin; self.state = state; self.name = name; self.cwd = cwd
        self.detail = detail; self.updatedAt = updatedAt; self.openURL = openURL; self.inboxSocket = inboxSocket
    }

    /// Claude: the documented listing plus the registry record for socket and deep link.
    public init(claude session: ClaudeLiveSession, record: ClaudeSessionRecord?, processArguments: String? = nil) {
        id = "claude:" + session.sessionId
        agent = .claude
        if record?.entrypoint == "claude-desktop" { origin = .claudeDesktop } else if session.kind == "background" { origin = .claudeBackground } else { origin = .claudeCLI }
        switch (session.state, session.status) {
        case ("failed", _): state = .failed
        case ("stopped", _): state = .off
        case (_, "waiting"), ("blocked", _): state = .needsYou
        case (_, "busy"), ("working", _): state = .working
        default: state = .idle
        }
        name = session.name ?? record?.name ?? String(session.sessionId.prefix(8))
        cwd = session.cwd
        detail = session.waitingFor
        updatedAt = session.startedAt
        openURL = record?.desktopLink
        inboxSocket = record?.messagingSocketPath
        model = processArguments.flatMap { Self.argument("--model", in: $0) }
        effort = processArguments.flatMap { Self.argument("--effort", in: $0) }
    }

    static func argument(_ flag: String, in arguments: String) -> String? {
        let parts = arguments.split(separator: " ").map(String.init)
        guard let index = parts.firstIndex(of: flag), index + 1 < parts.count, !parts[index + 1].hasPrefix("--") else { return nil }
        return parts[index + 1]
    }

    /// Codex: threads on disk. Another process holds the live state, so recent activity stands in for "working".
    public init(codex thread: CodexThread, now: Date = Date(), activeWindow: TimeInterval = 120) {
        id = "codex:" + thread.id
        agent = .codex
        if thread.originator?.contains("Desktop") == true { origin = .codexApp } else if thread.sourceKind == "cli" { origin = .codexCLI } else { origin = .codexOther }
        switch thread.statusKind {
        case "active": state = .working
        case "systemError": state = .failed
        case "idle": state = .idle
        default: state = now.timeIntervalSince(thread.updatedAt) < activeWindow ? .working : .off
        }
        let preview = thread.preview.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        name = thread.name ?? (preview.isEmpty ? String(thread.id.prefix(8)) : String(preview.prefix(72)))
        cwd = thread.cwd
        detail = nil
        updatedAt = thread.updatedAt
        openURL = URL(string: "codex://threads/\(thread.id)")
        inboxSocket = nil
        model = thread.model
        effort = thread.raw["reasoningEffort"]?.string
    }
}

/// What changed between two refreshes; the app turns these into notifications.
public enum HubChange: Equatable, Sendable {
    case needsYou(HubSession)
    case finished(HubSession)
    case failed(HubSession)

    public static func compute(from old: [HubSession], to new: [HubSession]) -> [HubChange] {
        let before = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var changes: [HubChange] = []
        for session in new {
            guard let previous = before[session.id], previous.state != session.state else { continue }
            switch session.state {
            case .needsYou: changes.append(.needsYou(session))
            case .idle where previous.state == .working || previous.state == .needsYou: changes.append(.finished(session))
            case .failed: changes.append(.failed(session))
            default: break
            }
        }
        return changes
    }
}

/// Watches every agent session on the machine and keeps one merged list.
/// Claude: `claude agents --json` on a timer plus HTTP hooks for instant refreshes.
/// Codex: one `codex app-server` child, `thread/list` on a slower timer.
@Observable @MainActor
public final class AgentHub {
    public struct Settings: Sendable {
        public var claudeInterval: TimeInterval = 8
        public var codexInterval: TimeInterval = 30
        public var codexEnabled = true
        public var codexDays = 3
        public var hookPort: UInt16 = 48611
        /// Loopback API for the Volna bridge (`server/`): agents_list / agents_send / agents_open / agents_start.
        public var bridgeEnabled = true
        /// New Claude Desktop chats from Волна are sent by pressing Return through Accessibility; off leaves them typed in.
        public var claudeAutoSend = true
        public var bridgePort: UInt16 = 48612
        public init() {}
    }

    public private(set) var sessions: [HubSession] = []
    public private(set) var runs: [OwnRun] = []
    public private(set) var lastRefresh: Date?
    public private(set) var claudeError: String?
    public private(set) var codexError: String?
    public private(set) var codexVersion: String?
    public private(set) var hookPort: UInt16?
    public private(set) var hookEventCount = 0
    public private(set) var bridgePort: UInt16?
    public private(set) var bridgeError: String?
    public var bridgeRequestCount: Int { bridge?.requestCount ?? 0 }
    public var onChanges: (@MainActor ([HubChange]) -> Void)?
    /// The «Работа» tab: Astra's jobs and the bridge's background tasks.
    public private(set) var taskRows: [TaskRow] = []
    /// Is the Codex app on the shared server (`CodexHost`).
    public private(set) var codexLink: CodexLink = .appClosed
    public private(set) var codexLinkError: String?
    public private(set) var codexRelinking = false
    @ObservationIgnored public let codexHost = CodexHost()
    @ObservationIgnored public let backgroundTasks = BackgroundTasks()
    /// AskUserQuestion calls held for Волна while a call is live.
    @ObservationIgnored public let questions = QuestionDesk()
    @ObservationIgnored private var sharedServerReady = false

    private var settings: Settings
    private var codex: CodexClient?
    private var codexSessions: [HubSession] = []
    private var claudeSessions: [HubSession] = []
    private var receiver: ClaudeHookReceiver?
    private var bridge: BridgeAPIServer?
    private var tasks: [Task<Void, Never>] = []
    private var lastReplies: [String: String] = [:]

    public init(settings: Settings = Settings()) { self.settings = settings }

    public var needsYou: [HubSession] { sessions.filter { $0.state == .needsYou } }
    /// Project folders seen across sessions, most recent first, for the new-session form.
    public var recentProjects: [String] {
        var seen: [String] = []
        for session in sessions.sorted(by: { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }) where !session.cwd.isEmpty && !seen.contains(session.cwd) {
            seen.append(session.cwd)
        }
        return seen
    }
    public var working: [HubSession] { sessions.filter { $0.state == .working } }

    public func start() {
        stop()
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshClaude()
                try? await Task.sleep(for: .seconds(self?.settings.claudeInterval ?? 8))
            }
        })
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshCodex()
                try? await Task.sleep(for: .seconds(self?.settings.codexInterval ?? 30))
            }
        })
        tasks.append(Task { [weak self] in await self?.runHookReceiver() })
        tasks.append(Task { [weak self] in await self?.runBridgeServer() })
        tasks.append(Task { [weak self] in
            await self?.startCodexHost()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                await self?.refreshCodexLink()
            }
        })
        backgroundTasks.onChange = { [weak self] in self?.refreshTasks() }
        computer.onChange = { [weak self] in self?.refreshTasks() }
    }

    public func stop() {
        tasks.forEach { $0.cancel() }
        tasks = []
        receiver?.stop(); receiver = nil; hookPort = nil
        bridge?.stop(); bridge = nil; bridgePort = nil
        codex?.stop(); codex = nil
    }

    public func update(settings: Settings) {
        let restart = settings.hookPort != self.settings.hookPort || settings.codexEnabled != self.settings.codexEnabled
            || settings.bridgePort != self.settings.bridgePort || settings.bridgeEnabled != self.settings.bridgeEnabled
        self.settings = settings
        if restart { start() }
    }

    public func refresh() async {
        await refreshClaude()
        await refreshCodex()
    }

    /// Starts a new session with the agent as a child process; progress and the answer show up in `sessions`.
    @discardableResult
    public func startRun(agent: HubSession.Agent, cwd: String, prompt: String) -> OwnRun {
        let run = OwnRun(agent: agent, cwd: cwd, prompt: prompt)
        run.onUpdate = { [weak self] in self?.merge() }
        runs.insert(run, at: 0)
        PultLog.write("run \(agent.rawValue) start in \(cwd): \(prompt.prefix(80))")
        if agent == .claude { run.startClaude() } else { run.startCodex() }
        merge()
        return run
    }

    public func run(for session: HubSession) -> OwnRun? {
        guard session.id.hasPrefix("run:") else { return nil }
        return runs.first { "run:" + $0.id == session.id }
    }

    public func forget(_ run: OwnRun) {
        run.cancel()
        runs.removeAll { $0.id == run.id }
        merge()
    }

    /// Posts a message into a live Claude session's inbox. Starts a turn there, so only on the user's explicit action.
    public func send(_ text: String, to session: HubSession) throws {
        guard let socket = session.inboxSocket else { throw ClaudeError.socket("session has no inbox") }
        try ClaudeInbox.post(text: text, from: "Волна: Пульт", to: socket)
        PultLog.write("sent to \(session.name): \(text.prefix(80))")
    }

    /// New chat in Claude Desktop (Code) in `folder` with the text, sent by `ClaudeDesktopComposer` when it can.
    /// A sent chat is picked out of the session registry by folder once Claude Desktop has started its process.
    public func startDesktopChat(folder: String, text: String) async -> BridgeStarted {
        let before = Set(ClaudeSessions.records().map(\.sessionId))
        guard let outcome = await ClaudeDesktopComposer.start(folder: folder, prompt: text, autoSend: settings.claudeAutoSend) else {
            PultLog.write("desktop chat in \(folder): link not taken")
            return BridgeStarted(opened: false)
        }
        PultLog.write("desktop chat in \(folder): \(outcome) \(text.prefix(80))")
        switch outcome {
        case .sent:
            return BridgeStarted(opened: true, sent: true, sessionId: await newDesktopSession(in: folder, excluding: before))
        case .needsTrust:
            confirmations.add(.trustFolder, folder: folder, prompt: text)
            return BridgeStarted(opened: true, reason: "needs_confirmation")
        case .filled(let reason):
            return BridgeStarted(opened: true, reason: reason)
        }
    }

    /// Decisions only the owner takes with a tap on the phone; see `ConfirmationCenter`.
    @ObservationIgnored public private(set) lazy var confirmations = ConfirmationCenter { [weak self] item, approve in
        await self?.answer(item, approve: approve) ?? ConfirmationOutcome(state: .failed, result: "pult_closed")
    }

    /// Computer jobs for Codex (Астра) on the shared server, so they are live in the Codex app; each app Astra wants becomes
    /// a `computerApp` confirmation answered in the panel or on the phone, or in the Codex app itself (then it is withdrawn).
    @ObservationIgnored public private(set) lazy var computer = ComputerJobs(
        prepare: { [weak self] in
            guard let self else { return }
            sharedServerReady = await codexHost.ensureServer()
        },
        makeClient: { [weak self] in
            guard let self, sharedServerReady else { return CodexClient() }
            return CodexClient(transport: WebSocketCodexTransport(url: codexHost.url))
        },
        withdraw: { [weak self] job in self?.withdrawAppRequest(for: job) },
        ask: { [weak self] job, app in await self?.askForApp(job, app: app) ?? false })
    /// Computer Use requests waiting for the tap, by confirmation id, and each job's open confirmation.
    @ObservationIgnored private var appRequests: [String: CheckedContinuation<Bool, Never>] = [:]
    @ObservationIgnored private var jobConfirmations: [String: String] = [:]

    private func askForApp(_ job: ComputerJob, app: String) async -> Bool {
        let item = confirmations.add(.computerApp, folder: "", prompt: job.task, app: app)
        jobConfirmations[job.id] = item.id
        refreshTasks()
        let approved = await withCheckedContinuation { appRequests[item.id] = $0 }
        jobConfirmations[job.id] = nil
        refreshTasks()
        return approved
    }

    private func withdrawAppRequest(for job: ComputerJob) {
        guard let id = jobConfirmations[job.id] else { return }
        confirmations.withdraw(id)
        appRequests.removeValue(forKey: id)?.resume(returning: false)
    }

    /// The owner's tap in the panel; same path as the phone's.
    public func decide(confirmation id: String, approve: Bool) async {
        _ = await confirmations.decide(id, approve: approve)
        refreshTasks()
    }

    public func refreshTasks() {
        taskRows = TaskBoard.rows(jobs: computer.jobs, tasks: backgroundTasks.items, confirmations: confirmations.visible())
    }

    private func report(_ task: BackgroundTask) {
        backgroundTasks.upsert(task)
        if task.kind == .computer { computer.setProgress(ref: task.id, task.status == .running ? task.progress : nil) }
    }

    // MARK: - Shared Codex server

    private func startCodexHost() async {
        sharedServerReady = await codexHost.ensureServer()
        await refreshCodexLink()
    }

    public func refreshCodexLink() async {
        codexLink = await codexHost.refreshLink()
    }

    /// The button: quits the Codex app and opens it again on the shared server.
    public func relinkCodexApp() async {
        codexRelinking = true
        defer { codexRelinking = false }
        do {
            try await codexHost.relaunchApp()
            sharedServerReady = true
            codexLinkError = nil
        } catch {
            codexLinkError = "\(error)"
            PultLog.write("codex relink failed: \(error)")
        }
        await refreshCodexLink()
    }

    private func answer(_ item: Confirmation, approve: Bool) async -> ConfirmationOutcome {
        if item.kind == .computerApp {
            // Expiry answers false too, so Codex never waits on a request nobody sees.
            appRequests.removeValue(forKey: item.id)?.resume(returning: approve)
            refreshTasks()
            return ConfirmationOutcome(state: approve ? .approved : .declined)
        }
        let before = Set(ClaudeSessions.records().map(\.sessionId))
        guard let outcome = await ClaudeDesktopComposer.answerTrust(folder: item.folder, prompt: item.prompt, approve: approve) else {
            return ConfirmationOutcome(state: approve ? .failed : .declined, result: "dialog_gone")
        }
        switch outcome {
        case .sent:
            return ConfirmationOutcome(state: .approved, result: "sent", sessionId: await newDesktopSession(in: item.folder, excluding: before))
        case .filled("declined"):
            return ConfirmationOutcome(state: .declined)
        case .filled("press_failed"):
            return ConfirmationOutcome(state: .failed, result: "press_failed")
        case .filled, .needsTrust:
            return ConfirmationOutcome(state: .approved, result: "typed_only")
        }
    }

    /// The Claude Desktop session that appeared in `folder` after a send, found in the registry within ten seconds.
    private func newDesktopSession(in folder: String, excluding before: Set<String>) async -> String? {
        let target = (folder as NSString).standardizingPath
        for _ in 0..<20 {
            if let record = ClaudeSessions.records().first(where: { !before.contains($0.sessionId) && $0.entrypoint == "claude-desktop"
                && $0.cwd.map({ ($0 as NSString).standardizingPath }) == target }) {
                await refreshClaude()
                return "claude:" + record.sessionId
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        await refreshClaude()
        return nil
    }

    /// Opens the session in its native client (Claude.app or ChatGPT.app) through its deep link.
    public func open(_ session: HubSession) throws {
        guard let url = session.openURL else { throw ClaudeError.socket("session has no deep link") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = [url.absoluteString]
        try process.run()
        PultLog.write("opened \(session.name)")
    }

    // MARK: - Bridge (Волна)

    private func runBridgeServer() async {
        guard settings.bridgeEnabled else { bridgeError = nil; return }
        let token: String
        do { token = try BridgeToken.ensure() } catch { bridgeError = "токен: \(error.localizedDescription)"; PultLog.write("bridge token failed: \(error)"); return }
        let router = BridgeRouter(token: token, actions: BridgeActions(
            sessions: { [weak self] in self?.sessions ?? [] },
            send: { [weak self] session, text in try self?.send(text, to: session) },
            open: { [weak self] session in try self?.open(session) },
            projects: { [weak self] in self?.recentProjects ?? [] },
            start: { [weak self] folder, text in await self?.startDesktopChat(folder: folder, text: text) ?? BridgeStarted(opened: false) },
            confirmations: { [weak self] in self?.confirmations.visible() ?? [] },
            decide: { [weak self] id, approve in await self?.confirmations.decide(id, approve: approve) },
            computerStart: { [weak self] text, ref in
                guard let self else { throw ClaudeError.socket("pult closed") }
                return try await self.computer.start(task: text, ref: ref)
            },
            computerJobs: { [weak self] in self?.computer.jobs ?? [] },
            computerCancel: { [weak self] id in await self?.computer.cancel(id) },
            taskReport: { [weak self] task in self?.report(task) },
            questions: { [weak self] in self?.questions.visible() ?? [] },
            listen: { [weak self] in self?.questions.heardListener() },
            answerQuestion: { [weak self] id, answers, single in self?.questions.answer(id, answers: answers, single: single) ?? .failure(.unknown) },
            passQuestion: { [weak self] id in self?.questions.pass(id) ?? .failure(.unknown) }))
        let server = BridgeAPIServer { request in await router.handle(request) }
        do {
            try await server.start(port: settings.bridgePort)
            bridge = server
            bridgePort = server.port
            bridgeError = nil
            PultLog.write("bridge API listening on \(server.port)")
        } catch {
            bridgeError = "\(error)"
            PultLog.write("bridge API failed: \(error)")
        }
    }

    // MARK: - Claude

    private func refreshClaude() async {
        do {
            let live = try await ClaudeSessions.live(includeCompleted: false)
            let records = Dictionary(ClaudeSessions.records().map { ($0.sessionId, $0) }, uniquingKeysWith: { a, _ in a })
            let pids = live.compactMap { $0.pid ?? records[$0.sessionId]?.pid }
            let arguments = await ClaudeSessions.processArguments(pids: pids)
            claudeSessions = live.map { session in
                let pid = session.pid ?? records[session.sessionId]?.pid
                return HubSession(claude: session, record: records[session.sessionId], processArguments: pid.flatMap { arguments[$0] })
            }
            claudeError = nil
        } catch {
            claudeError = "\(error)"
            PultLog.write("claude refresh failed: \(error)")
        }
        merge()
    }

    private func runHookReceiver() async {
        let receiver = ClaudeHookReceiver()
        let desk = questions
        receiver.responder = { _, event in await desk.ask(event.payload) }
        upgradeHooks()
        do {
            try await receiver.start(port: settings.hookPort)
            self.receiver = receiver
            hookPort = receiver.port
            PultLog.write("hooks listening on \(receiver.port)")
        } catch {
            PultLog.write("hook receiver failed: \(error)")
            return
        }
        for await event in receiver.events {
            hookEventCount += 1
            if event.name == "Stop", let reply = ClaudeTranscript.lastReply(event.payload) { lastReplies[event.sessionId] = reply }
            PultLog.write("hook \(event.name) \(event.sessionId.prefix(8)) \(event.payload["notification_type"]?.string ?? "")")
            await refreshClaude()
        }
    }

    /// Hooks put in by an older Пульт get the question hook too; hooks that are off stay off.
    private func upgradeHooks() {
        guard let data = try? Data(contentsOf: ClaudeHooksInstaller.settingsURL),
              let current = try? JSONDecoder().decode(JSONValue.self, from: data), ClaudeHooksInstaller.lacksAskHook(in: current) else { return }
        do { try ClaudeHooksInstaller.apply(installed: true, port: settings.hookPort) } catch { PultLog.write("hooks upgrade failed: \(error)") }
    }

    // MARK: - Codex

    private func refreshCodex() async {
        guard settings.codexEnabled else { codexSessions = []; merge(); return }
        do {
            if codex == nil {
                let client = CodexClient()
                try await client.start()
                codex = client
                codexVersion = client.serverInfo["userAgent"]?.string
                PultLog.write("codex app-server up: \(codexVersion ?? "?")")
            }
            guard let codex else { return }
            let (threads, _) = try await codex.listThreads(limit: 40, sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"])
            let cutoff = Date().addingTimeInterval(-Double(settings.codexDays) * 86_400)
            // Astra's threads live in the «Работа» tab.
            let astra = ComputerJobs.defaultWorkdir.path
            codexSessions = threads.filter { $0.updatedAt > cutoff && !$0.preview.hasPrefix("The following is the Codex agent history") }
                .map { HubSession(codex: $0) }.filter { ($0.cwd as NSString).standardizingPath != astra }
            codexError = nil
        } catch {
            codexError = "\(error)"
            PultLog.write("codex refresh failed: \(error)")
            codex?.stop(); codex = nil
        }
        merge()
    }

    private func merge() {
        let owned = Set(runs.compactMap(\.externalId))
        let others = (claudeSessions + codexSessions).filter { !owned.contains(String($0.id.split(separator: ":", maxSplits: 1).last ?? "")) }
        let replied = others.map { session -> HubSession in
            var session = session
            if session.agent == .claude { session.lastReply = lastReplies[String(session.id.dropFirst("claude:".count))] }
            return session
        }
        let merged = (runs.map(HubSession.init(run:)) + replied).sorted { a, b in
            if a.state != b.state { return a.state < b.state }
            return (a.updatedAt ?? .distantPast) > (b.updatedAt ?? .distantPast)
        }
        let changes = HubChange.compute(from: sessions, to: merged)
        sessions = merged
        lastRefresh = Date()
        if !changes.isEmpty { onChanges?(changes) }
    }
}

/// Append-only log the app can be checked against when it runs headless from the menu bar.
public enum PultLog {
    public static let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/VolnaPult.log")
    private static let queue = DispatchQueue(label: "pult.log")
    private static let formatter: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f }()

    public static func write(_ message: String) {
        let line = "\(formatter.string(from: Date())) \(message)\n"
        queue.async {
            if let handle = try? FileHandle(forWritingTo: url) {
                _ = try? handle.seekToEnd(); try? handle.write(contentsOf: Data(line.utf8)); try? handle.close()
            } else {
                try? Data(line.utf8).write(to: url)
            }
        }
    }
}
