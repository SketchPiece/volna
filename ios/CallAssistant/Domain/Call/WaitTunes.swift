import Foundation

/// Volna's own instrumentals for `WaitMusic`: three calm loops without words, synthesized in code like `Ringback`,
/// so there are no files and no licences. Each loop is rendered on a circle: a note ringing past the end continues
/// at the start, so the loop point is seamless. Pure and deterministic, tested without audio.
enum WaitTunes {
    enum Tune: String, CaseIterable {
        /// Electric piano, Fmaj7 – Em7 – Dm9 – Cmaj9 at 70 bpm, with a sparse melody on top.
        case lamp
        /// Slow pads, Am9 – Fmaj9 – Cmaj7 – G6, with bells from the A minor pentatonic.
        case ether
        /// Marimba arpeggios, Dmaj7 – Bm7 – Gmaj7 – Asus at 84 bpm, over a soft bass.
        case steps
    }

    static let sampleRate = 24_000
    /// Barely there, half the ringback: the owner asked for music that never gets in the way (26.09.2026).
    static let volume: Float = 0.07
    static let fadeIn = 1.5
    static let fadeOut = 0.35

    static func seconds(_ tune: Tune) -> Double {
        switch tune {
        case .lamp: return 8 * bar(bpm: 70)
        case .ether: return 32
        case .steps: return 8 * bar(bpm: 84)
        }
    }

    /// One loop as 16-bit mono PCM.
    static func samples(_ tune: Tune, sampleRate: Int = sampleRate) -> [Int16] {
        var mix = Mix(count: Int((seconds(tune) * Double(sampleRate)).rounded()), rate: Double(sampleRate))
        switch tune {
        case .lamp: lamp(&mix)
        case .ether: ether(&mix)
        case .steps: steps(&mix)
        }
        return mix.pcm()
    }

    static func wav(_ tune: Tune, sampleRate: Int = sampleRate) -> Data {
        let pcm = samples(tune, sampleRate: sampleRate)
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

    // MARK: - Tunes

    private static func bar(bpm: Double) -> Double { 4 * 60 / bpm }

    private static func lamp(_ mix: inout Mix) {
        let beat = 60 / 70.0
        let chords: [(root: Int, notes: [Int])] = [
            (41, [53, 57, 60, 64]), (40, [52, 55, 59, 62]), (38, [50, 53, 57, 60, 64]), (36, [48, 52, 55, 59, 62])
        ]
        for (index, chord) in chords.enumerated() {
            for half in 0..<2 {
                let start = Double(index * 2 + half) * 4 * beat
                for (n, note) in chord.notes.enumerated() {
                    mix.add(at: start + Double(n) * 0.018, length: 4.5, level: 0.22) { keys($0, pitch(note)) }
                    mix.add(at: start + 2.5 * beat + Double(n) * 0.012, length: 2.5, level: 0.1) { keys($0, pitch(note)) }
                }
                mix.add(at: start, length: 2.4, level: 0.3) { bass($0, pitch(chord.root + 12)) }
                mix.add(at: start + 2 * beat, length: 2, level: 0.2) { bass($0, pitch(chord.root + 19)) }
            }
        }
        // (bar, beat, note): the phrase stays on the chord tones.
        let melody: [(Double, Double, Int)] = [
            (0, 0, 76), (0, 2, 79), (1, 1, 76), (2, 0, 74), (2, 2, 71), (3, 1, 67),
            (4, 0, 72), (4, 2, 76), (5, 1, 74), (6, 0, 71), (6, 2, 74), (7, 1, 67)
        ]
        for (bar, at, note) in melody {
            mix.add(at: (bar * 4 + at) * beat, length: 3.5, level: 0.16) { keys($0, pitch(note)) }
        }
    }

    private static func ether(_ mix: inout Mix) {
        let chords: [[Int]] = [[57, 60, 64, 71], [53, 57, 64, 67], [48, 55, 59, 64], [55, 59, 62, 64]]
        for (index, chord) in chords.enumerated() {
            let start = Double(index) * 8
            for note in chord { mix.add(at: start - 1.5, length: 11, level: 0.12) { pad($0, pitch(note), length: 11) } }
        }
        let scale = [69, 72, 74, 76, 79, 81]
        var random = Random(seed: 7)
        var at = 0.8
        while at < 32 {
            if random.next() < 0.7 {
                let note = scale[Int(random.next() * Double(scale.count)) % scale.count]
                mix.add(at: at, length: 4, level: 0.13) { bell($0, pitch(note)) }
            }
            at += random.next() < 0.5 ? 2 : 1.5
        }
    }

    private static func steps(_ mix: inout Mix) {
        let eighth = 60 / 84.0 / 2
        let chords: [(root: Int, notes: [Int])] = [
            (50, [62, 66, 69, 73]), (47, [59, 62, 66, 69]), (43, [55, 59, 62, 66]), (45, [57, 62, 64, 67])
        ]
        let pattern = [0, 1, 2, 3, 2, 1, 2, 1]
        for (index, chord) in chords.enumerated() {
            for half in 0..<2 {
                let barStart = Double(index * 2 + half) * 8 * eighth
                for (step, tone) in pattern.enumerated() {
                    let note = chord.notes[tone] + (half == 1 && step == 3 ? 12 : 0)
                    let accent = step % 2 == 0 ? 0.2 : 0.13
                    mix.add(at: barStart + Double(step) * eighth, length: 1.2, level: accent) { mallet($0, pitch(note)) }
                }
                mix.add(at: barStart, length: 2.4, level: 0.28) { bass($0, pitch(chord.root)) }
                mix.add(at: barStart + 5 * eighth, length: 1.2, level: 0.14) { bass($0, pitch(chord.root + 7)) }
            }
        }
    }

    // MARK: - Voices: one note at local time t (seconds from its start)

    private static func pitch(_ midi: Int) -> Double { 440 * pow(2, Double(midi - 69) / 12) }

    /// Electric piano: two-operator FM, the bright attack mellows as it rings.
    private static func keys(_ t: Double, _ f: Double) -> Double {
        let index = 1.1 * exp(-t / 0.25) + 0.12
        let body = sin(2 * .pi * f * t + index * sin(2 * .pi * f * t))
        return body * min(1, t / 0.004) * exp(-t / 1.4)
    }

    private static func bass(_ t: Double, _ f: Double) -> Double {
        (sin(2 * .pi * f * t) + 0.25 * sin(4 * .pi * f * t)) * min(1, t / 0.01) * exp(-t / 0.9)
    }

    /// Three slightly detuned sines, slow swell in and out over the whole length.
    private static func pad(_ t: Double, _ f: Double, length: Double) -> Double {
        let swell = min(1, t / 2.5) * min(1, max(0, length - t) / 2.5)
        let tone = sin(2 * .pi * f * t) + 0.6 * sin(2 * .pi * f * 1.003 * t) + 0.6 * sin(2 * .pi * f * 0.997 * t)
            + 0.2 * sin(4 * .pi * f * t)
        return tone * swell * (0.85 + 0.15 * sin(2 * .pi * 0.2 * t))
    }

    private static func bell(_ t: Double, _ f: Double) -> Double {
        let tone = sin(2 * .pi * f * t) + 0.35 * sin(2 * .pi * f * 2.76 * t) * exp(-t / 0.4) + 0.15 * sin(2 * .pi * f * 5.4 * t) * exp(-t / 0.15)
        return tone * min(1, t / 0.003) * exp(-t / 1.3)
    }

    private static func mallet(_ t: Double, _ f: Double) -> Double {
        let tone = sin(2 * .pi * f * t) + 0.3 * sin(2 * .pi * f * 4 * t) * exp(-t / 0.03)
        return tone * min(1, t / 0.002) * exp(-t / 0.35)
    }

    // MARK: - Rendering

    /// A circular buffer: what rings past the end is added at the start.
    private struct Mix {
        var buffer: [Double]
        let rate: Double

        init(count: Int, rate: Double) { buffer = Array(repeating: 0, count: count); self.rate = rate }

        mutating func add(at start: Double, length: Double, level: Double, voice: (Double) -> Double) {
            let count = buffer.count
            let first = Int((start * rate).rounded())
            for index in 0..<Int(length * rate) {
                let slot = ((first + index) % count + count) % count
                buffer[slot] += level * voice(Double(index) / rate)
            }
        }

        /// A gentle low-pass for warmth, a soft limiter, and 90 % of full scale at the peak.
        func pcm() -> [Int16] {
            var low = 0.0
            // Two rounds so the filter state at the loop point is the steady one.
            var out = buffer
            for _ in 0..<2 { for index in buffer.indices { low += (buffer[index] - low) * 0.35; out[index] = tanh(low * 1.2) } }
            let peak = max(out.map(abs).max() ?? 1, 1e-9)
            return out.map { Int16($0 / peak * 0.9 * Double(Int16.max)) }
        }
    }

    /// Deterministic 0..<1, so every call hears the same bells.
    private struct Random {
        var state: UInt64
        init(seed: UInt64) { state = seed &* 0x9E3779B97F4A7C15 }
        mutating func next() -> Double {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Double(state >> 11) / Double(1 << 53)
        }
    }
}
