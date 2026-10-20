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

    /// Screenshots for the README (docs/screenshots): home, a past conversation, the work list and a demo call with its
    /// transcript, all on the `--memory-preview` sample data. Whole screen, so the status bar override shows.
    func testCaptureReadmeShots() {
        let app = XCUIApplication()
        app.launchArguments = ["--memory-preview"]
        app.launch()
        XCTAssertTrue(app.buttons["homeCall.0"].waitForExistence(timeout: 10))
        dismissNotificationPrompt()
        sleep(2)
        snapScreen("readme-home")
        app.buttons["homeCall.0"].tap()
        XCTAssertTrue(app.buttons["Готово"].waitForExistence(timeout: 3))
        sleep(1)
        app.swipeUp(velocity: .slow)
        sleep(1)
        // To the end of the talk: the job handed to Helm.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)))
        sleep(2)
        snapScreen("readme-conversation")
        app.buttons["Готово"].tap()
        sleep(1)

        app.buttons["settings"].tap()
        XCTAssertTrue(app.buttons["homeMode.work"].waitForExistence(timeout: 3))
        app.buttons["homeMode.work"].tap()
        app.buttons["Готово"].tap()
        sleep(2)
        snapScreen("readme-work")
        app.buttons["settings"].tap()
        XCTAssertTrue(app.buttons["homeMode.talks"].waitForExistence(timeout: 3))
        app.buttons["homeMode.talks"].tap()
        let preview = app.buttons["preview"]
        for _ in 0..<5 where !preview.isHittable { app.swipeUp() }
        preview.tap()
        XCTAssertTrue(app.buttons["endCall"].waitForExistence(timeout: 3))
        // Volna's second answer (the Helm job) in the transcript, then the next answer on the call screen.
        let status = app.staticTexts["callStatus"]
        func waitForAnswer() {
            var wasSpeaking = status.label == "Говорю"
            for _ in 0..<120 {
                let speaking = status.label == "Говорю"
                if speaking && !wasSpeaking { return }
                wasSpeaking = speaking
                usleep(200_000)
            }
        }
        waitForAnswer()
        waitForAnswer()
        app.buttons["transcript"].tap()
        sleep(1)
        snapScreen("readme-call-transcript")
        app.buttons["Готово"].tap()
        waitForAnswer()
        sleep(1)
        snapScreen("readme-call-live")
        app.buttons["endCall"].tap()
    }

    /// A fresh simulator asks for notifications on first launch (`PushRegistration.start`), and `simctl privacy` can't
    /// grant them, so the system alert is answered here before the first screenshot.
    private func dismissNotificationPrompt() {
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        guard alert.waitForExistence(timeout: 5) else { return }
        let allow = alert.buttons["Allow"].exists ? alert.buttons["Allow"] : alert.buttons["Разрешить"]
        if allow.exists { allow.tap() } else { alert.buttons.element(boundBy: alert.buttons.count - 1).tap() }
        _ = alert.waitForNonExistence(timeout: 3)
    }

    private func snapScreen(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
