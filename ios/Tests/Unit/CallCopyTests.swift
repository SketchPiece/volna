import XCTest
@testable import CallAssistant

/// Strings asserted by UI tests and by the design document. Keep them in sync.
final class CallCopyTests: XCTestCase {
    func testStatusStringsCheckedByUITests() {
        var state = CallState()
        state.phase = .listening; state.isMuted = true
        XCTAssertEqual(state.status, "Микрофон выключен")
        state.phase = .ended
        XCTAssertEqual(state.status, "Разговор завершён")
    }

    func testIdleStatusIsDrawnFromTheRadioSelfCheckList() {
        XCTAssertTrue(CallCopy.idleStatuses.contains(CallCopy.idleStatus))
        XCTAssertEqual(CallCopy.idleStatus, CallState().status)
        XCTAssertEqual(Set(CallCopy.idleStatuses).count, CallCopy.idleStatuses.count, "no duplicates")
    }

    func testEveryPhaseHasTitleStatusAndCallToAction() {
        let phases: [CallPhase] = [.idle, .connecting, .listening, .thinking, .speaking, .ended, .failed]
        for phase in phases {
            var state = CallState(); state.phase = phase
            XCTAssertFalse(CallCopy.title(for: phase).isEmpty)
            XCTAssertFalse(state.status.isEmpty)
            XCTAssertFalse(CallCopy.callToAction(for: phase).isEmpty)
        }
    }

    func testShortStatusesWithIcons() {
        var state = CallState()
        state.phase = .listening
        XCTAssertEqual(state.status, "Слушаю"); XCTAssertEqual(CallCopy.statusSymbol(for: state), "ear")
        state.phase = .thinking
        XCTAssertEqual(state.status, "Думаю"); XCTAssertEqual(CallCopy.statusSymbol(for: state), "ellipsis")
        state.phase = .speaking
        XCTAssertEqual(state.status, "Говорю"); XCTAssertEqual(CallCopy.statusSymbol(for: state), "waveform")
        state.phase = .idle
        XCTAssertNil(CallCopy.statusSymbol(for: state), "idle, ended and failed show no icon")
        XCTAssertEqual(CallCopy.transcript, "Стенограмма")
    }

    func testCallToActionByOutcome() {
        XCTAssertEqual(CallCopy.callToAction(for: .idle), "Позвонить Волне")
        XCTAssertEqual(CallCopy.callToAction(for: .failed), "Повторить")
        XCTAssertEqual(CallCopy.callToAction(for: .ended), "Позвонить снова")
    }
}
