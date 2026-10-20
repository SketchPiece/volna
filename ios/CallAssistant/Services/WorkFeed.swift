import Foundation

/// The «Работа» list of the home screen: background tasks from the core (`GET /tasks`) and today's reminders
/// from the phone. Refreshed while the list is on screen; an unreachable core keeps the last known tasks.
@MainActor
final class WorkFeed: ObservableObject {
    @Published private(set) var items: [WorkItem] = []
    private let client: TasksClient
    private let store: DeviceToolStore
    private var tasks: [WorkTask] = []
    static let interval: Duration = .seconds(15)

    init(client: TasksClient = TasksClient(), store: DeviceToolStore = SystemDeviceToolStore()) {
        self.client = client
        self.store = store
    }

    /// Runs until cancelled: the view's `.task` owns it.
    func follow() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: Self.interval)
        }
    }

    func refresh() async {
        let now = Date()
        if MemoryPreferences.isPreviewRun {
            // Anchored at 9:41 like the sample conversations, the time of the screenshots' status bar.
            let now = min(now, Calendar.current.date(bySettingHour: 9, minute: 41, second: 0, of: now) ?? now)
            items = HomeCopy.workItems(tasks: Self.sampleTasks(now: now), reminders: Self.sampleReminders(now: now), now: now)
            return
        }
        if let fresh = try? await client.list() { tasks = fresh }
        var reminders: [HomeReminder] = []
        if Permissions.status(of: .reminders) == .granted, let today = try? await store.reminders(scope: .today, now: now) {
            reminders = today.map { HomeReminder(id: $0.id, title: $0.title, due: $0.due) }
        }
        items = HomeCopy.workItems(tasks: tasks, reminders: reminders, now: now)
    }

    private static func sampleTasks(now: Date) -> [WorkTask] {
        [
            WorkTask(id: "s1", title: "Чиню экспорт в «Заметках»", status: "running", createdAt: now.addingTimeInterval(-720), startedAt: now.addingTimeInterval(-720)),
            WorkTask(id: "s2", title: "Обновляю зависимости в боте", status: "running", createdAt: now.addingTimeInterval(-180), startedAt: now.addingTimeInterval(-180)),
            WorkTask(id: "s3", title: "Команды бота", status: "running", waiting: .init(kind: "question", text: "Удалить старые команды бота?"), createdAt: now.addingTimeInterval(-900)),
            WorkTask(id: "s4", title: "Тесты ядра снова зелёные", status: "done", createdAt: now.addingTimeInterval(-7200), finishedAt: now.addingTimeInterval(-5400)),
        ]
    }
    private static func sampleReminders(now: Date) -> [HomeReminder] {
        [HomeReminder(id: "r1", title: "Ответить Ольге про смету", due: Calendar.current.date(bySettingHour: 18, minute: 0, second: 0, of: now))]
    }
}

/// HTTP to `/tasks` of the core with the core token.
struct TasksClient {
    var settings = ConnectionSettings()
    var session: URLSession = .shared

    func list() async throws -> [WorkTask] {
        let url = try settings.sessionURL().deletingLastPathComponent().appendingPathComponent("tasks")
        var request = URLRequest(url: url, timeoutInterval: 8)
        let token = settings.token
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw VoiceError.message("Задания недоступны.") }
        return try Self.decoder.decode(Body.self, from: data).tasks
    }

    private struct Body: Decodable { var tasks: [WorkTask] }
    /// The core writes `toISOString()`, with milliseconds.
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: text) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Bad date \(text)"))
        }
        return decoder
    }()
}
