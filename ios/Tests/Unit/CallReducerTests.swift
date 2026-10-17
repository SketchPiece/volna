import XCTest
@testable import CallAssistant

final class CallReducerTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func run(_ events: [CallEvent], from state: CallState = CallState()) -> CallState {
        events.reduce(state) { CallReducer.reduce($0, $1) }
    }

    func testHappyPathConnectsAndMeasuresConnectionTime() {
        let state = run([.startRequested(source: "SiriKit", at: t0), .sessionReady(at: t0 + 1.8), .answered(at: t0 + 3.1)])
        XCTAssertEqual(state.phase, .listening)
        XCTAssertEqual(state.launchSource, "SiriKit")
        XCTAssertEqual(state.connectionTime ?? 0, 3.1, accuracy: 0.001, "connection lasts until the answer, greeting included")
        XCTAssertEqual(state.startedAt, t0 + 3.1, "the timer counts from the answer")
        XCTAssertEqual(state.sessionReadyAt, t0 + 1.8)
        XCTAssertTrue(state.active && state.connected)
    }

    func testSessionReadyKeepsConnectingUntilAnswered() {
        let ready = run([.startRequested(source: "a", at: t0), .sessionReady(at: t0 + 1)])
        XCTAssertEqual(ready.phase, .connecting)
        XCTAssertTrue(ready.linkReady && ready.live)
        XCTAssertFalse(ready.connected, "no timer and no call controls before the first word")
        XCTAssertNil(ready.startedAt)
        XCTAssertNil(ready.connectionTime)
        XCTAssertEqual(CallReducer.reduce(ready, .sessionReady(at: t0 + 2)), ready, "a repeated session.started changes nothing")
        XCTAssertTrue(CallReducer.reduce(ready, .muteChanged(true)).isMuted, "CallKit's mute works before the answer")
        XCTAssertEqual(ready.status, "Соединяю…")
    }

    func testAnswerNeedsAReadySession() {
        let connecting = run([.startRequested(source: "a", at: t0)])
        XCTAssertEqual(CallReducer.reduce(connecting, .answered(at: t0 + 1)), connecting, "no answer before session.started")
        XCTAssertEqual(CallReducer.reduce(CallState(), .answered(at: t0)), CallState())
        let live = run([.sessionReady(at: t0), .answered(at: t0 + 1)], from: connecting)
        XCTAssertEqual(CallReducer.reduce(live, .answered(at: t0 + 5)), live, "a call is answered once")
        XCTAssertEqual(CallReducer.reduce(run([.ended], from: connecting), .sessionReady(at: t0)).linkReady, false)
    }

    func testConversationCycle() {
        var state = run([.startRequested(source: "Приложение", at: t0), .sessionReady(at: t0), .answered(at: t0)])
        state = run([.speechStarted, .speechStopped], from: state)
        XCTAssertEqual(state.phase, .thinking)
        state = run([.transcriptDelta("stale"), .outputStarted, .transcriptDelta("При"), .transcriptDelta("нято.")], from: state)
        XCTAssertEqual(state.phase, .speaking)
        XCTAssertEqual(state.transcript, "Принято.", "output start clears the previous answer")
        state = run([.outputStopped], from: state)
        XCTAssertEqual(state.phase, .listening)
    }

    func testRealtimeEventsAreIgnoredOutsideAConnectedCall() {
        for event in [CallEvent.speechStarted, .speechStopped, .outputStarted, .outputStopped, .transcriptDelta("x"), .muteChanged(true)] {
            XCTAssertEqual(CallReducer.reduce(CallState(), event), CallState(), "\(event) must not change idle state")
            var connecting = CallState(); connecting.phase = .connecting
            XCTAssertEqual(CallReducer.reduce(connecting, event), connecting, "\(event) must not change connecting state")
        }
    }

    func testStartIsIgnoredWhileActiveAndResetsPreviousCall() {
        var ended = run([.startRequested(source: "a", at: t0), .sessionReady(at: t0), .answered(at: t0), .transcriptDelta("old"), .ended])
        XCTAssertEqual(ended.phase, .ended)
        XCTAssertEqual(ended.transcript, "old", "ended call keeps its last answer for the screen")
        let active = run([.startRequested(source: "b", at: t0)], from: ended)
        XCTAssertEqual(active.transcript, "", "new call starts clean")
        ended = run([.startRequested(source: "c", at: t0)], from: active)
        XCTAssertEqual(ended.launchSource, "b", "start while active is ignored")
    }

    func testEndAndFailResetToggles() {
        let live = run([.startRequested(source: "a", at: t0), .sessionReady(at: t0), .answered(at: t0), .muteChanged(true), .routeChanged(isSpeaker: true, name: "Динамик")])
        XCTAssertTrue(live.isMuted && live.isSpeaker)
        let ended = CallReducer.reduce(live, .ended)
        XCTAssertEqual(ended.phase, .ended)
        XCTAssertFalse(ended.isMuted || ended.isSpeaker)
        let failed = CallReducer.reduce(live, .failed("Помехи"))
        XCTAssertEqual(failed.phase, .failed)
        XCTAssertEqual(failed.error, "Помехи")
        XCTAssertFalse(failed.isMuted)
    }

    func testFailureIsAcceptedInAnyPhaseButEndOnlyWhenActive() {
        XCTAssertEqual(CallReducer.reduce(CallState(), .failed("x")).phase, .failed)
        XCTAssertEqual(CallReducer.reduce(CallState(), .ended), CallState())
    }

    func testResetReturnsOnlyEndedToIdle() {
        let ended = run([.startRequested(source: "a", at: t0), .sessionReady(at: t0), .answered(at: t0), .transcriptDelta("old"), .ended])
        XCTAssertEqual(CallReducer.reduce(ended, .reset), CallState(), "ended screen goes back to a clean idle")
        let failed = CallReducer.reduce(CallState(), .failed("x"))
        XCTAssertEqual(CallReducer.reduce(failed, .reset), failed, "failed keeps its error until the user acts")
        let live = run([.startRequested(source: "a", at: t0), .sessionReady(at: t0), .answered(at: t0)])
        XCTAssertEqual(CallReducer.reduce(live, .reset), live)
        var connecting = CallState(); connecting.phase = .connecting
        XCTAssertEqual(CallReducer.reduce(connecting, .ended).phase, .ended)
    }

    func testPreviewIsADemoListeningCall() {
        let state = CallReducer.reduce(CallState(), .previewStarted(at: t0, transcript: "demo"))
        XCTAssertEqual(state.phase, .listening)
        XCTAssertTrue(state.isDemo)
        XCTAssertEqual(state.transcript, "demo")
        XCTAssertNil(state.connectionTime)
        XCTAssertEqual(CallReducer.reduce(state, .muteChanged(true)).isMuted, true)
    }

    func testWarningKeepsPhase() {
        let live = run([.startRequested(source: "a", at: t0), .sessionReady(at: t0), .answered(at: t0)])
        let warned = CallReducer.reduce(live, .warning("Динамик"))
        XCTAssertEqual(warned.phase, .listening)
        XCTAssertEqual(warned.error, "Динамик")
    }

    func testTranscriptHistoryKeepsBothSpeakersInOrder() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var state = run([.startRequested(source: "a", at: t0), .sessionReady(at: t0), .answered(at: t0)])
        state = run([.speechStarted, .inputTranscriptDelta("Что такое", at: t0 + 7), .inputTranscriptDelta(" резонанс?", at: t0 + 8),
                     .speechStopped, .outputStarted, .transcriptDelta("Качели", at: t0 + 11), .transcriptDelta(" в такт.", at: t0 + 12),
                     .speechStarted, .inputTranscriptDelta("А мост?", at: t0 + 34),
                     .outputStarted, .transcriptDelta("Может.", at: t0 + 38)], from: state)
        XCTAssertEqual(state.lines.map(\.text), ["Что такое резонанс?", "Качели в такт.", "А мост?", "Может."])
        XCTAssertEqual(state.lines.map(\.speaker), [.you, .wave, .you, .wave])
        XCTAssertEqual(state.lines.map(\.offset), [7, 11, 34, 38])
        XCTAssertEqual(state.transcript, "Может.", "the current answer is still the last one")
        XCTAssertEqual(run([.inputTranscriptDelta("   ")], from: state).lines.count, 4, "blank fragments open no line")
        XCTAssertEqual(run([.ended]).lines, [], "idle state ignores fragments")
    }
}
