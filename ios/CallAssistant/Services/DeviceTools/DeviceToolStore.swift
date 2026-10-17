import Foundation
import EventKit
import Contacts

/// What device tools need from the phone. `SystemDeviceToolStore` talks to EventKit and Contacts; tests use a fake.
protocol DeviceToolStore: AnyObject {
    func createReminder(title: String, due: Date?, notes: String?) throws -> ReminderItem
    /// Incomplete reminders in the scope, soonest first. Title filtering is done by the runner.
    func reminders(scope: ReminderScope, now: Date) async throws -> [ReminderItem]
    /// Nil when no reminder has this id.
    func completeReminder(id: String) throws -> ReminderItem?
    func createEvent(title: String, start: Date, end: Date, allDay: Bool, location: String?, notes: String?) throws -> EventItem
    func events(from: Date, to: Date) throws -> [EventItem]
    func findContacts(name: String) throws -> [ContactItem]
}

/// EventKit and Contacts. Works in the background during a CallKit call, so Siri-from-lock-screen requests reach the real apps.
final class SystemDeviceToolStore: DeviceToolStore {
    private let events = EKEventStore()
    private let contacts = CNContactStore()

    func createReminder(title: String, due: Date?, notes: String?) throws -> ReminderItem {
        let reminder = EKReminder(eventStore: events)
        reminder.title = title
        reminder.notes = notes
        guard let list = events.defaultCalendarForNewReminders() else { throw DeviceToolError.failed }
        reminder.calendar = list
        if let due {
            var components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
            components.timeZone = .current
            reminder.dueDateComponents = components
            reminder.addAlarm(EKAlarm(absoluteDate: due))
        }
        try events.save(reminder, commit: true)
        return item(reminder)
    }

    func reminders(scope: ReminderScope, now: Date) async throws -> [ReminderItem] {
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: now)
        let endOfToday = calendar.date(byAdding: .day, value: 1, to: startOfToday)
        let predicate: NSPredicate
        switch scope {
        case .today: predicate = events.predicateForIncompleteReminders(withDueDateStarting: startOfToday, ending: endOfToday, calendars: nil)
        case .overdue: predicate = events.predicateForIncompleteReminders(withDueDateStarting: nil, ending: now, calendars: nil)
        case .upcoming: predicate = events.predicateForIncompleteReminders(withDueDateStarting: now, ending: calendar.date(byAdding: .day, value: 7, to: now), calendars: nil)
        case .open: predicate = events.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        }
        let found: [EKReminder] = await withCheckedContinuation { continuation in
            events.fetchReminders(matching: predicate) { continuation.resume(returning: $0 ?? []) }
        }
        return found.map(item).sorted { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }
    }

    func completeReminder(id: String) throws -> ReminderItem? {
        guard let reminder = events.calendarItem(withIdentifier: id) as? EKReminder else { return nil }
        reminder.isCompleted = true
        try events.save(reminder, commit: true)
        return item(reminder)
    }

    func createEvent(title: String, start: Date, end: Date, allDay: Bool, location: String?, notes: String?) throws -> EventItem {
        let event = EKEvent(eventStore: events)
        event.title = title
        event.startDate = start
        event.endDate = end
        event.isAllDay = allDay
        event.location = location
        event.notes = notes
        guard let calendar = events.defaultCalendarForNewEvents else { throw DeviceToolError.failed }
        event.calendar = calendar
        if !allDay { event.addAlarm(EKAlarm(relativeOffset: -10 * 60)) }
        try events.save(event, span: .thisEvent, commit: true)
        return item(event)
    }

    func events(from: Date, to: Date) throws -> [EventItem] {
        let predicate = events.predicateForEvents(withStart: from, end: to, calendars: nil)
        return events.events(matching: predicate).sorted { $0.startDate < $1.startDate }.prefix(15).map(item)
    }

    func findContacts(name: String) throws -> [ContactItem] {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactEmailAddressesKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor
        ]
        let found = try contacts.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: name), keysToFetch: keys)
        return found.prefix(3).map { contact in
            ContactItem(
                name: CNContactFormatter.string(from: contact, style: .fullName) ?? name,
                emails: contact.emailAddresses.map { String($0.value) },
                phones: contact.phoneNumbers.map { $0.value.stringValue }
            )
        }
    }

    private func item(_ reminder: EKReminder) -> ReminderItem {
        let due = reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
        return ReminderItem(id: reminder.calendarItemIdentifier, title: reminder.title ?? "", due: due, list: reminder.calendar?.title ?? "")
    }

    private func item(_ event: EKEvent) -> EventItem {
        EventItem(id: event.eventIdentifier ?? event.calendarItemIdentifier, title: event.title ?? "", start: event.startDate, end: event.endDate,
                  allDay: event.isAllDay, location: event.location, calendar: event.calendar?.title ?? "")
    }
}
