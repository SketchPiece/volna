import Foundation

/// Executes device tool calls addressed to the phone and produces the JSON the model reads.
/// Decides nothing about the conversation: the coordinator hands it calls and sends its output back.
@MainActor
final class DeviceToolRunner {
    private let store: DeviceToolStore
    private let isGranted: (DevicePermission) -> Bool
    private let now: () -> Date

    init(store: DeviceToolStore, isGranted: @escaping (DevicePermission) -> Bool = { Permissions.status(of: $0) == .granted }, now: @escaping () -> Date = Date.init) {
        self.store = store
        self.isGranted = isGranted
        self.now = now
    }

    /// Names to announce to the core for this call: only tools whose permission is already granted.
    func availableNames() -> [String] {
        DeviceToolName.names(for: Set(DevicePermission.allCases.filter(isGranted)))
    }

    /// Always returns a JSON string; failures go to the model as `{ "error": … }` so it can say what happened.
    func run(_ call: DeviceToolCall) async -> String {
        do {
            guard isGranted(call.name.permission) else { throw DeviceToolError.permissionDenied }
            return try await execute(call)
        } catch let error as DeviceToolError {
            return encode(error.payload)
        } catch {
            return encode(DeviceToolError.failed.payload)
        }
    }

    private func execute(_ call: DeviceToolCall) async throws -> String {
        switch call.name {
        case .createReminder:
            let args: CreateReminderArguments = try decode(call.arguments)
            let title = args.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { throw DeviceToolError.invalidArguments("title is empty") }
            let due = try args.due.map(date)
            return try encode(store.createReminder(title: title, due: due, notes: args.notes))

        case .listReminders:
            let args: ListRemindersArguments = try decode(call.arguments)
            let items = try await matchingReminders(scope: args.scope ?? .open, query: args.query)
            return try encode(["reminders": Array(items.prefix(10))])

        case .completeReminder:
            let args: CompleteReminderArguments = try decode(call.arguments)
            if let id = args.id, !id.isEmpty {
                guard let done = try store.completeReminder(id: id) else { throw DeviceToolError.notFound }
                return try encode(["completed": done])
            }
            guard let query = args.query, !query.trimmingCharacters(in: .whitespaces).isEmpty else { throw DeviceToolError.invalidArguments("id or query required") }
            let matches = try await matchingReminders(scope: .open, query: query)
            guard let only = matches.first else { throw DeviceToolError.notFound }
            guard matches.count == 1 else { throw DeviceToolError.ambiguous(Array(matches.prefix(3))) }
            guard let done = try store.completeReminder(id: only.id) else { throw DeviceToolError.notFound }
            return try encode(["completed": done])

        case .createEvent:
            let args: CreateEventArguments = try decode(call.arguments)
            let title = args.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { throw DeviceToolError.invalidArguments("title is empty") }
            let allDay = args.allDay ?? false
            var start = try date(args.start)
            var end = try args.end.map(date) ?? start.addingTimeInterval(3600)
            if allDay {
                start = Calendar.current.startOfDay(for: start)
                end = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: end)) ?? start.addingTimeInterval(86_400)
            }
            guard end > start else { throw DeviceToolError.invalidArguments("end must be after start") }
            return try encode(store.createEvent(title: title, start: start, end: end, allDay: allDay, location: args.location, notes: args.notes))

        case .listEvents:
            let args: ListEventsArguments = try decode(call.arguments)
            let from = try args.from.map(date) ?? Calendar.current.startOfDay(for: now())
            let to = try args.to.map(date) ?? Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: from)) ?? from.addingTimeInterval(86_400)
            guard to > from else { throw DeviceToolError.invalidArguments("to must be after from") }
            return try encode(["events": try store.events(from: from, to: to)])

        case .findContact:
            let args: FindContactArguments = try decode(call.arguments)
            let name = args.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { throw DeviceToolError.invalidArguments("name is empty") }
            return try encode(["contacts": try store.findContacts(name: name)])
        }
    }

    private func matchingReminders(scope: ReminderScope, query: String?) async throws -> [ReminderItem] {
        let items = try await store.reminders(scope: scope, now: now())
        guard let query = query?.trimmingCharacters(in: .whitespaces), !query.isEmpty else { return items }
        let words = query.lowercased().split(separator: " ").map(String.init)
        return items.filter { item in
            let title = item.title.lowercased()
            return words.allSatisfy { title.contains($0) }
        }
    }

    private func date(_ text: String) throws -> Date {
        guard let date = DeviceDates.parse(text) else { throw DeviceToolError.invalidArguments("bad date: \(text)") }
        return date
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw DeviceToolError.invalidArguments("arguments do not match the schema") }
    }

    private func encode<T: Encodable>(_ value: T) throws -> String {
        String(decoding: try DeviceDates.encoder().encode(value), as: UTF8.self)
    }

    private func encode(_ payload: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return #"{"error":"tool_failed"}"# }
        return String(decoding: data, as: UTF8.self)
    }
}
