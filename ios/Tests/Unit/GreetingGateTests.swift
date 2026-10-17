import XCTest
@testable import CallAssistant

final class GreetingGateTests: XCTestCase {
    func testRequestsOnlyWhenSessionStartedAndAudioActive() {
        var gate = GreetingGate()
        XCTAssertEqual(gate.sessionDidStart(), .none, "microphone is not flowing yet")
        XCTAssertEqual(gate.audioDidActivate(), .request)
        XCTAssertEqual(gate.requests, 1)
    }

    func testAudioMayActivateBeforeSessionStarts() {
        var gate = GreetingGate()
        XCTAssertEqual(gate.audioDidActivate(), .none)
        XCTAssertEqual(gate.sessionDidStart(), .request)
        XCTAssertEqual(gate.sessionDidStart(), .none, "a repeated session.started never asks twice")
        XCTAssertEqual(gate.audioDidActivate(), .none, "a route change never asks twice")
    }

    func testRepeatsOnceAfterSilence() {
        var gate = GreetingGate()
        _ = gate.audioDidActivate()
        XCTAssertEqual(gate.sessionDidStart(), .request)
        XCTAssertEqual(gate.silenceTimedOut(), .request)
        XCTAssertEqual(gate.requests, GreetingGate.maxRequests)
        XCTAssertNotEqual(gate.silenceTimedOut(), .request, "only one repeat")
        XCTAssertEqual(gate.requests, GreetingGate.maxRequests)
    }

    func testWaveSpeakingStopsRepeats() {
        var gate = GreetingGate()
        _ = gate.audioDidActivate()
        XCTAssertEqual(gate.sessionDidStart(), .request)
        XCTAssertEqual(gate.waveSpoke(), .answer, "the first word answers the call")
        XCTAssertEqual(gate.waveSpoke(), .none, "only once")
        XCTAssertEqual(gate.silenceTimedOut(), .none)
    }

    func testSilenceAfterTheLastRequestAnswersWithoutGreeting() {
        var gate = GreetingGate()
        _ = gate.audioDidActivate()
        XCTAssertEqual(gate.sessionDidStart(), .request)
        XCTAssertEqual(gate.silenceTimedOut(), .request)
        XCTAssertEqual(gate.silenceTimedOut(), .answer, "the call never hangs in «connecting»")
        XCTAssertEqual(gate.waveSpoke(), .none, "a late greeting does not answer twice")
        XCTAssertEqual(gate.silenceTimedOut(), .none)
    }

    func testOwnerSpeakingFirstAnswersAndStopsRequests() {
        var gate = GreetingGate()
        _ = gate.audioDidActivate()
        XCTAssertEqual(gate.sessionDidStart(), .request)
        XCTAssertEqual(gate.ownerSpoke(), .answer)
        XCTAssertEqual(gate.silenceTimedOut(), .none, "no greeting on top of the owner's words")
        XCTAssertEqual(gate.waveSpoke(), .none)
    }

    func testSilenceBeforeAnyRequestDoesNothing() {
        var gate = GreetingGate()
        XCTAssertEqual(gate.silenceTimedOut(), .none)
        _ = gate.sessionDidStart()
        XCTAssertEqual(gate.silenceTimedOut(), .none, "nothing was requested yet")
    }

    func testWaveSpeakingFirstSkipsTheRequest() {
        var gate = GreetingGate()
        XCTAssertEqual(gate.waveSpoke(), .answer)
        _ = gate.audioDidActivate()
        XCTAssertEqual(gate.sessionDidStart(), .none, "Volna already talks: no request on top of it")
    }
}
