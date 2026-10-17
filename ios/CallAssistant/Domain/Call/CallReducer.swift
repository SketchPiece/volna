import Foundation

/// Pure transition function. Ignores events that make no sense in the current phase,
/// so late callbacks from a previous call cannot corrupt state.
enum CallReducer {
    static func reduce(_ state: CallState, _ event: CallEvent) -> CallState {
        var next = state
        switch event {
        case let .startRequested(source, at):
            guard !state.active else { return state }
            next = CallState()
            next.phase = .connecting
            next.launchSource = source
            next.requestedAt = at
        case let .previewStarted(at, transcript):
            guard !state.active else { return state }
            next = CallState()
            next.phase = .listening
            next.isDemo = true
            next.launchSource = "Демо без микрофона и API"
            next.startedAt = at
            next.transcript = transcript
            next.lines = [TranscriptLine(id: 0, speaker: .wave, text: transcript, offset: 0)]
        case let .sessionReady(at):
            guard state.phase == .connecting, !state.linkReady else { return state }
            next.linkReady = true
            next.sessionReadyAt = at
        case let .answered(at):
            guard state.phase == .connecting, state.linkReady else { return state }
            next.phase = .listening
            next.startedAt = at
            if let requestedAt = state.requestedAt { next.connectionTime = at.timeIntervalSince(requestedAt) }
        case .speechStarted:
            guard state.connected else { return state }
            next.phase = .listening
            if state.openLine == .wave { next.openLine = nil }
        case .speechStopped:
            guard state.connected else { return state }
            next.phase = .thinking
        case .outputStarted:
            guard state.connected else { return state }
            next.phase = .speaking
            next.transcript = ""
            next.openLine = nil
        case .outputStopped:
            guard state.connected else { return state }
            next.phase = .listening
        case let .transcriptDelta(delta, at):
            guard state.connected else { return state }
            next.transcript += delta
            next.append(delta, from: .wave, at: at)
        case let .inputTranscriptDelta(delta, at):
            guard state.connected else { return state }
            next.append(delta, from: .you, at: at)
        case let .muteChanged(muted):
            // CallKit's own mute button works before the answer too.
            guard state.live else { return state }
            next.isMuted = muted
        case let .routeChanged(isSpeaker, name):
            next.isSpeaker = isSpeaker
            next.route = name
        case let .warning(message):
            next.error = message
        case .ended:
            guard state.active else { return state }
            next.phase = .ended
            next.isMuted = false
            next.isSpeaker = false
        case .reset:
            guard state.phase == .ended else { return state }
            next = CallState()
        case let .failed(message):
            next.phase = .failed
            next.error = message
            next.isMuted = false
            next.isSpeaker = false
        }
        return next
    }
}

private extension CallState {
    /// Continues the open line of the same speaker or starts a new one.
    mutating func append(_ delta: String, from speaker: TranscriptLine.Speaker, at date: Date) {
        if openLine == speaker, let last = lines.indices.last, lines[last].speaker == speaker {
            lines[last].text += delta
            return
        }
        let trimmed = delta.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        let offset = startedAt.map { max(0, date.timeIntervalSince($0)) } ?? 0
        lines.append(TranscriptLine(id: lines.count, speaker: speaker, text: trimmed, offset: offset))
        openLine = speaker
    }
}
