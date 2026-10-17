import XCTest
@testable import CallAssistant

final class WaveMarkTests: XCTestCase {
    func testOwnerVoiceFillsTheRingFromTheBottom() {
        let bottom = RingLamps.lamp(at: .pi, state: .listening, level: 0.4)
        let top = RingLamps.lamp(at: 0, state: .listening, level: 0.4)
        XCTAssertEqual(bottom.lit, 1, accuracy: 0.001)
        XCTAssertEqual(top.lit, 0, accuracy: 0.001)
        XCTAssertGreaterThan(bottom.opacity, top.opacity)
        let silent = RingLamps.lamp(at: .pi, state: .listening, level: 0)
        XCTAssertEqual(silent.lit, 0)
    }

    func testWaveVoiceBrightensEveryLampAlike() {
        let a = RingLamps.lamp(at: 0.3, state: .speaking, level: 0.8)
        let b = RingLamps.lamp(at: 2.9, state: .speaking, level: 0.8)
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.tone, .hot)
        XCTAssertEqual(RingLamps.lamp(at: 0.3, state: .speaking, level: 0).tone, .lamp)
    }

    func testAngularDistanceWraps() {
        XCTAssertEqual(RingLamps.distance(0.1, 2 * .pi - 0.1), 0.2, accuracy: 1e-9)
        XCTAssertEqual(RingLamps.distance(-.pi / 2, .pi), .pi / 2, accuracy: 1e-9)
    }

    func testThinkingArcRunsFadesAndLightsOnlyNearItsHead() {
        let since = Date(timeIntervalSinceReferenceDate: 0)
        XCTAssertEqual(ThinkingArc.glow(since: since, until: nil, now: since), 0)
        XCTAssertEqual(ThinkingArc.glow(since: since, until: nil, now: since.addingTimeInterval(1)), 1)
        // A quarter turn after a quarter period.
        XCTAssertEqual(ThinkingArc.head(since: since, now: since.addingTimeInterval(1)), .pi / 2, accuracy: 1e-9)
        // After thinking ends the arc fades out over `fadeOut`.
        let end = since.addingTimeInterval(2)
        XCTAssertEqual(ThinkingArc.glow(since: since, until: end, now: end.addingTimeInterval(ThinkingArc.fadeOut / 2)), 0.5, accuracy: 1e-9)
        XCTAssertEqual(ThinkingArc.glow(since: since, until: end, now: end.addingTimeInterval(1)), 0)

        let base = RingLamps.lamp(at: 0, state: .thinking, level: 0)
        let atHead = ThinkingArc.lamp(over: base, at: 1, head: 1, glow: 1)
        XCTAssertEqual(atHead.tone, .hot)
        XCTAssertGreaterThan(atHead.length, base.length)
        XCTAssertEqual(ThinkingArc.lamp(over: base, at: 1 + .pi, head: 1, glow: 1), base)
    }

    func testMotionAccumulatesPhaseAndKeepsEchoes() {
        let motion = WaveMotion()
        let start = Date(timeIntervalSinceReferenceDate: 100)
        _ = motion.advance(to: start, running: true)
        motion.record(at: start, amplitude: 0.5, phase: 0, voice: 0.6)
        let dt = motion.advance(to: start.addingTimeInterval(0.05), running: true)
        XCTAssertEqual(dt, 0.05, accuracy: 1e-9)
        XCTAssertEqual(motion.phase(travel: 3.2, dt: dt), 0.16, accuracy: 1e-9)
        XCTAssertEqual(motion.sample(lag: 0.23, at: start.addingTimeInterval(0.3))?.amplitude, 0.5)
        XCTAssertNil(motion.sample(lag: 0.23, at: start.addingTimeInterval(0.1)))
        // A still wave settles back to the logo shape, the short way round.
        _ = motion.phase(travel: 3.2, dt: 1.8)
        var settled = 0.0
        for _ in 0..<60 { settled = motion.phase(travel: 0, dt: 0.1) }
        XCTAssertEqual(settled, 0, accuracy: 0.01)
        _ = motion.advance(to: start, running: false)
        XCTAssertNil(motion.sample(lag: 0, at: start.addingTimeInterval(1)))
    }
}
