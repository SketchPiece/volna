import Foundation
import AVFAudio

/// Plays `WaitTunes` through the call's audio session, like `RingbackPlayer`. Holds no call state: the coordinator asks
/// `WaitMusic` every level tick and calls `play()` or `pause()`. One tune per call, the next call gets the next one;
/// a pause keeps the place, so the music comes back where it stopped. The loop is synthesized on first use, off the main actor.
@MainActor
final class WaitMusicPlayer {
    private var player: AVAudioPlayer?
    private var loading: Task<Void, Never>?
    private var pauseTask: Task<Void, Never>?
    /// What the coordinator asked for last; the fade may still be running.
    private(set) var wanted = false

    nonisolated init() {}

    func play() {
        guard !wanted else { return }
        wanted = true
        pauseTask?.cancel(); pauseTask = nil
        guard let player else { load(); return }
        if !player.isPlaying { player.volume = 0; player.play() }
        player.setVolume(WaitTunes.volume, fadeDuration: WaitTunes.fadeIn)
    }

    /// Fades out and keeps the place.
    func pause() {
        guard wanted else { return }
        wanted = false
        guard let player, player.isPlaying else { return }
        player.setVolume(0, fadeDuration: WaitTunes.fadeOut)
        pauseTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(WaitTunes.fadeOut + 0.05))
            guard let self, !Task.isCancelled, !self.wanted else { return }
            player.pause()
        }
    }

    /// End of the call: silence at once and forget the tune.
    func stop() {
        wanted = false
        loading?.cancel(); loading = nil
        pauseTask?.cancel(); pauseTask = nil
        player?.stop()
        player = nil
    }

    private func load() {
        guard loading == nil else { return }
        let tune = Self.nextTune()
        loading = Task { @MainActor [weak self] in
            let data = await Task.detached(priority: .utility) { WaitTunes.wav(tune) }.value
            guard let self, !Task.isCancelled else { return }
            self.loading = nil
            guard let player = try? AVAudioPlayer(data: data) else { return }
            player.numberOfLoops = -1
            player.prepareToPlay()
            self.player = player
            if self.wanted { self.wanted = false; self.play() }
        }
    }

    private static func nextTune() -> WaitTunes.Tune {
        let all = WaitTunes.Tune.allCases
        let index = UserDefaults.standard.integer(forKey: "waitMusicTune")
        UserDefaults.standard.set((index + 1) % all.count, forKey: "waitMusicTune")
        return all[index % all.count]
    }
}
