import Foundation
import AVFAudio
import Intents
import UIKit
import EventKit
import Contacts

/// Microphone and Siri permissions. Prompts only when the app is in the foreground.
@MainActor
enum Permissions {
    static var microphoneGranted: Bool { AVAudioApplication.shared.recordPermission == .granted }
    static var siriGranted: Bool { INPreferences.siriAuthorizationStatus() == .authorized }

    /// Grants silently when already decided; prompts only if the decision is pending and the app is active,
    /// because a system-call handoff from the lock screen cannot show a prompt.
    static func ensureMicrophone() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .undetermined where UIApplication.shared.applicationState == .active:
            return await AVAudioApplication.requestRecordPermission()
        default: return false
        }
    }

    static func requestMicrophone() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    static func requestSiri() async -> Bool {
        await withCheckedContinuation { continuation in
            INPreferences.requestSiriAuthorization { status in continuation.resume(returning: status == .authorized) }
        }
    }
}

/// State of a device-tool permission as the settings row shows it.
enum DevicePermissionStatus: Equatable { case granted, denied, undetermined }

extension Permissions {
    /// Full access is required: reminders and events are both read and written. Write-only calendar access counts as denied.
    nonisolated static func status(of permission: DevicePermission) -> DevicePermissionStatus {
        switch permission {
        case .reminders: return status(EKEventStore.authorizationStatus(for: .reminder))
        case .calendar: return status(EKEventStore.authorizationStatus(for: .event))
        case .contacts:
            switch CNContactStore.authorizationStatus(for: .contacts) {
            case .authorized, .limited: return .granted
            case .notDetermined: return .undetermined
            default: return .denied
            }
        }
    }

    /// Shows the system prompt. Only called from the settings screen: a prompt cannot be answered from a locked-screen call.
    static func request(_ permission: DevicePermission) async -> Bool {
        do {
            switch permission {
            case .reminders: return try await EKEventStore().requestFullAccessToReminders()
            case .calendar: return try await EKEventStore().requestFullAccessToEvents()
            case .contacts: return try await CNContactStore().requestAccess(for: .contacts)
            }
        } catch { return false }
    }

    private nonisolated static func status(_ status: EKAuthorizationStatus) -> DevicePermissionStatus {
        switch status {
        case .fullAccess: return .granted
        case .notDetermined: return .undetermined
        default: return .denied
        }
    }
}
