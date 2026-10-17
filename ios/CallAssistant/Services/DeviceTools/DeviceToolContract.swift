import Foundation

/// Which system permission a device tool needs. The settings screen shows one row per case.
enum DevicePermission: String, CaseIterable, Hashable {
    case reminders, calendar, contacts
}

/// Tools the phone executes itself. Names, arguments and results mirror `core/src/assistant/tools/device.ts`;
/// change both together. The core declares them to the model only when the app announces them in `X-Device-Tools`.
enum DeviceToolName: String, CaseIterable {
    case createReminder = "create_reminder"
    case listReminders = "list_reminders"
    case completeReminder = "complete_reminder"
    case createEvent = "create_event"
    case listEvents = "list_events"
    case findContact = "find_contact"

    var permission: DevicePermission {
        switch self {
        case .createReminder, .listReminders, .completeReminder: return .reminders
        case .createEvent, .listEvents: return .calendar
        case .findContact: return .contacts
        }
    }

    static func names(for granted: Set<DevicePermission>) -> [String] {
        allCases.filter { granted.contains($0.permission) }.map(\.rawValue)
    }
}

/// One phone tool call relayed by the core (`DeviceToolRelay`); `callID` is the core's id for the answer.
struct DeviceToolCall: Equatable {
    let callID: String
    let name: DeviceToolName
    let arguments: Data
}

// MARK: - Arguments (decoded from the model)

enum ReminderScope: String, Decodable { case today, overdue, upcoming, open }

struct CreateReminderArguments: Decodable { var title: String; var due: String?; var notes: String? }
struct ListRemindersArguments: Decodable { var scope: ReminderScope?; var query: String? }
struct CompleteReminderArguments: Decodable { var id: String?; var query: String? }
struct CreateEventArguments: Decodable {
    var title: String; var start: String; var end: String?; var allDay: Bool?; var location: String?; var notes: String?
}
struct ListEventsArguments: Decodable { var from: String?; var to: String? }
struct FindContactArguments: Decodable { var name: String }

// MARK: - Results (encoded for the model)

struct ReminderItem: Encodable, Equatable {
    var id: String
    var title: String
    var due: Date?
    var list: String
}

struct EventItem: Encodable, Equatable {
    var id: String
    var title: String
    var start: Date
    var end: Date
    var allDay: Bool
    var location: String?
    var calendar: String
}

struct ContactItem: Encodable, Equatable {
    var name: String
    var emails: [String]
    var phones: [String]
}

/// Failures the model can explain to the user. Messages never include system error text.
enum DeviceToolError: Error, Equatable {
    case permissionDenied
    case invalidArguments(String)
    case notFound
    case ambiguous([ReminderItem])
    case failed

    var payload: [String: Any] {
        switch self {
        case .permissionDenied: return ["error": "permission_denied", "hint": "Доступ включается в настройках Волны."]
        case let .invalidArguments(detail): return ["error": "invalid_arguments", "detail": detail]
        case .notFound: return ["error": "not_found"]
        case let .ambiguous(items): return ["error": "ambiguous", "candidates": items.map { ["id": $0.id, "title": $0.title, "due": $0.due.map(DeviceDates.format) as Any] }]
        case .failed: return ["error": "tool_failed"]
        }
    }
}

/// ISO 8601 in and out. The model writes offsets; a timestamp without one is taken as the device's local time.
enum DeviceDates {
    static func parse(_ text: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        if let date = iso.date(from: text) { return date }
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: text) { return date }
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        local.timeZone = .current
        for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"] {
            local.dateFormat = format
            if let date = local.date(from: text) { return date }
        }
        return nil
    }

    static func format(_ date: Date) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        iso.timeZone = .current
        return iso.string(from: date)
    }

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(format(date))
        }
        return encoder
    }
}
