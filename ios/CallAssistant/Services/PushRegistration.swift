import Foundation
import PushKit
import UIKit
import UserNotifications

/// Push tokens for the core's background tasks: a PushKit token lets Volna call back (VoIP push → CallKit incoming call),
/// a notification token carries «task done» notices. Both go to `POST /push/register` with the core token.
/// PushKit is registered at every launch: a VoIP push may launch the app in the background and must find it ready.
@MainActor
final class PushRegistration: NSObject {
    static let shared = PushRegistration()
    private let registry = PKPushRegistry(queue: .main)
    var settings = ConnectionSettings()

    /// Sandbox tokens come from Xcode builds, production ones from TestFlight and the App Store.
    static var environment: String {
        #if DEBUG
        "development"
        #else
        "production"
        #endif
    }

    func start() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        Task { @MainActor in
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
            CallLaunchDiagnostics.record("push.notifications granted=\(granted)")
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func alertTokenArrived(_ token: Data) { upload(alert: .some(Self.hex(token))) }

    nonisolated static func hex(_ token: Data) -> String { token.map { String(format: "%02x", $0) }.joined() }

    /// Body of `POST /push/register`; a kind that is not sent keeps its previous token in the core.
    static func registration(voip: String?? = nil, alert: String?? = nil) -> [String: Any] {
        var body: [String: Any] = ["environment": environment]
        if let voip { body["voip"] = voip ?? NSNull() }
        if let alert { body["alert"] = alert ?? NSNull() }
        return body
    }

    /// `.some(nil)` clears a token in the core; `nil` leaves it as is.
    private func upload(voip: String?? = nil, alert: String?? = nil) {
        let body = Self.registration(voip: voip, alert: alert)
        let settings = settings
        Task {
            guard let url = try? settings.sessionURL().deletingLastPathComponent().appendingPathComponent("push/register") else { return }
            var request = URLRequest(url: url, timeoutInterval: 10)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if !settings.token.isEmpty { request.setValue("Bearer \(settings.token)", forHTTPHeaderField: "Authorization") }
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            let status = ((try? await URLSession.shared.data(for: request))?.1 as? HTTPURLResponse)?.statusCode ?? 0
            CallLaunchDiagnostics.record("push.register status=\(status)")
        }
    }
}

extension PushRegistration: PKPushRegistryDelegate {
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        let token = Self.hex(credentials.token)
        MainActor.assumeIsolated { upload(voip: .some(token)) }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        MainActor.assumeIsolated { upload(voip: .some(nil)) }
    }

    /// iOS requires every VoIP push to be reported to CallKit before `completion`, or it stops delivering them.
    /// The registry runs on the main queue, so the coordinator reports synchronously here.
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                                  for type: PKPushType, completion: @escaping () -> Void) {
        let push = CallbackPush.parse(payload.dictionaryPayload)
        MainActor.assumeIsolated {
            CallLaunchDiagnostics.record("push.voip valid=\(push != nil) state=\(UIApplication.shared.applicationState.rawValue)")
            CallCoordinator.shared.incomingCallback(push, completion: completion)
        }
    }
}
