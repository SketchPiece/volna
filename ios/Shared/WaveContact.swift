import Intents

/// One built-in endpoint, shared by the app and its SiriKit extension.
enum WaveContact {
    static let identifier = "volna"
    static let handle = "volna"
    static var name: String { INPreferences.siriLanguageCode().lowercased().hasPrefix("ru") ? "Волна" : "Volna" }

    static var person: INPerson {
        INPerson(personHandle: INPersonHandle(value: handle, type: .unknown),
                 nameComponents: nil, displayName: name, image: nil,
                 contactIdentifier: nil, customIdentifier: identifier)
    }

    static func matches(_ person: INPerson) -> Bool {
        if person.customIdentifier == identifier { return true }
        let aliases = ["volna", "волна", "волне", "волну", "волной", "assistant", "ассистент", "помощник"]
        return [person.displayName, person.spokenPhrase, person.personHandle?.value ?? ""].contains {
            aliases.contains($0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        }
    }

    @available(iOS 14.0, *)
    static func callIntent() -> INStartCallIntent {
        INStartCallIntent(callRecordFilter: nil, callRecordToCallBack: nil,
                          audioRoute: .speakerphoneAudioRoute, destinationType: .normal, contacts: [person],
                          callCapability: .audioCall)
    }

    static func registerVocabulary() {
        let vocabulary = ["Volna", "Волна"].map {
            INSpeakableString(vocabularyIdentifier: identifier, spokenPhrase: $0, pronunciationHint: nil)
        }
        INVocabulary.shared().setVocabulary(NSOrderedSet(array: vocabulary), of: .contactName)
    }
}
