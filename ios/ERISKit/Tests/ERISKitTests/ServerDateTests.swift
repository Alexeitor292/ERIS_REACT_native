import XCTest
@testable import ERISKit

final class ServerDateTests: XCTestCase {
    private func utc(_ text: String) -> Date {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: text)!
    }

    func testAValueWithoutAnOffsetIsPacificTime() {
        // October: PDT, UTC-7.
        XCTAssertEqual(ServerDate.parse("2026-10-27T15:00:00"), utc("2026-10-27T22:00:00Z"))
        XCTAssertEqual(ServerDate.parse("2026-10-27 15:00:00"), utc("2026-10-27T22:00:00Z"))
        // January: PST, UTC-8.
        XCTAssertEqual(ServerDate.parse("2027-01-15T08:30:00"), utc("2027-01-15T16:30:00Z"))
        XCTAssertEqual(ServerDate.parse("2027-01-15T08:30"), utc("2027-01-15T16:30:00Z"))
    }

    func testAnExplicitZoneIsExact() {
        XCTAssertEqual(ServerDate.parse("2026-10-27T15:00:00Z"), utc("2026-10-27T15:00:00Z"))
        XCTAssertEqual(ServerDate.parse("2026-10-27T15:00:00+00:00"), utc("2026-10-27T15:00:00Z"))
        XCTAssertEqual(ServerDate.parse("2026-10-27T08:00:00-07:00"), utc("2026-10-27T15:00:00Z"))
    }

    func testFractionalSecondsOfAnyLengthAreRead() throws {
        let date = try XCTUnwrap(ServerDate.parse("2026-10-27T15:00:00.123456Z"))
        XCTAssertEqual(date.timeIntervalSince(utc("2026-10-27T15:00:00Z")), 0.123456, accuracy: 0.000001)
        XCTAssertEqual(ServerDate.parse("2026-10-27 15:00:00.5"), utc("2026-10-27T22:00:00Z").addingTimeInterval(0.5))
    }

    func testADateAloneIsMidnightPacific() {
        XCTAssertEqual(ServerDate.parse("2027-02-05"), utc("2027-02-05T08:00:00Z"))
    }

    func testUnreadableTextIsNilAndDisplayedAsSent() {
        for text in ["", "yesterday", "2026-13-01", "2026-02-30", "2026-10-27T15", "2026-10-27T15:00:00+7"] {
            XCTAssertNil(ServerDate.parse(text), text)
        }
        XCTAssertNil(ServerDate.parse(nil))
        XCTAssertEqual(ServerDate.display("yesterday"), "yesterday")
        XCTAssertNil(ServerDate.display(nil))
        XCTAssertNotEqual(ServerDate.display("2026-10-27T15:00:00Z"), "2026-10-27T15:00:00Z")
    }
}
