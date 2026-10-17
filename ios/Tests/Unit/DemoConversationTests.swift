import XCTest
@testable import CallAssistant

final class DemoConversationTests: XCTestCase {
    func testLevelLooksLikeSpeechAndStaysInRange() {
        let length = 3.0
        let samples = stride(from: 0.0, through: length, by: 0.1).map { DemoConversation.level(at: $0, length: length, seed: 1) }
        XCTAssertTrue(samples.allSatisfy { (0...1).contains($0) })
        XCTAssertGreaterThan(samples.max() ?? 0, 0.4)
        XCTAssertEqual(DemoConversation.level(at: 0, length: length, seed: 1), 0)
        XCTAssertEqual(DemoConversation.level(at: length + 0.1, length: length, seed: 1), 0)
    }

    func testDeltasRebuildThePhrase() {
        let text = "Какая завтра погода в Берлине?"
        XCTAssertEqual(DemoConversation.deltas(text).joined(), text)
        XCTAssertEqual(DemoConversation.deltas(text).first, "Какая")
    }

    func testEveryExchangeHasBothSides() {
        XCTAssertFalse(DemoConversation.exchanges.isEmpty)
        XCTAssertTrue(DemoConversation.exchanges.allSatisfy { !$0.question.isEmpty && !$0.answer.isEmpty })
    }
}
