import XCTest
@testable import CallAssistant

/// The VoIP push contract with the core (core/src/tasks/delivery.ts) and the token registration body.
@MainActor
final class CallbackPushTests: XCTestCase {
    func testParsesTheBridgePayload() {
        XCTAssertEqual(CallbackPush.parse(["task": "0123456789abcdef", "title": "  Перелёты  "]),
                       CallbackPush(taskID: "0123456789abcdef", title: "Перелёты"))
        XCTAssertEqual(CallbackPush.parse(["task": "0123456789abcdef"])?.title, "")
    }

    func testRejectsAnythingThatIsNotATaskId() {
        XCTAssertNil(CallbackPush.parse([:]))
        XCTAssertNil(CallbackPush.parse(["task": "0123456789ABCDEF"]), "the core sends lowercase hex")
        XCTAssertNil(CallbackPush.parse(["task": "short"]))
        XCTAssertNil(CallbackPush.parse(["task": "../../session/xx"]))
        XCTAssertNil(CallbackPush.parse(["task": 42]))
    }

    func testRegistrationSendsOnlyTheKindsItHas() {
        XCTAssertEqual(PushRegistration.registration(voip: .some("aa")) as NSDictionary, ["environment": "development", "voip": "aa"] as NSDictionary)
        XCTAssertEqual(PushRegistration.registration(voip: .some(nil)) as NSDictionary, ["environment": "development", "voip": NSNull()] as NSDictionary, "an invalidated token is cleared")
        XCTAssertEqual(PushRegistration.registration(alert: .some("bb")) as NSDictionary, ["environment": "development", "alert": "bb"] as NSDictionary)
        XCTAssertEqual(PushRegistration.hex(Data([0x0a, 0xff])), "0aff")
    }

    func testCallbackCallsAreLabelled() {
        let state = CallReducer.reduce(CallState(), .startRequested(source: CallCopy.callbackSource, at: Date()))
        XCTAssertEqual(state.launchSource, "Волна перезванивает")
        XCTAssertEqual(state.phase, .connecting)
    }
}
