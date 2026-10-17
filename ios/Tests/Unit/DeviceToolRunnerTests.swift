import XCTest
@testable import CallAssistant

/// Fake phone: remembers what was created and answers from fixed data. No EventKit, so it runs on any simulator.
private final class FakeStore: DeviceToolStore {
    var reminders: [ReminderItem] = []
    var events: [EventItem] = []
    var contacts: [ContactItem] = []
    var completed: [String] = []
    var createdEvents: [(title: String, start: Date, end: Date, allDay: Bool)] = []

    func createReminder(title: String, due: Date?, notes: String?) throws -> ReminderItem {
        let item = ReminderItem(id: "r\(reminders.count + 1)", title: title, due: due, list: "Напоминания")
        reminders.append(item)
        return item
    }
    func reminders(scope: ReminderScope, now: Date) async throws -> [ReminderItem] { reminders }
    func completeReminder(id: String) throws -> ReminderItem? {
        guard let item = reminders.first(where: { $0.id == id }) else { return nil }
        completed.append(id)
        return item
    }
    func createEvent(title: String, start: Date, end: Date, allDay: Bool, location: String?, notes: String?) throws -> EventItem {
        createdEvents.append((title, start, end, allDay))
        return EventItem(id: "e1", title: title, start: start, end: end, allDay: allDay, location: location, calendar: "Календарь")
    }
    func events(from: Date, to: Date) throws -> [EventItem] { events.filter { $0.start >= from && $0.start < to } }
    func findContacts(name: String) throws -> [ContactItem] { contacts.filter { $0.name.lowercased().contains(name.lowercased()) } }
}

@MainActor
final class DeviceToolRunnerTests: XCTestCase {
    private let now = DeviceDates.parse("2026-09-22T12:00:00+03:00")!

    private func call(_ name: DeviceToolName, _ json: String) -> DeviceToolCall {
        DeviceToolCall(callID: "c", name: name, arguments: Data(json.utf8))
    }
    private func runner(_ store: FakeStore, granted: Set<DevicePermission> = Set(DevicePermission.allCases)) -> DeviceToolRunner {
        DeviceToolRunner(store: store, isGranted: { granted.contains($0) }, now: { self.now })
    }
    private func assertError(_ output: String, _ expected: String, line: UInt = #line) {
        XCTAssertEqual(object(output)["error"] as? String, expected, line: line)
    }
    private func object(_ json: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
    }

    func testAnnouncedNamesFollowGrantedPermissions() {
        XCTAssertEqual(runner(FakeStore(), granted: [.calendar]).availableNames(), ["create_event", "list_events"])
        XCTAssertEqual(runner(FakeStore(), granted: []).availableNames(), [])
        XCTAssertEqual(runner(FakeStore()).availableNames().count, DeviceToolName.allCases.count)
    }

    func testCreateReminderParsesOffsetDatesAndEchoesTheItem() async {
        let store = FakeStore()
        let output = object(await runner(store).run(call(.createReminder, #"{"title":"Позвонить маме","due":"2026-09-23T09:00:00+03:00","notes":null}"#)))
        XCTAssertEqual(output["title"] as? String, "Позвонить маме")
        XCTAssertEqual(output["list"] as? String, "Напоминания")
        XCTAssertEqual(store.reminders.first?.due, DeviceDates.parse("2026-09-23T09:00:00+03:00"))
        XCTAssertEqual(DeviceDates.parse(output["due"] as! String), store.reminders.first?.due)
    }

    func testMissingPermissionAndBadArgumentsBecomeStructuredErrors() async {
        let store = FakeStore()
        await assertError(runner(store, granted: []).run(call(.createReminder, #"{"title":"x"}"#)), "permission_denied")
        await assertError(runner(store).run(call(.createReminder, #"{"title":""}"#)), "invalid_arguments")
        await assertError(runner(store).run(call(.createReminder, #"not json"#)), "invalid_arguments")
        await assertError(runner(store).run(call(.createEvent, #"{"title":"x","start":"вчера"}"#)), "invalid_arguments")
        XCTAssertTrue(store.reminders.isEmpty)
    }

    func testCompleteReminderByQueryNeedsExactlyOneMatch() async {
        let store = FakeStore()
        store.reminders = [
            ReminderItem(id: "r1", title: "Купить молоко", due: nil, list: "Дом"),
            ReminderItem(id: "r2", title: "Купить хлеб", due: nil, list: "Дом")
        ]
        let ambiguous = object(await runner(store).run(call(.completeReminder, #"{"query":"купить"}"#)))
        XCTAssertEqual(ambiguous["error"] as? String, "ambiguous")
        XCTAssertEqual((ambiguous["candidates"] as? [[String: Any]])?.count, 2)
        XCTAssertTrue(store.completed.isEmpty)

        let done = object(await runner(store).run(call(.completeReminder, #"{"query":"молоко"}"#)))
        XCTAssertEqual((done["completed"] as? [String: Any])?["id"] as? String, "r1")
        XCTAssertEqual(store.completed, ["r1"])

        await assertError(runner(store).run(call(.completeReminder, #"{"id":"nope"}"#)), "not_found")
        await assertError(runner(store).run(call(.completeReminder, #"{"query":"пылесос"}"#)), "not_found")
    }

    func testListRemindersFiltersByQueryAndCapsAtTen() async {
        let store = FakeStore()
        store.reminders = (1...12).map { ReminderItem(id: "r\($0)", title: "Дело \($0)", due: nil, list: "Дом") }
        let all = object(await runner(store).run(call(.listReminders, #"{}"#)))
        XCTAssertEqual((all["reminders"] as? [Any])?.count, 10)
        let filtered = object(await runner(store).run(call(.listReminders, #"{"scope":"today","query":"дело 1"}"#)))
        XCTAssertEqual((filtered["reminders"] as? [[String: Any]])?.map { $0["id"] as? String }, ["r1", "r10", "r11", "r12"])
    }

    func testCreateEventDefaultsToOneHourAndNormalisesAllDay() async {
        let store = FakeStore()
        _ = await runner(store).run(call(.createEvent, #"{"title":"Встреча с Димой","start":"2026-09-24T15:00:00+03:00"}"#))
        XCTAssertEqual(store.createdEvents.last?.end.timeIntervalSince(store.createdEvents.last!.start), 3600)

        _ = await runner(store).run(call(.createEvent, #"{"title":"День рождения","start":"2026-09-25T10:00:00+03:00","allDay":true}"#))
        let allDay = store.createdEvents.last!
        XCTAssertTrue(allDay.allDay)
        XCTAssertEqual(allDay.start, Calendar.current.startOfDay(for: allDay.start))
        XCTAssertEqual(allDay.end.timeIntervalSince(allDay.start), 86_400, accuracy: 3700)

        await assertError(runner(store).run(call(.createEvent, #"{"title":"x","start":"2026-09-24T15:00:00+03:00","end":"2026-09-24T14:00:00+03:00"}"#)), "invalid_arguments")
    }

    func testListEventsDefaultsToTodayInDeviceTime() async {
        let store = FakeStore()
        let today = Calendar.current.startOfDay(for: now).addingTimeInterval(15 * 3600)
        store.events = [
            EventItem(id: "e1", title: "Сегодня", start: today, end: today.addingTimeInterval(1800), allDay: false, location: nil, calendar: "К"),
            EventItem(id: "e2", title: "Через неделю", start: today.addingTimeInterval(7 * 86_400), end: today.addingTimeInterval(7 * 86_400 + 1800), allDay: false, location: nil, calendar: "К")
        ]
        let output = object(await runner(store).run(call(.listEvents, #"{}"#)))
        XCTAssertEqual((output["events"] as? [[String: Any]])?.map { $0["id"] as? String }, ["e1"])
    }

    func testFindContactReturnsMatchesOnly() async {
        let store = FakeStore()
        store.contacts = [ContactItem(name: "Маша Иванова", emails: ["m@example.com"], phones: []), ContactItem(name: "Дима", emails: [], phones: ["+7"])]
        let output = object(await runner(store).run(call(.findContact, #"{"name":"маша"}"#)))
        XCTAssertEqual((output["contacts"] as? [[String: Any]])?.count, 1)
        await assertError(runner(store).run(call(.findContact, #"{"name":"  "}"#)), "invalid_arguments")
    }

    func testDatesWithoutOffsetAreLocalAndOutputCarriesDeviceOffset() {
        let local = DeviceDates.parse("2026-09-23T09:00")!
        let components = Calendar.current.dateComponents([.hour, .minute], from: local)
        XCTAssertEqual(components.hour, 9)
        XCTAssertEqual(components.minute, 0)
        XCTAssertEqual(DeviceDates.parse(DeviceDates.format(local)), local)
        XCTAssertNil(DeviceDates.parse("завтра"))
    }
}

/// Phone tools relayed by the core in its own delegation mode: the same runner answers them.
@MainActor
final class DeviceToolRelayTests: XCTestCase {
    func testRelayedCallsDecodeAndRunThroughTheRunner() async throws {
        let data = Data(#"{"calls":[{"id":"0123456789abcdef0123456789abcdef","name":"create_reminder","arguments":"{\"title\":\"Молоко\"}"},{"id":"fedcba9876543210fedcba9876543210","name":"agents_list","arguments":"{}"}]}"#.utf8)
        let poll = try DeviceToolRelay.poll(from: data)
        XCTAssertNil(poll.working, "an older core sends no running work")
        let calls = poll.calls
        XCTAssertEqual(calls.map(\.name), ["create_reminder", "agents_list"])
        let call = try XCTUnwrap(DeviceToolRelay.toolCall(calls[0]))
        XCTAssertEqual(call.callID, calls[0].id)
        XCTAssertEqual(call.name, .createReminder)
        XCTAssertNil(DeviceToolRelay.toolCall(calls[1]), "core tools are not the phone's")

        let store = FakeStore()
        let output = await DeviceToolRunner(store: store, isGranted: { _ in true }).run(call)
        XCTAssertEqual(store.reminders.map(\.title), ["Молоко"])
        XCTAssertTrue(output.contains("Молоко"))
    }

    func testPollCarriesRunningWork() throws {
        let poll = try DeviceToolRelay.poll(from: Data(#"{"calls":[],"working":["bd2d3b9a176efdba"]}"#.utf8))
        XCTAssertEqual(poll, .init(calls: [], working: ["bd2d3b9a176efdba"]))
    }
}
