import XCTest
@testable import CallAssistant

final class SpeechActivityTests: XCTestCase {
    private func feed(_ activity: inout SpeechActivity, input: Double = 0, output: Double = 0, times: Int) -> [CallEvent] {
        (0..<times).flatMap { _ in activity.observe(input: input, output: output) }
    }

    func testWaveStartsOnLevelAndStopsAfterNineQuietTicks() {
        var activity = SpeechActivity()
        XCTAssertEqual(feed(&activity, output: 0.3, times: 3), [.outputStarted])
        XCTAssertEqual(feed(&activity, output: 0.0, times: 8), [])
        XCTAssertEqual(feed(&activity, output: 0.0, times: 1), [.outputStopped])
        XCTAssertFalse(activity.waveSpeaking)
    }

    func testShortPausesBetweenSentencesDoNotEndTheTurn() {
        var activity = SpeechActivity()
        _ = feed(&activity, output: 0.4, times: 1)
        _ = feed(&activity, output: 0.0, times: 5)
        XCTAssertEqual(feed(&activity, output: 0.4, times: 1), [], "the level came back before the quiet window closed")
        XCTAssertTrue(activity.waveSpeaking)
        _ = feed(&activity, output: 0.08, times: 20)
        XCTAssertTrue(activity.waveSpeaking, "a level between the thresholds keeps the current state")
    }

    func testTranscriptStartsTheTurnWithoutLevelAndSilenceEndsIt() {
        var activity = SpeechActivity()
        XCTAssertEqual(activity.outputTranscriptArrived(), [.outputStarted])
        XCTAssertEqual(activity.outputTranscriptArrived(), [])
        XCTAssertEqual(feed(&activity, output: 0.0, times: 9), [.outputStopped])
        XCTAssertEqual(activity.inputTranscriptArrived(), [.speechStarted])
        XCTAssertEqual(feed(&activity, input: 0.0, times: 7), [.speechStopped])
    }

    func testBothSidesCanTalkAtOnce() {
        var activity = SpeechActivity()
        XCTAssertEqual(activity.observe(input: 0.5, output: 0.5), [.outputStarted, .speechStarted])
        XCTAssertTrue(activity.waveSpeaking)
        XCTAssertTrue(activity.userSpeaking)
        XCTAssertEqual(feed(&activity, input: 0.0, output: 0.5, times: 7), [.speechStopped])
        XCTAssertTrue(activity.waveSpeaking)
    }
}
