import XCTest
@testable import CallAssistant

final class ConnectionSettingsTests: XCTestCase {
    private var original = ""

    override func setUp() {
        super.setUp()
        original = ConnectionSettings().endpoint
    }

    override func tearDown() {
        var settings = ConnectionSettings()
        settings.endpoint = original
        super.tearDown()
    }

    private func url(for endpoint: String) throws -> URL {
        var settings = ConnectionSettings()
        settings.endpoint = endpoint
        return try settings.sessionURL()
    }

    func testLocalhostMayUseHTTP() throws {
        XCTAssertEqual(try url(for: "http://127.0.0.1:8787").absoluteString, "http://127.0.0.1:8787/session")
        XCTAssertEqual(try url(for: "http://localhost:8787").path, "/session")
    }

    func testRemoteHostsRequireHTTPS() {
        XCTAssertThrowsError(try url(for: "http://example.com"))
        XCTAssertThrowsError(try url(for: "http://8.8.8.8:8789"))
        XCTAssertThrowsError(try url(for: "http://172.32.0.1:8789"))
        XCTAssertThrowsError(try url(for: "http://example.local.evil.com"))
        XCTAssertNoThrow(try url(for: "https://example.com"))
    }

    func testMacInTheSameWiFiMayUseHTTP() throws {
        XCTAssertEqual(try url(for: "http://192.168.178.144:8789").absoluteString, "http://192.168.178.144:8789/session")
        XCTAssertNoThrow(try url(for: "http://10.0.0.5:8789"))
        XCTAssertNoThrow(try url(for: "http://172.20.1.2:8789"))
        XCTAssertNoThrow(try url(for: "http://Sketchs-MacBook-Pro-3.local:8789"))
    }

    func testCredentialsQueryAndFragmentAreRejected() {
        XCTAssertThrowsError(try url(for: "https://user:pass@example.com"))
        XCTAssertThrowsError(try url(for: "https://example.com/?x=1"))
        XCTAssertThrowsError(try url(for: "https://example.com/#frag"))
        XCTAssertThrowsError(try url(for: "not a url"))
    }

    func testEndpointIsTrimmed() throws {
        XCTAssertEqual(try url(for: "  https://example.com  ").host, "example.com")
    }

    func testDefaultVoiceIsMeridian() {
        XCTAssertEqual(RealtimeVoice(rawValue: "") ?? .default, .meridian)
        XCTAssertNil(RealtimeVoice(rawValue: "marin"), "voices of the previous Realtime model fall back to the default")
        XCTAssertEqual(RealtimeVoice.allCases.count, 12)
    }
}
