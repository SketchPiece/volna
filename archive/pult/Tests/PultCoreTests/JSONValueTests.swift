import XCTest
@testable import PultCore

final class JSONValueTests: XCTestCase {
    func testRoundTripKeepsIntegersAndNesting() throws {
        let value: JSONValue = ["id": 7, "ok": true, "name": "Пульт", "items": [1.5, .null, ["k": "v"]]]
        let line = try value.serialized()
        XCTAssertFalse(line.contains("\n"))
        XCTAssertTrue(line.contains("\"id\":7"))
        XCTAssertEqual(try JSONValue.parse(line), value)
    }

    func testAccessors() throws {
        let value = try JSONValue.parse(#"{"thread":{"id":"t1","updatedAt":1790073924},"list":[1,2]}"#)
        XCTAssertEqual(value["thread"]?["id"]?.string, "t1")
        XCTAssertEqual(value["thread"]?["updatedAt"]?.int, 1790073924)
        XCTAssertEqual(value["list"]?[1]?.int, 2)
        XCTAssertNil(value["missing"])
        XCTAssertNil(value["list"]?[5])
    }
}
