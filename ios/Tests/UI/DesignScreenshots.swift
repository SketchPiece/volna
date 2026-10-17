import XCTest

/// Captures the main screens as attachments for comparison with docs/design/volna-design-system.html.
/// Run alone: xcodebuild … test -only-testing:CallAssistantUITests/DesignScreenshots
final class DesignScreenshots: XCTestCase {
    func testCaptureScreens() {
        let app = XCUIApplication()
        app.launchArguments = ["--memory-preview"]
        app.launch()
        XCTAssertTrue(app.buttons["startCall"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["homeCall.0"].waitForExistence(timeout: 3))
        snap(app, "01-idle")
        // The page scrolls, not the card: the title goes under the top bar and the call key folds (home-scroll, «Б» + «В»).
        app.swipeUp(velocity: .slow)
        sleep(1)
        XCTAssertTrue(app.buttons["startCall"].exists, "the folded key stays on screen")
        snap(app, "01d-idle-scrolled")
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        sleep(1)
        app.buttons["homeCall.0"].tap()
        XCTAssertTrue(app.buttons["Готово"].waitForExistence(timeout: 3))
        sleep(1)
        snap(app, "01c-call-record")
        app.buttons["Готово"].tap()

        app.buttons["settings"].tap()
        XCTAssertTrue(app.buttons["voicePicker"].waitForExistence(timeout: 3))
        snap(app, "07-settings")
        app.buttons["homeMode.work"].tap()
        app.buttons["Готово"].tap()
        XCTAssertTrue(app.otherElements["homeList"].waitForExistence(timeout: 3) || app.staticTexts["РАБОТА"].waitForExistence(timeout: 1))
        sleep(1)
        snap(app, "01b-idle-work")
        app.buttons["settings"].tap()
        XCTAssertTrue(app.buttons["homeMode.talks"].waitForExistence(timeout: 3))
        app.buttons["homeMode.talks"].tap()
        app.buttons["voicePicker"].tap()
        XCTAssertTrue(app.buttons["Stone"].waitForExistence(timeout: 3))
        snap(app, "08-voice")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["memory"].waitForExistence(timeout: 3))
        app.buttons["memory"].tap()
        XCTAssertTrue(app.otherElements["memoryProfile"].waitForExistence(timeout: 3) || app.staticTexts["memoryProfile"].waitForExistence(timeout: 1))
        sleep(1)
        snap(app, "11-memory")
        // Карточки по категориям (docs/design/canvas/memory-cards, «А» и «А′»).
        let sister = app.buttons["memoryCard.anya"]
        for _ in 0..<3 where !sister.isHittable { app.swipeUp() }
        snap(app, "11c-memory-cards")
        sister.tap()
        XCTAssertTrue(app.buttons["forgetCard"].waitForExistence(timeout: 3))
        sleep(1)
        snap(app, "11d-memory-card")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let card = app.buttons["techCard.tc1"]
        for _ in 0..<3 where !card.isHittable { app.swipeUp() }
        snap(app, "14-memory-techcards")
        card.tap()
        XCTAssertTrue(app.buttons["deleteTechCard"].waitForExistence(timeout: 3))
        snap(app, "14b-techcard")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let persona = app.buttons["memoryPersona"]
        XCTAssertTrue(persona.waitForExistence(timeout: 3))
        persona.tap()
        XCTAssertTrue(app.buttons["personaReset"].waitForExistence(timeout: 3))
        snap(app, "15-persona")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        for _ in 0..<3 where !app.buttons["memoryLevel.cold"].isHittable { app.swipeDown() }
        app.buttons["memoryLevel.cold"].tap()
        sleep(1)
        snap(app, "11b-memory-cold")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["preview"].waitForExistence(timeout: 3))

        let preview = app.buttons["preview"]
        for _ in 0..<5 where !preview.isHittable { app.swipeUp() }
        preview.tap()
        XCTAssertTrue(app.buttons["endCall"].waitForExistence(timeout: 3))
        sleep(1)
        snap(app, "03-listening-demo")
        app.buttons["mute"].tap()
        sleep(1)
        snap(app, "03b-muted")
        app.buttons["mute"].tap()
        app.buttons["transcript"].tap()
        sleep(1)
        snap(app, "09-transcript")
        app.buttons["Готово"].tap()
        app.buttons["endCall"].tap()
        sleep(1)
        snap(app, "06-ended")
    }

    /// The home screen before the first conversation (docs/design/canvas/home-empty, board «Г»).
    func testCaptureEmptyHome() {
        let app = XCUIApplication()
        app.launchArguments = ["--memory-preview", "--empty-home"]
        app.launch()
        XCTAssertTrue(app.otherElements["homeEmpty"].waitForExistence(timeout: 10) || app.staticTexts["Первый выход в эфир"].waitForExistence(timeout: 2))
        sleep(1)
        snap(app, "01d-idle-empty")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
