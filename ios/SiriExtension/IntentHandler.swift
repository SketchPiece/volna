import Intents

final class IntentHandler: INExtension, INStartCallIntentHandling {
    override func handler(for intent: INIntent) -> Any {
        CallLaunchDiagnostics.record("extension.dispatch type=\(String(describing: type(of: intent)))")
        return self
    }

    func resolveContacts(for intent: INStartCallIntent, with completion: @escaping ([INStartCallContactResolutionResult]) -> Void) {
        let contacts = intent.contacts ?? []
        // This app has exactly one callable endpoint; it never calls real contacts.
        guard !contacts.isEmpty else {
            CallLaunchDiagnostics.record("extension.contact.default")
            completion([.success(with: WaveContact.person)])
            return
        }
        completion(contacts.map { person in
            let matches = WaveContact.matches(person) || (person.siriMatches ?? []).contains(where: WaveContact.matches)
            CallLaunchDiagnostics.record(matches ? "extension.contact.resolved" : "extension.contact.unsupported")
            return matches ? .success(with: WaveContact.person) : .unsupported()
        })
    }

    func resolveDestinationType(for intent: INStartCallIntent, with completion: @escaping (INCallDestinationTypeResolutionResult) -> Void) {
        completion(.success(with: .normal))
    }

    func resolveCallCapability(for intent: INStartCallIntent, with completion: @escaping (INStartCallCallCapabilityResolutionResult) -> Void) {
        completion(intent.callCapability == .videoCall ? .unsupported() : .success(with: .audioCall))
    }

    func confirm(intent: INStartCallIntent, completion: @escaping (INStartCallIntentResponse) -> Void) {
        CallLaunchDiagnostics.record("extension.confirm.ready")
        completion(INStartCallIntentResponse(code: .ready, userActivity: nil))
    }

    func handle(intent: INStartCallIntent, completion: @escaping (INStartCallIntentResponse) -> Void) {
        guard intent.contacts?.count == 1, let person = intent.contacts?.first, WaveContact.matches(person) else {
            CallLaunchDiagnostics.record("extension.handle.unsupported")
            completion(INStartCallIntentResponse(code: .failureContactNotSupportedByApp, userActivity: nil))
            return
        }
        CallLaunchDiagnostics.record("extension.handle.continueInApp")
        // Siri creates the activity and INInteraction, then wakes the host app.
        completion(INStartCallIntentResponse(code: .continueInApp, userActivity: nil))
    }
}

