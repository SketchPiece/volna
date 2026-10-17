import Intents
import UIKit

// Use SiriKit's system calling domain exclusively. A foreground App Intent with
// the same name competes with it and makes Siri request device unlock.
/// Siri's language can differ from the app's preferred language.
/// System call examples are localized in AppIntentVocabulary.plist.
@MainActor
final class SiriInvocation: ObservableObject {
    static let shared = SiriInvocation()
    @Published private(set) var languageCode = INPreferences.siriLanguageCode()
    private var vocabularyLanguage: String?
    func refresh() {
        languageCode = INPreferences.siriLanguageCode()
        guard INPreferences.siriAuthorizationStatus() == .authorized, vocabularyLanguage != languageCode else { return }
        WaveContact.registerVocabulary()
        vocabularyLanguage = languageCode
        CallLaunchDiagnostics.record("vocabulary.volna.submitted")
    }
    var isRussian: Bool { languageCode.lowercased().hasPrefix("ru") }
    var phrase: String { isRussian ? "Позвони Волне через Волну" : "Call Volna using Volna" }
}
