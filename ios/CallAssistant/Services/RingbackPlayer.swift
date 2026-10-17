import Foundation
import AVFAudio

/// Loops the `Ringback` cycle through the call's audio session. Holds no call state: the coordinator starts it on
/// CallKit's audio activation and stops it when the call is answered (fade out) or ends (quick cut). While a ping
/// sounds the microphone would hear it, so `onTone` tells the owner to send silence to the model for that moment;
/// the hiss alone keeps it open.
@MainActor
final class RingbackPlayer {
    var onTone: ((Bool) -> Void)?

    private var player: AVAudioPlayer?
    private var task: Task<Void, Never>?
    /// Stops the player once a fade out has run; replaced by a new start or a quicker stop.
    private var fading: Task<Void, Never>?
    /// The microphone is muted for the model right now (`onTone`).
    private(set) var toneOn = false

    nonisolated init() {}

    func start() {
        guard task == nil else { return }
        fading?.cancel(); fading = nil
        if player == nil {
            player = try? AVAudioPlayer(data: Ringback.wav())
            player?.numberOfLoops = -1
            player?.prepareToPlay()
        }
        guard let player else { return }
        // Open in the hiss just before the loop point, so the first ping comes after the fade in.
        player.currentTime = player.duration - Ringback.fadeIn
        player.volume = 0
        player.play()
        player.setVolume(Ringback.volume * Ringback.startLevel, fadeDuration: Ringback.fadeIn)
        // Follows the loop: the ping opens every cycle.
        task = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(Ringback.fadeIn))
            guard !Task.isCancelled else { return }
            player.setVolume(Ringback.volume, fadeDuration: Ringback.swell)
            while !Task.isCancelled {
                self?.setTone(true)
                try? await Task.sleep(for: Ringback.ping)
                guard !Task.isCancelled else { return }
                self?.setTone(false)
                try? await Task.sleep(for: Ringback.cycle - Ringback.ping)
            }
        }
    }

    /// `fade`: the call was answered, the sound dies away under Volna's voice. Otherwise it is cut at once
    /// (hang-up, failure, lost audio), with only a few milliseconds so the cut does not click. The microphone opens at once either way.
    func stop(fade: Bool = false) {
        task?.cancel(); task = nil
        setTone(false)
        guard let player, player.isPlaying else { return }
        if fade, fading != nil { return }
        let duration = fade ? Ringback.fadeOut : Ringback.cut
        player.setVolume(0, fadeDuration: duration)
        fading?.cancel()
        fading = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(duration + 0.01))
            guard !Task.isCancelled, let self, self.task == nil else { return }
            self.fading = nil
            player.stop()
        }
    }

    private func setTone(_ on: Bool) {
        guard on != toneOn else { return }
        toneOn = on
        onTone?(on)
    }
}
