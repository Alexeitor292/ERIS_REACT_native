import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import ERISKit

final class FieldNoticesTests: XCTestCase {
    private func store() -> OfflineStore {
        OfflineStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    }

    func testADeliveryNeedsActionsAndADescription() {
        XCTAssertNotNil(ImmediateDeliveries.problem(actions: [], description: "Rocks"))
        XCTAssertNotNil(ImmediateDeliveries.problem(actions: ["A"], description: "  "))
        XCTAssertNil(ImmediateDeliveries.problem(actions: ["A"], description: "Rocks"))
    }

    func testItSaysWhoHeard() {
        XCTAssertEqual(ImmediateDeliveries.outcome(supervisor: true, contact: true), "Delivered to the supervisor and the District Contact.")
        XCTAssertEqual(ImmediateDeliveries.outcome(supervisor: false, contact: true), "Delivered to the District Contact.")
        XCTAssertTrue(ImmediateDeliveries.outcome(supervisor: false, contact: false).contains("no supervisor"))
    }

    func testADeliveryWaitingIsKeptAndCounted() {
        let kept = store()
        let queued = QueuedDelivery(submissionId: 7, actions: ["CLOSE_HIGHWAY_SHOULDER"], description: "Rocks")
        kept.keepDelivery(queued)
        XCTAssertEqual(kept.deliveries(for: 7), [queued])
        XCTAssertEqual(kept.deliveries(for: 8), [])
        XCTAssertEqual(kept.waiting.summary, "1 immediate action notice waiting to send")
        XCTAssertFalse(kept.waiting.isEmpty)
        kept.removeDelivery(queued)
        XCTAssertTrue(kept.waiting.isEmpty)
    }

    func testAHandOffNeedsAContactOnlyWhenSomeoneCouldBeNamed() {
        var draft = Triage.Draft(incidentId: 1)
        draft.disposition = .assessmentRequired
        draft.group = .existing(3)
        XCTAssertNil(draft.blocker, "nobody listed in the district")
        draft.contactRequired = true
        XCTAssertEqual(draft.blocker, "Choose a District Contact.")
        draft.districtContact = 50
        XCTAssertNil(draft.blocker)
        guard case .number(let id)? = draft.body?["district_contact_user_id"] else { return XCTFail("the contact") }
        XCTAssertEqual(id, 50)
    }

    func testOnlyAHandOffSendsAContact() {
        var draft = Triage.Draft(incidentId: 1)
        draft.disposition = .noAssessmentRequired
        draft.districtContact = 50
        XCTAssertNil(draft.body?["district_contact_user_id"])
    }
}
