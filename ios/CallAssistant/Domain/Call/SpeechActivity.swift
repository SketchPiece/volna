import Foundation

/// Derives who is talking from WebRTC audio levels and transcript deltas. GPT-Live has no turn events:
/// the model listens and speaks at once, so the call screen infers its phases itself. Pure value type, tested without audio.
///
/// Levels arrive ten times per second, already scaled 0…1 by `RealtimeClient`. A side starts talking when its level
/// crosses `startLevel` or a transcript fragment arrives, and stops after `quietTicks` consecutive ticks below `stopLevel`.
struct SpeechActivity: Equatable {
    static let startLevel = 0.12
    static let stopLevel = 0.05
    /// 0.9 s of silence ends Volna's turn: pauses between sentences are shorter.
    static let outputQuietTicks = 9
    /// 0.7 s of silence ends the user's turn.
    static let inputQuietTicks = 7

    private(set) var waveSpeaking = false
    private(set) var userSpeaking = false
    private var quietOutput = 0
    private var quietInput = 0

    mutating func observe(input: Double, output: Double) -> [CallEvent] {
        var events: [CallEvent] = []
        if output >= Self.startLevel {
            quietOutput = 0
            if !waveSpeaking { waveSpeaking = true; events.append(.outputStarted) }
        } else if waveSpeaking, output < Self.stopLevel {
            quietOutput += 1
            if quietOutput >= Self.outputQuietTicks { waveSpeaking = false; quietOutput = 0; events.append(.outputStopped) }
        } else if waveSpeaking {
            quietOutput = 0
        }
        if input >= Self.startLevel {
            quietInput = 0
            if !userSpeaking { userSpeaking = true; events.append(.speechStarted) }
        } else if userSpeaking, input < Self.stopLevel {
            quietInput += 1
            if quietInput >= Self.inputQuietTicks { userSpeaking = false; quietInput = 0; events.append(.speechStopped) }
        } else if userSpeaking {
            quietInput = 0
        }
        return events
    }

    /// `session.output_transcript.delta`: Volna is speaking even if the level poll has not caught it yet.
    mutating func outputTranscriptArrived() -> [CallEvent] {
        quietOutput = 0
        guard !waveSpeaking else { return [] }
        waveSpeaking = true
        return [.outputStarted]
    }

    /// `session.input_transcript.delta`: the user is speaking.
    mutating func inputTranscriptArrived() -> [CallEvent] {
        quietInput = 0
        guard !userSpeaking else { return [] }
        userSpeaking = true
        return [.speechStarted]
    }
}
