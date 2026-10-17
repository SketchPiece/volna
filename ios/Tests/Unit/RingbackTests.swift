import XCTest
@testable import CallAssistant

/// The sound of the wait before Volna answers: when it plays and what the loop is.
final class RingbackTests: XCTestCase {
    func testPlaysOnlyWhileAnOutgoingCallConnects() {
        XCTAssertTrue(Ringback.shouldRing(phase: .connecting, isDemo: false, isCallback: false))
        XCTAssertFalse(Ringback.shouldRing(phase: .listening, isDemo: false, isCallback: false), "answered calls are silent")
        XCTAssertFalse(Ringback.shouldRing(phase: .ended, isDemo: false, isCallback: false))
        XCTAssertFalse(Ringback.shouldRing(phase: .connecting, isDemo: true, isCallback: false), "the demo has no audio")
        XCTAssertFalse(Ringback.shouldRing(phase: .connecting, isDemo: false, isCallback: true), "the owner answered Volna's call")
    }

    func testPingEveryFourSecondsMutesLessThanTheCycle() {
        XCTAssertEqual(Ringback.seconds(Ringback.cycle), 4)
        XCTAssertLessThan(Ringback.ping, Ringback.cycle, "the microphone stays open in the hiss")
    }

    func testStartsSoftSwellsAndFadesOutUnderTheAnswer() {
        XCTAssertLessThan(Ringback.startLevel, 1, "the first ping is quieter than the next ones")
        XCTAssertGreaterThan(Ringback.startLevel, 0)
        XCTAssertLessThan(Ringback.fadeIn, Ringback.seconds(Ringback.cycle), "the fade in stays in the hiss before the first ping")
        XCTAssertGreaterThan(Ringback.fadeOut, Ringback.cut, "the answer fades, a hang-up cuts")
        XCTAssertLessThan(Ringback.fadeOut, Ringback.seconds(Ringback.ping), "gone before Volna's first sentence is over")
    }

    func testLoopIsOneCyclePingFirstHissThroughout() {
        let rate = 24_000
        let samples = Ringback.samples(sampleRate: rate)
        XCTAssertEqual(samples.count, 4 * rate)
        func rms(_ range: Range<Double>) -> Double {
            let slice = samples[Int(range.lowerBound * Double(rate))..<Int(range.upperBound * Double(rate))]
            return sqrt(slice.map { pow(Double($0), 2) }.reduce(0, +) / Double(slice.count))
        }
        let ping = rms(0.02..<0.3), hiss = rms(3.5..<4.0)
        XCTAssertGreaterThan(ping, hiss * 3, "the ping stands out over the hiss")
        XCTAssertGreaterThan(hiss, 200, "the hiss never stops, up to the loop point")
        XCTAssertGreaterThan(rms(0..<0.02), 200, "hiss at full level from the first sample: the loop point is seamless")
        XCTAssertEqual(samples, Ringback.samples(sampleRate: rate), "the same hiss every call")
    }

    func testWavHeaderMatchesPayload() {
        let wav = Ringback.wav(sampleRate: 16_000)
        XCTAssertEqual(wav.count, 44 + 4 * 16_000 * 2)
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: wav[8..<12], as: UTF8.self), "WAVE")
        XCTAssertEqual(String(decoding: wav[36..<40], as: UTF8.self), "data")
    }
}
