import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class AssessmentsAPITests: XCTestCase {
    private func client(_ transport: FakeTransport) -> AssessmentsAPI {
        AssessmentsAPI(api: APIClient(baseURL: base, store: MemorySessionStore(token: "t"), transport: transport))
    }

    private func assessment(_ fields: String) throws -> Assessment {
        try JSONDecoder.snakeCase.decode(Assessment.self, from: Data("""
        {"id": 3, "incident_id": 12, "created_by_user_id": 1, \(fields)}
        """.utf8))
    }

    func testAQueueIsRequestedAndRoutingIsDescribedByName() async throws {
        let transport = FakeTransport { _ in
            .init(status: 200, body: """
            {"items": [{"id": 3, "assessment_uuid": "u", "incident_id": 12, "submission_id": null, "district": "04",
              "office_code": "OGD-N", "routed_office_name": "Office of Geotechnical Design North",
              "routed_branch_name": "Branch C", "routing_path": "BRANCH", "can_review": false,
              "state": "PENDING_ENGINEER_ASSIGNMENT", "created_by_user_id": 1}]}
            """)
        }
        let item = try await client(transport).list(queue: .branchChief)[0]
        XCTAssertEqual(transport.requests.first?.url?.query, "queue=branch_chief")
        XCTAssertEqual(item.officeLabel, "Office of Geotechnical Design North")
        XCTAssertEqual(item.branchLabel, "Branch C")
        XCTAssertEqual(RoleModel.assessmentStateLabel(item.state), "Pending Staff assignment")
    }

    func testOfficeAndBranchFallBackOnePartAtATime() throws {
        let unrouted = try assessment(#""office_code": "OGD-S", "routed_office_name": "  ", "state": "DRAFT""#)
        XCTAssertEqual(unrouted.officeLabel, "OGD-S")
        XCTAssertNil(unrouted.branchLabel)
        let lettered = try assessment(#""routed_branch_letter": "E", "state": "DRAFT""#)
        XCTAssertEqual(lettered.officeLabel, "—")
        XCTAssertEqual(lettered.branchLabel, "Branch E")
    }

    func testTheDetailCarriesTheTimeline() async throws {
        let transport = FakeTransport { _ in
            .init(status: 200, body: """
            {"assessment": {"id": 3, "incident_id": 12, "state": "SUBMITTED", "can_review": true, "created_by_user_id": 1},
             "assignments": [{"id": 1, "user_id": 5, "assignment_role": "ENGINEER", "assigned_by_user_id": 2,
                              "notes": null, "email": "a@dot.ca.gov", "full_name": "A", "created_at": "2026-10-01T00:00:00Z"}],
             "events": [{"id": 9, "incident_id": 12, "actor_user_id": 5, "actor_name": null, "event_type": "SUBMITTED",
                         "disposition": null, "from_state": "DRAFT", "to_state": "SUBMITTED", "notes": "Ready",
                         "created_at": "2026-10-02T00:00:00Z"}]}
            """)
        }
        let detail = try await client(transport).detail(3)
        XCTAssertEqual(transport.requests.first?.url?.path, "/api/assessments/3")
        XCTAssertEqual(detail.events.map(\.eventType), ["SUBMITTED"])
        XCTAssertEqual(detail.events[0].actorLabel, "user #5")
    }

    func testThePickersAskTheRightEndpointsAndKeepTheirGroups() async throws {
        let transport = FakeTransport { _ in
            .init(status: 200, body: """
            {"assessment_id": 3, "office_code": "WEST", "kind": "ENGINEER",
             "groups": [{"group_key": "b:3", "label": "Branch C", "branch_id": 3, "branch_letter": "C",
                         "branch_name": "Branch C", "accepts_assignments": true, "is_active": true, "is_own_branch": true}],
             "items": [{"id": 41, "email": "a@dot.ca.gov", "full_name": "A. Rivera", "office_code": "WEST",
                        "office_name": null, "branch_id": 3, "branch_letter": "C", "branch_name": "Branch C",
                        "home_city": "Oakland", "home_district": "04", "open_assessment_count": 2,
                        "awaiting_action_count": 1, "availability": "AVAILABLE", "available_from": null,
                        "available_until": null, "group_key": "b:3", "roles": ["STAFF"]}]}
            """)
        }
        let api = client(transport)
        let staff = try await api.engineerOptions(3)
        _ = try await api.branchOptions(3)
        XCTAssertEqual(transport.requests[0].url?.path, "/api/admin/assessment-assignment-options/3")
        XCTAssertEqual(transport.requests[0].url?.query, "kind=ENGINEER")
        XCTAssertEqual(transport.requests[1].url?.path, "/api/assessments/3/branch-options")
        XCTAssertEqual(staff.sections.map(\.label), ["Branch C"])
        XCTAssertEqual(staff.items[0].workloadNote, "2 open · 1 waiting on them")
        XCTAssertEqual(staff.items[0].placeNote, "Branch C · Oakland D4")
    }

    func testEachStepPostsItsBodyWithNotesOnlyWhenWritten() async throws {
        let transport = FakeTransport { _ in .init(status: 200, body: #"{"assessment": {}}"#) }
        let api = client(transport)
        try await api.delegateBranch(3, branchChiefUserId: 7, notes: "  ")
        try await api.assignEngineer(3, engineerUserId: 41, notes: " Covers Branch D this month ")
        try await api.submit(3, notes: nil)
        try await api.review(3, action: .requestRevision, notes: "Add boring logs")

        let sent = try transport.requests.map { request -> (String, [String: JSONValue]) in
            XCTAssertEqual(request.httpMethod, "POST")
            let body = try JSONDecoder().decode([String: JSONValue].self, from: try XCTUnwrap(request.httpBody))
            return (request.url!.path, body)
        }
        XCTAssertEqual(sent.map(\.0), ["/api/assessments/3/delegate-branch", "/api/assessments/3/assign-engineer",
                                       "/api/assessments/3/submit", "/api/assessments/3/review"])
        XCTAssertEqual(sent[0].1, ["branch_chief_user_id": .number(7)])
        XCTAssertEqual(sent[1].1, ["engineer_user_id": .number(41), "notes": .string("Covers Branch D this month")])
        XCTAssertEqual(sent[2].1, [:])
        XCTAssertEqual(sent[3].1, ["action": .string("REQUEST_REVISION"), "notes": .string("Add boring logs")])
    }

    func testEachRoleIsOfferedOnlyItsOwnStep() throws {
        let toRoute = try assessment(#""state": "PENDING_OFFICE_DELEGATION""#)
        XCTAssertTrue(AssessmentActions(assessment: toRoute, roles: ["OFFICE_CHIEF"], meId: 1).delegate)
        XCTAssertFalse(AssessmentActions(assessment: toRoute, roles: ["BRANCH_CHIEF"], meId: 1).delegate)

        let branchRoute = try assessment(#""state": "PENDING_ENGINEER_ASSIGNMENT", "routing_path": "BRANCH""#)
        let chief = AssessmentActions(assessment: branchRoute, roles: ["BRANCH_CHIEF"], meId: 1)
        XCTAssertTrue(chief.assign)
        XCTAssertFalse(chief.assignNotOnThisRoute)
        XCTAssertFalse(AssessmentActions(assessment: branchRoute, roles: ["STAFF"], meId: 1).assign)

        let seniorRoute = try assessment(#""state": "PENDING_ENGINEER_ASSIGNMENT", "routing_path": "SENIOR_ENGINEER""#)
        let onSenior = AssessmentActions(assessment: seniorRoute, roles: ["BRANCH_CHIEF"], meId: 1)
        XCTAssertFalse(onSenior.assign)
        XCTAssertTrue(onSenior.assignNotOnThisRoute)
    }

    func testOnlyTheAssigneeOrAnAdministratorSubmits() throws {
        for state in ["DRAFT", "REVISION_REQUESTED"] {
            let mine = try assessment(#""state": "\#(state)", "assigned_engineer_user_id": 41"#)
            XCTAssertTrue(AssessmentActions(assessment: mine, roles: ["STAFF"], meId: 41).submit)
            XCTAssertFalse(AssessmentActions(assessment: mine, roles: ["STAFF"], meId: 42).submit)
            XCTAssertFalse(AssessmentActions(assessment: mine, roles: ["STAFF"], meId: nil).submit)
            XCTAssertTrue(AssessmentActions(assessment: mine, roles: ["ADMIN"], meId: 1).submit)
        }
        let unassigned = try assessment(#""state": "DRAFT""#)
        XCTAssertFalse(AssessmentActions(assessment: unassigned, roles: ["STAFF"], meId: nil).submit)
        let submitted = try assessment(#""state": "SUBMITTED", "assigned_engineer_user_id": 41"#)
        XCTAssertFalse(AssessmentActions(assessment: submitted, roles: ["STAFF"], meId: 41).submit)
    }

    func testReviewAuthorityComesFromTheServerNotTheRole() throws {
        let canReview = try assessment(#""state": "SUBMITTED", "can_review": true"#)
        let cannot = try assessment(#""state": "SUBMITTED", "can_review": false"#)
        XCTAssertTrue(AssessmentActions(assessment: canReview, roles: ["STAFF"], meId: 1).review)
        XCTAssertFalse(AssessmentActions(assessment: cannot, roles: ["ADMIN", "BRANCH_CHIEF"], meId: 1).review)
        XCTAssertTrue(AssessmentActions(assessment: cannot, roles: ["BRANCH_CHIEF"], meId: 1).explainReview)
    }

    func testTheBadgeToneFollowsTheState() {
        XCTAssertEqual(AssessmentTone(state: "APPROVED"), .done)
        XCTAssertEqual(AssessmentTone(state: "FINALIZED"), .done)
        XCTAssertEqual(AssessmentTone(state: "REVISION_REQUESTED"), .attention)
        XCTAssertEqual(AssessmentTone(state: "SUBMITTED"), .inReview)
        XCTAssertEqual(AssessmentTone(state: "PENDING_OFFICE_DELEGATION"), .waiting)
        XCTAssertEqual(AssessmentTone(state: "DRAFT"), .neutral)
    }
}

extension JSONDecoder {
    static var snakeCase: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}
