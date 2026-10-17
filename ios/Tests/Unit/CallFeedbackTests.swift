import SwiftUI
import XCTest
@testable import CallAssistant

/// Which call events vibrate. Speaking turns must stay silent: the phone is at the ear.
final class CallFeedbackTests: XCTestCase {
    func testConnectSucceeds() {
        XCTAssertEqual(CallFeedback.phaseChange(from: .connecting, to: .listening), .success)
        XCTAssertEqual(CallFeedback.phaseChange(from: .connecting, to: .speaking), .success)
    }

    func testTurnsAreSilent() {
        XCTAssertNil(CallFeedback.phaseChange(from: .listening, to: .thinking))
        XCTAssertNil(CallFeedback.phaseChange(from: .thinking, to: .speaking))
        XCTAssertNil(CallFeedback.phaseChange(from: .speaking, to: .listening))
        XCTAssertNil(CallFeedback.phaseChange(from: .ended, to: .idle))
    }

    func testEndAndFailure() {
        XCTAssertEqual(CallFeedback.phaseChange(from: .speaking, to: .ended), .impact(weight: .medium))
        XCTAssertEqual(CallFeedback.phaseChange(from: .connecting, to: .failed), .error)
        XCTAssertNil(CallFeedback.phaseChange(from: .failed, to: .failed))
    }
}
