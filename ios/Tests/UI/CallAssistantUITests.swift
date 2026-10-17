import XCTest

final class CallAssistantUITests: XCTestCase {
    func testVoiceSelectionPersistsAfterRelaunch() {
        let app = XCUIApplication()
        app.launch()
        app.buttons["settings"].tap()
        let picker = app.buttons["voicePicker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 3))
        picker.tap()
        app.buttons["Stone"].tap()
        app.terminate()
        app.launch()
        app.buttons["settings"].tap()
        XCTAssertTrue(picker.waitForExistence(timeout: 3))
        picker.tap()
        XCTAssertTrue(app.buttons["Stone"].isSelected)
        app.buttons["Meridian"].tap()
        app.terminate()
    }
    func testDemoLifecycleDoesNotRequireMicrophoneOrAPI() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["startCall"].waitForExistence(timeout: 10))
        app.buttons["settings"].tap()
        let preview = app.buttons["preview"]
        for _ in 0..<5 where !preview.isHittable { app.swipeUp() }
        XCTAssertTrue(preview.waitForExistence(timeout: 3))
        preview.tap()
        XCTAssertTrue(app.buttons["endCall"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Демо · без микрофона и API"].exists)
        app.buttons["mute"].tap()
        XCTAssertEqual(app.staticTexts["callStatus"].label, "Микрофон выключен")
        app.buttons["endCall"].tap()
        XCTAssertTrue(app.buttons["startCall"].exists)
        XCTAssertEqual(app.staticTexts["callStatus"].label, "Разговор завершён")
    }
    func testInvalidServerURLCannotBeSaved() {
        let app = XCUIApplication()
        app.launch()
        app.buttons["settings"].tap()
        // The core group is shown only in debug mode.
        let debug = app.switches["debugMode"]
        XCTAssertTrue(debug.waitForExistence(timeout: 3))
        if debug.value as? String != "1" { debug.switches.firstMatch.exists ? debug.switches.firstMatch.tap() : debug.tap() }
        let field = app.textFields["serverURL"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.tap()
        if let value = field.value as? String {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        field.typeText("http://example.com")
        app.buttons["Проверить подключение"].tap()
        XCTAssertTrue(app.staticTexts["connectionResult"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["connectionResult"].label.contains("HTTPS"))
    }
}
