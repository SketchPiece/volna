import Foundation

/// What the middle of the idle screen shows (docs/design/canvas/home-idle, board «Д»). Chosen in Settings.
enum HomeMode: String, CaseIterable, Sendable {
    case talks, work
    static let `default`: HomeMode = .talks
}

/// A background task as `GET /tasks` of the core returns it (core/src/http/task-routes.ts).
struct WorkTask: Equatable, Sendable, Decodable {
    struct Waiting: Equatable, Sendable, Decodable {
        var kind: String
        var text: String
    }
    var id: String
    var title: String
    var status: String
    var waiting: Waiting?
    var progress: String?
    var createdAt: Date
    var startedAt: Date?
    var finishedAt: Date?
}

/// A reminder due today, from the phone's Reminders.
struct HomeReminder: Equatable, Sendable {
    var id: String
    var title: String
    var due: Date?
}

/// One row of the «Работа» list: a lamp, a short mono key and the text.
struct WorkItem: Equatable, Sendable, Identifiable {
    var id: String
    var lamp: LampState
    /// A running task blinks its lamp.
    var blinking = false
    var key: String
    var text: String
}

/// Texts and ordering of the home screen lists.
enum HomeCopy {
    /// Rows the screen shows: six fit between the title and the call key on every supported iPhone.
    static let rows = 6

    static let modeHeader = "Главный экран"
    /// The empty home screen (docs/design/canvas/home-empty, board «Г»): before the first conversation,
    /// and in «Работа» when nothing is going on.
    static let firstCallTitle = "Первый выход в эфир"
    static let firstCallText = "Позвони и спроси что угодно."
    static let noWorkTitle = "Эфир свободен"
    static let noWorkText = "Долгое дело можно поручить в разговоре. Оно появится здесь."
    static func modeTitle(_ mode: HomeMode) -> String {
        switch mode {
        case .talks: return "Разговоры"
        case .work: return "Работа"
        }
    }

    /// «Сегодня, 9:12 · 3 мин», «Вчера, 21:40 · 1 мин», «Пн, 22:30 · 11 мин», «12 сент., 10:00 · 2 мин».
    static func callKey(_ record: CallRecord, now: Date, calendar: Calendar = .current) -> String {
        let minutes = max(1, Int((record.duration / 60).rounded()))
        return "\(day(record.startedAt, now: now, calendar: calendar)), \(time(record.startedAt, calendar: calendar)) · \(minutes) мин"
    }

    /// Waiting questions first, then running and queued work, today's reminders by time, and what finished in the last day.
    static func workItems(tasks: [WorkTask], reminders: [HomeReminder], now: Date, calendar: Calendar = .current) -> [WorkItem] {
        var items: [WorkItem] = []
        for task in tasks {
            guard let waiting = task.waiting else { continue }
            items.append(WorkItem(id: task.id, lamp: .on,
                                  key: waiting.kind == "question" ? "Ждёт ответа" : "Ждёт разрешения",
                                  text: waiting.kind == "question" ? waiting.text : task.title))
        }
        let open = tasks.filter { $0.waiting == nil }
        for task in open where task.status == "running" {
            let minutes = Int(now.timeIntervalSince(task.startedAt ?? task.createdAt) / 60)
            items.append(WorkItem(id: task.id, lamp: .hot, blinking: true, key: minutes >= 1 ? "Работа · \(minutes) мин" : "Работа", text: task.title))
        }
        for task in open where task.status == "queued" {
            items.append(WorkItem(id: task.id, lamp: .on, key: "В очереди", text: task.title))
        }
        for reminder in reminders.sorted(by: { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }) {
            // A reminder without a time comes back due at midnight.
            let key: String
            if let due = reminder.due, calendar.startOfDay(for: due) != due { key = "Сегодня · \(time(due, calendar: calendar))" } else { key = "Сегодня" }
            items.append(WorkItem(id: "reminder-\(reminder.id)", lamp: .on, key: key, text: reminder.title))
        }
        let finished = open.filter { ["done", "failed", "cancelled"].contains($0.status) }
            .sorted { ($0.finishedAt ?? $0.createdAt) > ($1.finishedAt ?? $1.createdAt) }
        for task in finished {
            let label = task.status == "done" ? "Готово" : task.status == "failed" ? "Не вышло" : "Отменено"
            let key = task.finishedAt.map { "\(label) · \(time($0, calendar: calendar))" } ?? label
            items.append(WorkItem(id: task.id, lamp: .off, key: key, text: task.title))
        }
        return Array(items.prefix(rows))
    }

    private static func day(_ date: Date, now: Date, calendar: Calendar) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "Сегодня" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Вчера" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        if days < 7 {
            formatter.dateFormat = "EEEEEE"
            return formatter.string(from: date).capitalized
        }
        formatter.dateFormat = "d MMM"
        return formatter.string(from: date)
    }

    private static func time(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}
