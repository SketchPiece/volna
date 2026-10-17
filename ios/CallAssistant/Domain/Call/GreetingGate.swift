import Foundation

/// Decides when to ask GPT-Live to greet and when the call counts as answered. Live acts on a greeting request only
/// while input audio is flowing (docs: «keep input audio running throughout this sequence»), and on iPhone the microphone
/// starts flowing when CallKit activates the audio session, which may happen before or after `session.started`. The
/// request therefore goes out once both have happened; if Volna stays silent afterwards, it is repeated once.
///
/// Until the first word the call stays «connecting»: the timer and CallKit's «connected» start with Volna's voice
/// (or the owner's transcribed words, if they speak first). If both requests go unanswered, the call is answered
/// anyway after the last `silenceTimeout`, so the link is never stuck in «connecting». Pure value type, tested without audio.
struct GreetingGate: Equatable {
    enum Action: Equatable {
        /// Send the greeting instruction after `delay`, then wait `silenceTimeout` for Volna's voice.
        case request
        /// The call is answered now: start the timer, report «connected» to the system.
        case answer
        case none
    }

    /// Pause after the microphone starts flowing before the request, so the first RTP packets are already in flight.
    static let delay: Duration = .milliseconds(500)
    /// Silence after a request that triggers the single repeat, or the answer without a greeting after the last one.
    static let silenceTimeout: Duration = .seconds(4)
    static let maxRequests = 2

    private var sessionStarted = false
    private var audioActive = false
    private(set) var requests = 0
    private(set) var heardWave = false
    private(set) var answered = false

    mutating func sessionDidStart() -> Action {
        sessionStarted = true
        return requestIfReady()
    }

    mutating func audioDidActivate() -> Action {
        audioActive = true
        return requestIfReady()
    }

    /// Volna's voice or transcript arrived: no more greeting requests, whatever caused the speech. The first one answers the call.
    mutating func waveSpoke() -> Action {
        heardWave = true
        return answer()
    }

    /// The owner's words were transcribed before any greeting: the conversation is on, the call is answered.
    /// Only a transcript counts; a level spike may be noise.
    mutating func ownerSpoke() -> Action {
        answer()
    }

    /// `silenceTimeout` passed after the last request without any output from Volna.
    mutating func silenceTimedOut() -> Action {
        guard !heardWave, !answered, requests > 0 else { return .none }
        guard requests < Self.maxRequests else { return answer() }
        requests += 1
        return .request
    }

    private mutating func requestIfReady() -> Action {
        guard sessionStarted, audioActive, requests == 0, !heardWave, !answered else { return .none }
        requests = 1
        return .request
    }

    private mutating func answer() -> Action {
        guard !answered else { return .none }
        answered = true
        return .answer
    }
}
