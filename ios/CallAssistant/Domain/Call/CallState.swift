import Foundation

/// Call lifecycle. `idle → connecting → listening ⇄ thinking ⇄ speaking → ended | failed`.
/// `connecting` lasts until Volna's first word: the session may already be up (`CallState.linkReady`) while the greeting is on its way.
enum CallPhase: Equatable, Sendable {
    case idle, connecting, listening, thinking, speaking, ended, failed
}

/// Indicator lamp of the design system. Lives in the domain because copy and UI both map phases to it.
enum LampState: Equatable, Sendable { case off, on, hot }

/// One line of the in-call transcript. After the call it is kept in `CallRecord` (the home screen's history).
struct TranscriptLine: Equatable, Sendable, Identifiable, Codable {
    enum Speaker: String, Equatable, Sendable, Codable { case you, wave = "volna" }
    var id: Int
    var speaker: Speaker
    var text: String
    /// Seconds since the call was answered.
    var offset: TimeInterval
}

/// Immutable snapshot of everything the UI needs. Produced only by `CallReducer`.
struct CallState: Equatable, Sendable {
    var phase: CallPhase = .idle
    var isMuted = false
    var isSpeaker = false
    var route = "Аудио"
    var error: String?
    var requestedAt: Date?
    /// When the call was answered: Volna's first word (or the fallback). The call timer counts from here.
    var startedAt: Date?
    /// GPT-Live's `session.started` arrived; the call is still `connecting` until it is answered.
    var linkReady = false
    var sessionReadyAt: Date?
    /// From the request to the answer, greeting included: what the owner waits through.
    var connectionTime: Double?
    /// Volna's current answer, cleared when a new one starts.
    var transcript = ""
    /// Whole conversation in order; `TranscriptSheet` renders it.
    var lines: [TranscriptLine] = []
    /// Which speaker's last line still accepts fragments.
    var openLine: TranscriptLine.Speaker?
    var launchSource = "Приложение"
    var isDemo = false

    var active: Bool { [.connecting, .listening, .thinking, .speaking].contains(phase) }
    /// Answered: the timer runs and the call controls are enabled.
    var connected: Bool { [.listening, .thinking, .speaking].contains(phase) }
    /// The session is up, answered or not: audio, transcripts, tools and the greeting are handled.
    var live: Bool { connected || (phase == .connecting && linkReady) }
    /// Subtitle shown under the title; UI tests assert some of these strings.
    var status: String { CallCopy.status(for: self) }
}
