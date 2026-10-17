import Foundation

/// A background task of the Volna bridge as the bridge reports it (`PUT /tasks/{id}`, `server/src/tasks/pult-sync.ts`):
/// research and plans done by the bridge's task model, and the bridge's side of Astra's jobs. Kept in memory only.
public struct BackgroundTask: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable { case think, computer }
    public enum Status: String, Sendable { case queued, running, done, failed, cancelled }

    public var id: String
    public var title: String
    public var kind: Kind
    public var status: Status
    public var progress: String?
    public var result: String?
    public var error: String?
    public var createdAt: Date
    public var finishedAt: Date?

    public init(id: String, title: String, kind: Kind, status: Status, progress: String? = nil, result: String? = nil,
                error: String? = nil, createdAt: Date, finishedAt: Date? = nil) {
        self.id = id; self.title = title; self.kind = kind; self.status = status; self.progress = progress
        self.result = result; self.error = error; self.createdAt = createdAt; self.finishedAt = finishedAt
    }

    public init?(id: String, json: JSONValue) {
        guard let title = json["title"]?.string, let status = json["status"]?.string.flatMap(Status.init(rawValue:)) else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = { (key: String) -> Date? in json[key]?.string.flatMap { formatter.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) } }
        self.init(id: id, title: String(title.prefix(120)), kind: json["kind"]?.string.flatMap(Kind.init(rawValue:)) ?? .think, status: status,
                  progress: json["progress"]?.string, result: json["result"]?.string.map { String($0.prefix(600)) },
                  error: json["error"]?.string, createdAt: date("createdAt") ?? Date(), finishedAt: date("finishedAt"))
    }

    public var isFinished: Bool { status == .done || status == .failed || status == .cancelled }
}

/// Bridge tasks by id: finished ones beyond the last `keep` are dropped; nothing survives a restart.
@MainActor
public final class BackgroundTasks {
    public static let keep = 10
    public private(set) var items: [BackgroundTask] = []
    public var onChange: (@MainActor () -> Void)?

    public init() {}

    public func upsert(_ task: BackgroundTask) {
        if let index = items.firstIndex(where: { $0.id == task.id }) { items[index] = task } else { items.append(task) }
        let finished = items.filter(\.isFinished).sorted { ($0.finishedAt ?? $0.createdAt) > ($1.finishedAt ?? $1.createdAt) }
        let drop = Set(finished.dropFirst(Self.keep).map(\.id))
        items.removeAll { drop.contains($0.id) }
        onChange?()
    }
}

/// One line of the «Работа» tab (docs/design/volna-pult-tabs.html).
public struct TaskRow: Identifiable, Equatable, Sendable {
    public enum Source: Sendable { case astra, bridge }
    public enum State: Int, Sendable, Comparable {
        case needsYou, working, done, failed
        public static func < (a: State, b: State) -> Bool { a.rawValue < b.rawValue }
    }

    public var id: String
    public var source: Source
    public var state: State
    public var title: String
    /// Second line: the pending app, «what is happening now», the first sentence of the result, or why it failed.
    public var line: String?
    public var startedAt: Date
    public var finishedAt: Date?
    /// Astra's thread in the Codex app.
    public var openURL: URL?
    /// Astra waits for this app; the owner answers in the panel, on the phone or in Codex.
    public var pendingApp: String?
    public var confirmationId: String?
}

public enum TaskBoard {
    /// Astra's jobs with the bridge's title and progress, then the bridge's own tasks. A computer task whose job Pult lost
    /// (Pult restarted) shows from the bridge's side, without a link.
    public static func rows(jobs: [ComputerJob], tasks: [BackgroundTask], confirmations: [Confirmation]) -> [TaskRow] {
        let byId = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let refs = Set(jobs.compactMap(\.ref))
        var rows: [TaskRow] = jobs.map { job in
            let task = job.ref.flatMap { byId[$0] }
            let state: TaskRow.State = switch job.state {
            case .needsYou: .needsYou
            case .starting, .working: .working
            case .done: .done
            case .failed, .cancelled: .failed
            }
            let confirmation = job.pendingApp.flatMap { app in
                confirmations.last { $0.kind == .computerApp && $0.app == app && $0.prompt == job.task && $0.state == .pending }
            }
            let line: String? = switch state {
            case .needsYou: job.pendingApp.map { "ждёт разрешения: \($0)" }
            case .working: job.progress ?? task?.progress
            case .done: firstSentence(job.reply)
            case .failed: job.state == .cancelled ? "Остановлено." : "Не получилось: \(job.error ?? "ошибка")."
            }
            return TaskRow(id: "job:" + job.id, source: .astra, state: state, title: task?.title ?? String(job.task.prefix(80)),
                           line: line, startedAt: job.createdAt, finishedAt: job.finishedAt, openURL: job.openURL,
                           pendingApp: job.pendingApp, confirmationId: confirmation?.id)
        }
        for task in tasks where !(task.kind == .computer && refs.contains(task.id)) {
            let state: TaskRow.State = switch task.status {
            case .queued, .running: .working
            case .done: .done
            case .failed, .cancelled: .failed
            }
            let line: String? = switch task.status {
            case .queued: "В очереди."
            case .running: task.progress
            case .done: firstSentence(task.result)
            case .cancelled: "Остановлено."
            case .failed: "Не получилось: \(task.error ?? "ошибка")."
            }
            rows.append(TaskRow(id: "task:" + task.id, source: .bridge, state: state, title: task.title, line: line,
                                startedAt: task.createdAt, finishedAt: task.finishedAt))
        }
        return rows.sorted { a, b in
            if a.state != b.state { return a.state < b.state }
            return (a.finishedAt ?? a.startedAt) > (b.finishedAt ?? b.startedAt)
        }
    }

    static func firstSentence(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        guard let end = text.firstIndex(where: { ".!?".contains($0) }) else { return String(text.prefix(160)) }
        return String(text[...end].prefix(160))
    }
}
