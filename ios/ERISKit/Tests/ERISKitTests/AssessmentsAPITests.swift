import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class AssessmentsAPITests: XCTestCase {
    func testAQueueIsRequestedAndRoutingIsDescribed() async throws {
        let transport = FakeTransport { _ in
            .init(status: 200, body: """
            {"items": [{"id": 3, "assessment_uuid": "u", "incident_id": 12, "submission_id": null, "district": "04",
              "office_code": "OGD-N", "routed_office_name": "Office of Geotechnical Design North",
              "routed_branch_name": "Branch C", "routing_path": "BRANCH", "can_review": false,
              "state": "PENDING_ENGINEER_ASSIGNMENT", "created_by_user_id": 1}]}
            """)
        }
        let api = AssessmentsAPI(api: APIClient(baseURL: base, store: MemorySessionStore(token: "t"), transport: transport))
        let item = try await api.list(queue: .branchChief)[0]
        XCTAssertEqual(transport.requests.first?.url?.query, "queue=branch_chief")
        XCTAssertEqual(item.routedTo, "Office of Geotechnical Design North › Branch C")
        XCTAssertEqual(RoleModel.assessmentStateLabel(item.state), "Pending Staff assignment")
    }

    func testEachRoleSeesItsOwnWorklists() {
        XCTAssertEqual(AssessmentQueue.queues(for: ["OFFICE_CHIEF"]), [.officeChief, .officeChiefReview])
        XCTAssertEqual(AssessmentQueue.queues(for: ["BRANCH_CHIEF"]), [.branchChief, .branchChiefReview])
        XCTAssertEqual(AssessmentQueue.queues(for: ["STAFF"]), [.assignee])
        XCTAssertEqual(AssessmentQueue.queues(for: ["SENIOR_SPECIALIST"]), [.assignee])
        XCTAssertEqual(AssessmentQueue.queues(for: ["MAINTENANCE_CREW"]), [])
        XCTAssertEqual(AssessmentQueue.queues(for: ["GUEST"]), [])
    }
}
