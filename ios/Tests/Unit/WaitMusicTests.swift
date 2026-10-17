import XCTest
@testable import CallAssistant

/// Music while work runs: when it sounds and what the tunes are.
final class WaitMusicTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    func testPlaysOnlyForWorkStartedInThisCallAfterSilence() {
        var music = WaitMusic(enabled: true)
        XCTAssertFalse(music.shouldPlay(at: start), "no answer from the core yet")
        music.workChanged(["old"])
        XCTAssertFalse(music.shouldPlay(at: start), "work from before the call does not count")
        music.wave(speaking: true, at: start)
        music.workChanged(["old", "new"])
        XCTAssertTrue(music.armed)
        XCTAssertFalse(music.shouldPlay(at: start + 10), "Volna is talking")
        music.wave(speaking: false, at: start + 10)
        XCTAssertFalse(music.shouldPlay(at: start + 11))
        XCTAssertTrue(music.shouldPlay(at: start + 10 + WaitMusic.quiet))
        music.ownerSpoke(at: start + 20)
        XCTAssertFalse(music.shouldPlay(at: start + 21), "fades when the owner talks, back after the quiet")
        XCTAssertTrue(music.shouldPlay(at: start + 23))
        music.workChanged(["old"])
        XCTAssertFalse(music.shouldPlay(at: start + 30), "the work is done")
    }

    func testOffInTheSettingsNeverPlays() {
        var music = WaitMusic(enabled: false)
        music.workChanged([])
        music.workChanged(["new"])
        XCTAssertTrue(music.armed)
        XCTAssertFalse(music.shouldPlay(at: start))
    }

    func testTunesAreSeamlessLoopsWithoutSilence() {
        let rate = 4_000
        XCTAssertEqual(WaitTunes.Tune.allCases.count, 3)
        for tune in WaitTunes.Tune.allCases {
            let samples = WaitTunes.samples(tune, sampleRate: rate)
            XCTAssertEqual(samples.count, Int((WaitTunes.seconds(tune) * Double(rate)).rounded()), "\(tune)")
            XCTAssertGreaterThan(WaitTunes.seconds(tune), 20, "\(tune): long enough not to nag")
            let peak = samples.map { abs(Int($0)) }.max() ?? 0
            XCTAssertLessThanOrEqual(peak, Int(Double(Int16.max) * 0.9) + 1)
            XCTAssertLessThan(abs(Int(samples.first!) - Int(samples.last!)), peak / 4, "\(tune): no click at the loop point")
            let seconds = Int(WaitTunes.seconds(tune))
            for second in 0..<seconds {
                let slice = samples[(second * rate)..<((second + 1) * rate)]
                let rms = sqrt(slice.map { pow(Double($0), 2) }.reduce(0, +) / Double(slice.count))
                XCTAssertGreaterThan(rms, 150, "\(tune): sound in second \(second)")
            }
        }
        XCTAssertEqual(WaitTunes.samples(.ether, sampleRate: rate), WaitTunes.samples(.ether, sampleRate: rate), "the same bells every call")
    }
}
