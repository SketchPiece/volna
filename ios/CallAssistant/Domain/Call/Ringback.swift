import Foundation

/// What the owner hears while the call is «connecting», instead of a phone ringback: a faint airy hiss of the ether
/// that runs without a break, and every four seconds a soft «тин-тин» (a pure low tone sliding onto the note and ringing
/// out, with a quiet echo; variant B of docs/design/sounds). It plays from CallKit's audio activation until the call is answered: it starts quiet and swells over the first
/// rings, and on Volna's first word it fades out under her voice instead of stopping.
/// Pure: the cadence and the synthesized loop, tested without audio. Approved by the owner 26.09.2026.
enum Ringback {
    /// One loop of the file: the ping at its start, then hiss until the next one.
    static let cycle: Duration = .seconds(4)
    /// While the ping and its echo sound the model hears silence; the hiss alone never mutes the microphone.
    static let ping: Duration = .milliseconds(1500)
    static let note = 523.0
    static let echoDelay = 0.35
    static let echoLevel = 0.25
    static let slide = 0.03
    static let decay = 0.5
    /// The hiss under the pings; the owner found 0.45 far too loud on the iPhone (26.09.2026).
    static let hissLevel = 0.12
    /// The wait opens in the hiss `fadeIn` seconds before the first ping, rising from silence to `startLevel` of `volume`;
    /// then it swells to full `volume` over `swell` (two rings), so the first ping is soft and the next ones louder.
    static let fadeIn = 0.6
    static let startLevel: Float = 0.4
    static let swell = 8.0
    /// On the answer the sound fades out under Volna's first word; hanging up or a failure cuts it in `cut`.
    static let fadeOut = 1.0
    static let cut = 0.03
    /// A background cue, well under Volna's voice; 0.45 was too loud on the iPhone (26.09.2026).
    static let volume: Float = 0.18
    static let sampleRate = 24_000

    /// Only an outgoing call rings: in a callback the owner has just answered Volna, the demo has no audio.
    static func shouldRing(phase: CallPhase, isDemo: Bool, isCallback: Bool) -> Bool {
        phase == .connecting && !isDemo && !isCallback
    }

    /// One seamless cycle as 16-bit mono PCM samples: the loop point falls inside the hiss, where nothing changes.
    static func samples(sampleRate: Int = sampleRate) -> [Int16] {
        let count = Int(Double(sampleRate) * seconds(cycle))
        let dt = 1 / Double(sampleRate)
        var noise = Noise()
        var low = 0.0, air = 0.0
        // Warm the filters up so the hiss is at full level from the first sample, also after the loop point.
        for _ in 0..<1_000 { low += (noise.next() - low) * 0.08; air += (low - air) * 0.5 }
        var first = 0.0, second = 0.0
        var mix: [Double] = []
        mix.reserveCapacity(count)
        for index in 0..<count {
            let t = Double(index) * dt
            low += (noise.next() - low) * 0.08
            air += (low - air) * 0.5
            let breathe = 0.85 + 0.15 * sin(2 * .pi * t / seconds(cycle))
            let tone = tin(t, phase: &first, dt: dt) + echoLevel * tin(t - echoDelay, phase: &second, dt: dt)
            mix.append(tone * 0.9 + air * hissLevel * breathe)
        }
        let peak = mix.map(abs).max() ?? 1
        return mix.map { Int16($0 / peak * 0.9 * Double(Int16.max)) }
    }

    /// One loop as a WAV file for `AVAudioPlayer`.
    static func wav(sampleRate: Int = sampleRate) -> Data {
        let pcm = samples(sampleRate: sampleRate)
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let payload = UInt32(pcm.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36) + payload)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(sampleRate)); append(UInt32(sampleRate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(payload)
        pcm.forEach { append($0) }
        return data
    }

    static func seconds(_ duration: Duration) -> Double {
        Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
    }

    /// One soft ping starting at `t = 0`: a pure sine sliding from 3 % below onto the note, 15 ms attack, long bell-like decay.
    private static func tin(_ t: Double, phase: inout Double, dt: Double) -> Double {
        guard t >= 0 else { return 0 }
        let frequency = note * (1 - slide * exp(-t / 0.06))
        phase += 2 * .pi * frequency * dt
        let envelope = min(1, t / 0.015) * exp(-t / decay)
        return sin(phase) * envelope
    }

    /// Deterministic white noise in -1…1, so every call and every test hears the same hiss.
    private struct Noise {
        var state: UInt64 = 0x9E3779B97F4A7C15
        mutating func next() -> Double {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Double(Int64(bitPattern: state) >> 11) / Double(1 << 52)
        }
    }
}
