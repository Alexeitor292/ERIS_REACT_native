import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import ERISKit

final class DelegationsAndWorkloadTests: XCTestCase {
    private var snake: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    private func delegation(status: String = "ACTIVE", starts: String = "2026-11-10", ends: String = "2026-11-14") throws -> Delegation {
        try snake.decode(Delegation.self, from: Data("""
        {"id": 1, "delegator": {"id": 1, "full_name": "J. Chen"}, "delegate": {"id": 2, "full_name": "M. Okafor"},
         "starts_on": "\(starts)", "ends_on": "\(ends)", "note": null, "status": "\(status)", "action_count": 0}
        """.utf8))
    }

    private var pacific: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return calendar
    }

    private func day(_ year: Int, _ month: Int, _ day: Int) -> Date {
        pacific.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
    }

    func testADayReadsTheSameInEveryTimeZone() {
        XCTAssertTrue(DelegationDates.label("2026-11-14").contains("14"))
        XCTAssertEqual(DelegationDates.label("nonsense"), "nonsense")
        XCTAssertEqual(DelegationDates.string(day(2026, 11, 3), calendar: pacific), "2026-11-03")
    }

    func testAPeriodSaysOneDayOrBoth() throws {
        XCTAssertFalse(try delegation(starts: "2026-11-14").periodLabel.contains(" to "))
        XCTAssertTrue(try delegation().periodLabel.contains(" to "))
    }

    func testOnlyWhatHasNotEndedCanBeCancelled() throws {
        XCTAssertTrue(try delegation(status: "ACTIVE").isOpen)
        XCTAssertTrue(try delegation(status: "SCHEDULED").isOpen)
        XCTAssertFalse(try delegation(status: "ENDED").isOpen)
        XCTAssertFalse(try delegation(status: "CANCELLED").isOpen)
        XCTAssertEqual(try delegation(status: "ACTIVE").statusLabel, "Active now")
    }

    func testTheFormSaysWhatIsMissing() {
        let today = day(2026, 11, 3)
        func problem(_ delegate: Int?, _ first: Date, _ last: Date) -> String? {
            DelegationDates.problem(delegate: delegate, first: first, last: last, today: today, calendar: pacific)
        }
        XCTAssertNotNil(problem(nil, today, today))
        XCTAssertNotNil(problem(1, day(2026, 11, 5), day(2026, 11, 4)))
        XCTAssertNotNil(problem(1, day(2026, 10, 1), day(2026, 10, 5)))
        XCTAssertNil(problem(1, today, today))
        XCTAssertNil(problem(1, day(2026, 10, 1), today), "already running")
    }

    func testWhatWasDoneReadsInWords() throws {
        func label(_ method: String, _ path: String) throws -> String {
            try snake.decode(DelegatedAction.self, from: Data(#"{"method": "\#(method)", "path": "\#(path)"}"#.utf8)).label
        }
        XCTAssertEqual(try label("POST", "/assessments/5/review"), "Reviewed assessment #5")
        XCTAssertEqual(try label("POST", "/assessments/5/assign-engineer"), "Changed assessment #5")
        XCTAssertEqual(try label("POST", "/assessments/move"), "Moved assessments")
        XCTAssertEqual(try label("POST", "/shares/3/reviews/4"), "Decided share #3")
        XCTAssertEqual(try label("PATCH", "/submissions/501/gisa"), "Changed form #501")
        XCTAssertEqual(try label("POST", "/notifications/read"), "POST /notifications/read")
    }

    func testActingDetailsAreReadFromTheAccount() throws {
        let me = try snake.decode(Me.self, from: Data("""
        {"id": 9, "email": "a@x", "full_name": "J. Chen", "roles": ["BRANCH_CHIEF"],
         "acting": {"delegation_id": 1, "user_id": 7, "full_name": "Sam"},
         "acting_options": [{"delegation_id": 1, "user_id": 9, "full_name": "J. Chen", "ends_on": "2026-11-14"}]}
        """.utf8))
        XCTAssertEqual(me.acting?.fullName, "Sam")
        XCTAssertEqual(me.actingOptions?.first?.userId, 9)
        let plain = try snake.decode(Me.self, from: Data(#"{"id": 9, "email": "a@x", "full_name": "A", "roles": []}"#.utf8))
        XCTAssertNil(plain.acting)
    }

    private func request(_ api: APIClient, authenticated: Bool = true) throws -> URLRequest {
        try api.makeRequest("GET", "/my-forms", query: [], body: nil, contentType: "application/json", authenticated: authenticated)
    }

    func testEveryRequestWhileActingSaysForWhom() throws {
        let api = APIClient(baseURL: URL(string: "https://eris.invalid/api")!, store: MemorySessionStore(token: "t"), transport: NoTransport())
        XCTAssertNil(try request(api).value(forHTTPHeaderField: "X-ERIS-Acting-For"))
        api.actingFor = 9
        XCTAssertEqual(try request(api).value(forHTTPHeaderField: "X-ERIS-Acting-For"), "9")
        XCTAssertNil(try request(api, authenticated: false).value(forHTTPHeaderField: "X-ERIS-Acting-For"))
        api.actingFor = nil
        XCTAssertNil(try request(api).value(forHTTPHeaderField: "X-ERIS-Acting-For"))
    }

    private func group(_ json: String) throws -> HeldWork { try snake.decode(HeldWork.self, from: Data(json.utf8)) }

    func testAGroupSaysWhoHoldsTheWorkAndWhetherTheyMovedOn() throws {
        let left = try group(#"{"kind": "STAFF", "holder": {"id": 4, "full_name": "Lee Left", "placement": null}, "left": true, "items": []}"#)
        XCTAssertEqual(left.holderLine, "Lee Left · Staff · has moved on")
        XCTAssertEqual(left.id, "STAFF:4")
        let nobody = try group(#"{"kind": "BRANCH_CHIEF", "holder": {"id": null, "full_name": null, "placement": null}, "left": true, "items": []}"#)
        XCTAssertEqual(nobody.holderLine, "Nobody · Branch chief · has moved on")
        XCTAssertEqual(nobody.id, "BRANCH_CHIEF:none")
        XCTAssertEqual(try group(#"{"kind": "SENIOR_SPECIALIST", "holder": {"id": 5, "full_name": "Sue", "placement": null}, "left": false, "items": []}"#).holderLine,
                       "Sue · Senior Specialist")
    }

    func testTheOutcomeSaysWhatMovedAndWhyNot() throws {
        func outcome(_ json: String) throws -> String {
            try snake.decode(MoveResult.self, from: Data(json.utf8)).outcome(to: "Sam")
        }
        XCTAssertEqual(try outcome(#"{"moved": [1], "failed": []}"#), "Moved 1 assessment to Sam. Their work stayed with them.")
        XCTAssertEqual(try outcome(#"{"moved": [1, 2], "failed": []}"#), "Moved 2 assessments to Sam. Their work stayed with them.")
        XCTAssertEqual(try outcome(#"{"moved": [], "failed": [{"id": 3, "detail": "In another branch."}]}"#),
                       "Nothing moved. Not moved: #3 (In another branch.)")
    }
}

private struct NoTransport: HTTPTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) { throw URLError(.notConnectedToInternet) }
}
