import XCTest
@testable import CallAssistant

final class HomeTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Moscow")!
        return calendar
    }()
    /// Saturday 26 September 2026, 12:00 in Moscow.
    private let now = ISO8601DateFormatter().date(from: "2026-09-26T09:00:00Z")!

    private func line(_ speaker: TranscriptLine.Speaker, _ text: String, _ id: Int = 0) -> TranscriptLine {
        TranscriptLine(id: id, speaker: speaker, text: text, offset: Double(id))
    }

    func testTitleIsTheOwnersFirstRealRequest() {
        let lines = [line(.wave, "Слушаю.", 0), line(.you, "Привет", 1), line(.you, "что купить к ужину на шестерых? и вина", 2)]
        XCTAssertEqual(CallRecord.title(for: lines), "Что купить к ужину на шестерых")
    }

    func testTitleFallsBackAndStaysShort() {
        XCTAssertEqual(CallRecord.title(for: [line(.wave, "Слушаю."), line(.you, "Привет", 1)]), "Привет")
        XCTAssertEqual(CallRecord.title(for: [line(.wave, "Слушаю.")]), "Слушаю")
        let long = String(repeating: "очень длинная просьба ", count: 8)
        let title = CallRecord.title(for: [line(.you, long)])
        XCTAssertLessThanOrEqual(title.count, CallRecord.maxTitle + 1)
        XCTAssertTrue(title.hasSuffix("…"))
    }

    func testOnlyAnsweredRealCallsWithWordsAreKept() {
        var state = CallState()
        state.phase = .speaking
        state.startedAt = now.addingTimeInterval(-185)
        state.lines = [line(.you, "Перенеси встречу с Олегом на пятницу")]
        let record = CallRecord.finished(state, at: now)
        XCTAssertEqual(record?.duration, 185)
        XCTAssertEqual(record?.title, "Перенеси встречу с Олегом на пятницу")

        var demo = state; demo.isDemo = true
        XCTAssertNil(CallRecord.finished(demo, at: now))
        var unanswered = state; unanswered.startedAt = nil
        XCTAssertNil(CallRecord.finished(unanswered, at: now))
        var silent = state; silent.lines = [line(.you, "  ")]
        XCTAssertNil(CallRecord.finished(silent, at: now))
    }

    func testCallKeyNamesTheDay() {
        func key(daysAgo: Double, hour: Int, minutes: Double) -> String {
            let day = calendar.date(byAdding: .day, value: -Int(daysAgo), to: now)!
            let start = calendar.date(bySettingHour: hour, minute: 12, second: 0, of: day)!
            return HomeCopy.callKey(CallRecord(id: UUID(), startedAt: start, duration: minutes * 60, title: "", lines: []), now: now, calendar: calendar)
        }
        XCTAssertEqual(key(daysAgo: 0, hour: 9, minutes: 3), "Сегодня, 9:12 · 3 мин")
        XCTAssertEqual(key(daysAgo: 1, hour: 21, minutes: 0.2), "Вчера, 21:12 · 1 мин")
        XCTAssertEqual(key(daysAgo: 5, hour: 22, minutes: 11), "Пн, 22:12 · 11 мин")
        XCTAssertTrue(key(daysAgo: 20, hour: 10, minutes: 2).hasPrefix("6 сент"))
    }

    func testWorkListOrdersQuestionsRunningRemindersThenFinished() {
        let tasks = [
            WorkTask(id: "done", title: "Сводка", status: "done", createdAt: now.addingTimeInterval(-7200), finishedAt: calendar.date(bySettingHour: 10, minute: 5, second: 0, of: now)),
            WorkTask(id: "run", title: "Тарифы", status: "running", createdAt: now.addingTimeInterval(-800), startedAt: now.addingTimeInterval(-720)),
            WorkTask(id: "ask", title: "Подарок", status: "running", waiting: .init(kind: "question", text: "Какой бюджет?"), createdAt: now),
            WorkTask(id: "wait", title: "Билеты", status: "queued", createdAt: now),
        ]
        let reminders = [
            HomeReminder(id: "r2", title: "Без времени", due: calendar.startOfDay(for: now)),
            HomeReminder(id: "r1", title: "Банк", due: calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now)),
        ]
        let items = HomeCopy.workItems(tasks: tasks, reminders: reminders, now: now, calendar: calendar)
        XCTAssertEqual(items.map(\.key), ["Ждёт ответа", "Работа · 12 мин", "В очереди", "Сегодня", "Сегодня · 18:00", "Готово · 10:05"])
        XCTAssertEqual(items[0].text, "Какой бюджет?")
        XCTAssertEqual(items[1].lamp, .hot)
        XCTAssertTrue(items[1].blinking)
        XCTAssertEqual(items.last?.lamp, .off)
    }

    func testWorkListShowsAtMostSixRows() {
        let tasks = (0..<9).map { WorkTask(id: "t\($0)", title: "Задание \($0)", status: "queued", createdAt: now) }
        XCTAssertEqual(HomeCopy.workItems(tasks: tasks, reminders: [], now: now, calendar: calendar).count, HomeCopy.rows)
    }

    func testBridgeTaskDatesWithMillisecondsDecode() throws {
        let json = #"{"tasks":[{"id":"a","title":"Т","status":"running","waiting":null,"progress":null,"createdAt":"2026-09-26T08:00:00.123Z","startedAt":null,"finishedAt":null}]}"#
        struct Body: Decodable { var tasks: [WorkTask] }
        let body = try TasksClient.decoder.decode(Body.self, from: Data(json.utf8))
        XCTAssertEqual(body.tasks.first?.title, "Т")
    }

    @MainActor func testBridgeTitleReplacesTheFirstRequestAndIsSaved() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("calls-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = CallHistoryStore(url: url, titles: nil)
        let record = CallRecord(id: UUID(), startedAt: now, duration: 60, title: "Привет, слушай, что взять к ужину", lines: [line(.you, "Привет")])
        store.add(record)
        store.retitle(record.id, "Ужин на шестерых")
        store.retitle(UUID(), "Чужой")
        XCTAssertEqual(store.records.map(\.title), ["Ужин на шестерых"])
        XCTAssertEqual(CallHistoryStore(url: url, titles: nil).records.first?.title, "Ужин на шестерых")
    }
}
