import Foundation

/// Everything that can change `CallState`. Side effects never live here.
enum CallEvent: Equatable, Sendable {
    /// User or Siri asked for a call. Resets the previous call.
    case startRequested(source: String, at: Date)
    /// Demo screen without microphone, network or CallKit.
    case previewStarted(at: Date, transcript: String)
    /// GPT-Live's `session.started`: the link is up, the call is still connecting while Volna greets.
    case sessionReady(at: Date)
    /// Volna's first word, the owner's first transcribed word, or the greeting gave up: the call counts from here.
    case answered(at: Date)
    case speechStarted
    case speechStopped
    case outputStarted
    case outputStopped
    /// Fragment of Volna's answer. `at` stamps the line in the transcript history.
    case transcriptDelta(String, at: Date = Date())
    /// Fragment of what the user said, transcribed by GPT-Live.
    case inputTranscriptDelta(String, at: Date = Date())
    case muteChanged(Bool)
    case routeChanged(isSpeaker: Bool, name: String)
    /// Non-fatal problem worth showing (for example a speaker switch failure).
    case warning(String)
    case ended
    /// The ended screen has been shown long enough; back to idle. Ignored in every other phase.
    case reset
    case failed(String)
}
