import Foundation

/// Music while work runs (experiment 26.09.2026, off by default in the settings): after Volna starts a work on the Mac,
/// the phone quietly plays one of its own tunes (`WaitTunes`) whenever both sides have been silent for `quiet`, and fades
/// it out as soon as someone talks. Pure: the coordinator feeds it the running work and who speaks, and asks every level
/// tick whether music should sound.
///
/// The core lists running work in each `/device-tools` poll. Work already running when the call started does not count:
/// only work started in this call (an id missing from the first answer, the `baseline`) makes the music.
///
/// The microphone hears the music, so while it plays the owner counts as talking only by the model's transcript, never
/// by the input level: the level would stop the music, the silence would start it again, and so on.
struct WaitMusic: Equatable {
    /// Both sides silent this long before the music starts or comes back.
    static let quiet: TimeInterval = 2.5

    var enabled: Bool
    private var baseline: Set<String>?
    private var working: Set<String> = []
    private var waveSpeaking = false
    private var lastVoice: Date?

    init(enabled: Bool) { self.enabled = enabled }

    /// Work started in this call is still running.
    var armed: Bool {
        guard let baseline else { return false }
        return !working.subtracting(baseline).isEmpty
    }

    /// Ids of running work from the core; the first answer of the call is the baseline.
    mutating func workChanged(_ ids: [String]) {
        if baseline == nil { baseline = Set(ids) }
        working = Set(ids)
    }

    mutating func wave(speaking: Bool, at now: Date) {
        waveSpeaking = speaking
        lastVoice = now
    }

    mutating func ownerSpoke(at now: Date) { lastVoice = now }

    func shouldPlay(at now: Date) -> Bool {
        guard enabled, armed, !waveSpeaking else { return false }
        guard let lastVoice else { return true }
        return now.timeIntervalSince(lastVoice) >= Self.quiet
    }
}
