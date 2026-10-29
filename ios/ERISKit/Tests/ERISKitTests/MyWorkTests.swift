import XCTest
@testable import ERISKit

private let snake: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return decoder
}()

private func incident(_ id: Int, lat: Double? = nil, lon: Double? = nil, observed: String? = nil) -> Incident {
    let json: [String: Any] = ["id": id, "title": "Report \(id)", "current_stage": "COORDINATOR_REVIEW", "status": "NEW",
                               "latitude": lat as Any? ?? NSNull(), "longitude": lon as Any? ?? NSNull(),
                               "first_observed_at": observed as Any? ?? NSNull()]
    return try! snake.decode(Incident.self, from: JSONSerialization.data(withJSONObject: json))
}

private func assessment(_ id: Int, state: String = "DRAFT", updated: String) -> Assessment {
    let json: [String: Any] = ["id": id, "incident_id": 1, "state": state, "updated_at": updated]
    return try! snake.decode(Assessment.self, from: JSONSerialization.data(withJSONObject: json))
}

/// Ported from web/src/features/incidents/triageDecisionModel.test.ts.
final class TriageTests: XCTestCase {
    func testANewDraftHasNothingChosenAndCannotBeRecorded() {
        let fresh = Triage.Draft(incidentId: 42)
        XCTAssertNil(fresh.disposition)
        XCTAssertEqual(fresh.blocker, "Choose what happens to this report.")
        XCTAssertNil(fresh.body)
    }

    func testOnlyAnAssessmentAsksForAnIncidentGroup() {
        XCTAssertEqual(Triage.Disposition.allCases.filter(\.needsEventGroup), [.assessmentRequired])
    }

    func testAnAssessmentWaitsForItsIncidentGroupThenSendsItWithTheDecision() {
        var draft = Triage.Draft(incidentId: 42)
        draft.disposition = .assessmentRequired
        XCTAssertEqual(draft.blocker, "Choose its Incident Group, or start a new one.")
        draft.group = .existing(7)
        draft.notes = "  Slope failing.  "
        XCTAssertEqual(draft.body, ["disposition": .string("ASSESSMENT_REQUIRED"), "notes": .string("Slope failing."),
                                    "event_group": .object(["mode": .string("EXISTING"), "event_group_id": .number(7)])])
        draft.notes = ""
        draft.group = .new(title: " Slide at PM 84 ", description: "")
        XCTAssertEqual(draft.body, ["disposition": .string("ASSESSMENT_REQUIRED"),
                                    "event_group": .object(["mode": .string("CREATE_NEW"), "title": .string("Slide at PM 84")])])
    }

    func testAGroupChosenBeforeSwitchingToAnotherDecisionIsNeverSent() {
        var draft = Triage.Draft(incidentId: 42)
        draft.group = .existing(7)
        draft.disposition = .noAssessmentRequired
        XCTAssertNil(draft.blocker)
        XCTAssertEqual(draft.body, ["disposition": .string("NO_ASSESSMENT_REQUIRED")])
    }

    func testSendingAReportBackNeedsSomethingForTheReporterToFix() {
        var draft = Triage.Draft(incidentId: 42)
        draft.disposition = .needsReporterInformation
        XCTAssertEqual(draft.blocker, "Say what the reporter should correct.")
        draft.notes = "The post mile marker is wrong."
        XCTAssertNil(draft.blocker)
        draft.notes = ""
        draft.revisionFields = ["post_mile", "route"]
        XCTAssertEqual(draft.body, ["disposition": .string("NEEDS_REPORTER_INFORMATION"),
                                    "revision_fields": .array([.string("post_mile"), .string("route")])])
    }

    func testADuplicateNamesTheReportItRepeats() {
        var draft = Triage.Draft(incidentId: 42)
        draft.disposition = .duplicateOrLinked
        XCTAssertEqual(draft.blocker, "Choose the report it repeats.")
        draft.duplicateOf = 9
        XCTAssertEqual(draft.body, ["disposition": .string("DUPLICATE_OR_LINKED"), "target_incident_id": .number(9)])
    }

    func testTheConfirmButtonAndTheOutcomeSayWhatHappened() {
        var draft = Triage.Draft(incidentId: 42)
        XCTAssertEqual(draft.confirmLabel, "Record decision")
        draft.disposition = .assessmentRequired
        XCTAssertEqual(draft.confirmLabel, "Accept and open assessment")
        XCTAssertTrue(draft.outcome(assessmentId: 5).contains("Assessment #5 is open"))
        draft.disposition = .duplicateOrLinked
        draft.duplicateOf = 9
        XCTAssertEqual(draft.outcome(assessmentId: nil), "Report #42 closed as a duplicate of report #9.")
    }

    func testDuplicateCandidatesAreOtherNearbyReportsNearestFirst() {
        let pin = incident(42, lat: 40.6, lon: -124.1)
        let reports = [incident(42, lat: 40.6, lon: -124.1), incident(10, lat: 40.61, lon: -124.1),
                       incident(11, lat: 40.601, lon: -124.1), incident(12, lat: 38.0, lon: -122.5)]
        let candidates = Triage.duplicateCandidates(of: pin, among: reports)
        XCTAssertEqual(candidates.map(\.id), [11, 10])
        XCTAssertTrue(candidates[0].distanceM > 100 && candidates[0].distanceM < 120)
        XCTAssertEqual(Triage.duplicateCandidates(of: pin, among: reports, limit: 1).count, 1)
    }

    func testACandidatesDistanceReadsAsWords() {
        XCTAssertEqual(Triage.distanceLabel(0), "At the same spot")
        XCTAssertEqual(Triage.distanceLabel(112.4), "112 m away")
        XCTAssertEqual(Triage.distanceLabel(3218.7), "2.0 mi away")
    }
}

final class MaintenanceWorkTests: XCTestCase {
    private func workflow(_ extra: String = "", step: String = #"{"name": "Supervisor review", "kind": "REVIEW", "rule": "ALL", "request_information": true, "allow_maintenance": true, "allow_geotech": false}"#,
                          state: String = #"{"step_index": 0, "approved_user_ids": [], "waiting_reporter": false}"#,
                          canAct: Bool = true) throws -> MaintenanceWorkflow {
        try JSONDecoder().decode(MaintenanceWorkflow.self, from: Data("""
        {"incident_id": 10, "district": "03", "revision": 2, "version": 5, "state": \(state), "step": \(step),
         "steps": [{"name": "Supervisor review", "kind": "REVIEW"}, {"name": "Decision", "kind": "DECISION"}],
         "outcome": null, "assigned": [{"id": 4, "full_name": "Ana Ruiz", "is_active": true},
                                        {"id": 5, "full_name": "Ben Cho", "is_active": false}],
         "events": [{"id": 1, "action": "REPORTED", "notes": null, "actor_name": "Reporter", "created_at": "2026-10-28T09:00:00"}],
         "groups": [{"id": 3, "title": "I-880 slides"}],
         "can_act": \(canAct), "can_edit": false, "can_resubmit": false, "can_restart": true \(extra)}
        """.utf8))
    }

    func testTheActionsOfferedFollowTheStepAsTheWebPanelDoes() throws {
        let review = try workflow()
        XCTAssertEqual(review.actions, [.approve, .maintenance, .requestInformation, .restart])
        XCTAssertEqual(review.standing, "Current step: Supervisor review · Every assigned person must agree")
        XCTAssertEqual(review.assignedLine, "Assigned: Ana Ruiz, Ben Cho (inactive — ask a manager to update the workflow).")
        XCTAssertEqual(review.events.first?.label, "Report filed")

        let pending = try workflow(step: #"{"name": "Decision", "kind": "DECISION", "rule": "ALL", "allow_maintenance": true, "allow_geotech": true}"#,
                                   state: #"{"step_index": 1, "approved_user_ids": [4], "waiting_reporter": false, "pending_outcome": "GEOTECH"}"#)
        XCTAssertEqual(pending.actions, [.geotech, .restart], "decision makers agree on one outcome")
        XCTAssertEqual(pending.assignedLine, "Assigned: Ana Ruiz, Ben Cho (inactive — ask a manager to update the workflow). 1 review recorded for GeoTech referral.")

        let reader = try workflow(canAct: false)
        XCTAssertEqual(reader.actions, [.restart])
    }

    func testAnActionNeedsNotesAndAReferralNamesItsGroup() throws {
        let flow = try workflow()
        XCTAssertNil(flow.request(.approve, notes: "  ", description: nil, groupId: nil, newGroupTitle: nil))
        XCTAssertEqual(flow.request(.approve, notes: " Checked ", description: nil, groupId: nil, newGroupTitle: nil),
                       ["version": .number(5), "action": .string("APPROVE"), "notes": .string("Checked")])
        XCTAssertEqual(flow.request(.geotech, notes: "Slope", description: nil, groupId: 3, newGroupTitle: "ignored"),
                       ["version": .number(5), "action": .string("GEOTECH"), "notes": .string("Slope"),
                        "event_group_id": .number(3), "new_group_title": .null])
        XCTAssertEqual(flow.request(.geotech, notes: "Slope", description: nil, groupId: nil, newGroupTitle: " PM 4 slide ")?["new_group_title"],
                       .string("PM 4 slide"))
        XCTAssertEqual(flow.request(.resubmit, notes: "Added", description: "Wider crack", groupId: nil, newGroupTitle: nil)?["description"],
                       .string("Wider crack"))
    }

    func testAReportSaysWhereItStands() {
        let report = MaintenanceReport(id: 1, title: "Rockfall", district: "04", outcome: nil, stepName: "Review",
                                       waitingReporter: true, myTurn: false)
        XCTAssertEqual(report.status, "Waiting on reporter")
        XCTAssertEqual(report.districtLabel, "District 4")
        XCTAssertEqual(MaintenanceReport(id: 1, title: nil, district: "04", outcome: "GEOTECH", stepName: "Review",
                                         waitingReporter: false, myTurn: false).status, "Sent to GeoTech")
    }
}

final class ShareReviewTests: XCTestCase {
    private func review(kind: String, status: String = "PENDING") throws -> ShareReview {
        try JSONDecoder().decode(ShareReview.self, from: Data("""
        {"review_id": 8, "share_id": 3, "kind": "\(kind)", "unit_label": "Branch C", "status": "\(status)",
         "created_at": "2026-10-28T09:00:00", "submission": {"id": 501, "title": "Slip at PM 4"},
         "owner": {"id": 1, "full_name": "A. Lee", "email": "a@x"}, "sharer": {"id": 1, "full_name": "A. Lee", "email": "a@x"},
         "recipient": {"id": 2, "full_name": "", "email": "b.cho@dot.ca.gov", "placement": "Branch D"},
         "reviews": [{"id": 8, "unit_label": "Branch C", "kind": "APPROVAL", "decision": "PENDING", "decided_by": null},
                     {"id": 9, "unit_label": "Branch D", "kind": "APPROVAL", "decision": "APPROVED", "decided_by": "M. Okafor"},
                     {"id": 10, "unit_label": "Office West", "kind": "NOTICE", "decision": "REJECTED", "decided_by": "P. Shah"}]}
        """.utf8))
    }

    func testAShareSaysWhoSharesWhatAndWhereEachReviewStands() throws {
        let approval = try review(kind: "APPROVAL")
        XCTAssertEqual(approval.headline, "A. Lee is sharing “Slip at PM 4” with b.cho@dot.ca.gov")
        XCTAssertEqual(approval.reviews.map(\.line), ["Branch C — waiting for approval", "Branch D — approved by M. Okafor",
                                                      "Office West — stopped by P. Shah"])
        XCTAssertEqual(approval.decisions.map(\.1), ["Approve", "Reject"])
        XCTAssertEqual(approval.outcome(.approve, status: "PENDING"), "Approved. It takes effect once the other branch chief approves too.")
        XCTAssertEqual(approval.outcome(.approve, status: "ACTIVE"), "Approved. The form is now shared.")

        let notice = try review(kind: "NOTICE", status: "ACTIVE")
        XCTAssertEqual(notice.decisions.map(\.1), ["Keep it", "Stop sharing"])
        XCTAssertEqual(notice.explanation, "It is in effect. You need not do anything; you may stop it.")
        XCTAssertEqual(notice.outcome(.reject, status: "REVOKED"), "Stopped. The form is no longer shared.")
    }
}

final class MyWorkTests: XCTestCase {
    private let reports = [
        MaintenanceReport(id: 20, title: "Mine", district: "04", outcome: nil, stepName: "Review", waitingReporter: false, myTurn: true),
        MaintenanceReport(id: 21, title: "Readable", district: "04", outcome: nil, stepName: "Review", waitingReporter: false, myTurn: false),
    ]

    func testTheQueueListsTriageThenMaintenanceThenAssessmentsNewestFirst() {
        let loaded = MyWork.Loaded(triage: [incident(1, observed: "2026-10-27"), incident(2, observed: "2026-10-28")],
                                   reports: reports,
                                   assessments: [assessment(5, updated: "2026-10-26"), assessment(6, updated: "2026-10-28"),
                                                 assessment(5, updated: "2026-10-26")])
        XCTAssertEqual(MyWork.items(loaded).map(\.id), ["t2", "t1", "m20", "a6", "a5"], "one copy of an assessment in two queues")
        XCTAssertEqual(loaded.otherReports, 1)
        XCTAssertEqual(MyWork.items(loaded, includeOtherReports: true).map(\.id), ["t2", "t1", "m20", "m21", "a6", "a5"])
        XCTAssertEqual(MyWork.items(loaded, opened: 21).map(\.id), ["t2", "t1", "m20", "m21", "a6", "a5"], "opened by a link")
    }

    func testAnAdministratorChoosesOneSideOrBoth() {
        let loaded = MyWork.Loaded(triage: [incident(1)], reports: reports, assessments: [assessment(6, updated: "2026-10-28")])
        XCTAssertEqual(MyWork.items(loaded, filter: .geotech, admin: true).map(\.id), ["a6"])
        XCTAssertEqual(MyWork.items(loaded, filter: .maintenance, admin: true).map(\.id), ["t1", "m20"])
        XCTAssertEqual(MyWork.items(loaded, filter: .geotech, admin: false).count, 3, "the choice is an administrator's")
    }

    func testWhoHasAQueueAndWhatTheirsDrawsOn() {
        XCTAssertTrue(MyWork.hasQueue(roles: ["GUEST"], maintenanceDuties: true), "a maintenance duty is enough")
        XCTAssertFalse(MyWork.hasQueue(roles: ["GUEST"], maintenanceDuties: false))
        XCTAssertTrue(MyWork.hasQueue(roles: ["MAINTENANCE_COORDINATOR"], maintenanceDuties: false))
        XCTAssertEqual(MyWork.assessmentLists(roles: ["OFFICE_CHIEF"]).map(\.queue), [.officeChief, .officeChiefReview])
        let staff = MyWork.assessmentLists(roles: ["STAFF"])
        XCTAssertEqual(staff.map(\.queue), [.assignee])
        XCTAssertFalse(staff[0].keep(assessment(1, state: "SUBMITTED", updated: "")), "their own drafts and returned ones")
        XCTAssertEqual(MyWork.assessmentLists(roles: ["ADMIN"]).last?.state, "SUBMITTED")
    }
}

final class AppTabTests: XCTestCase {
    private func tabs(_ roles: [String], duties: Bool = false, reports: Bool = false) -> [AppTab] {
        AppTab.visible(roles: roles, maintenanceDuties: duties, reportsForMaintenance: reports)
    }

    func testEachPersonGetsTheToolsTheirJobNeedsAndNothingToBrowse() {
        XCTAssertEqual(tabs(["MAINTENANCE_CREW"]), [.report, .notifications, .account])
        XCTAssertEqual(tabs(["GUEST"], duties: true, reports: true), [.myWork, .report, .notifications, .account],
                       "a district reporter who also reviews")
        XCTAssertEqual(tabs(["GUEST"], duties: true), [.myWork, .notifications, .account], "a district reviewer")
        XCTAssertEqual(tabs(["MAINTENANCE_COORDINATOR"]), [.myWork, .notifications, .account])
        XCTAssertEqual(tabs(["OFFICE_CHIEF"]), [.myWork, .notifications, .account])
        XCTAssertEqual(tabs(["BRANCH_CHIEF"]), [.myWork, .notifications, .account])
        XCTAssertEqual(tabs(["STAFF"]), [.myWork, .forms, .notifications, .account])
        XCTAssertEqual(tabs(["SENIOR_SPECIALIST"]), [.myWork, .forms, .notifications, .account])
        XCTAssertEqual(tabs(["GUEST"]), [.notifications, .account], "a read-only viewer uses the web")
        XCTAssertEqual(tabs(["ADMIN"]), AppTab.allCases)
    }

    func testAMaintenanceDutyThatReportsIsReadFromTheAccount() throws {
        let me = try snake.decode(Me.self, from: Data("""
        {"id": 1, "email": "a@x", "full_name": "A", "roles": ["GUEST"],
         "maintenance_districts": [{"district": "04", "report": true, "manage": false}]}
        """.utf8))
        XCTAssertTrue(me.reportsForMaintenance)
        XCTAssertEqual(AppTab.visible(for: me), [.myWork, .report, .notifications, .account])
    }

    func testMyReportsAreTheOnesIFiled() {
        let filed = [incident(30), incident(31)]
        let reports = [
            MaintenanceReport(id: 40, title: nil, district: "04", outcome: nil, stepName: "Review", waitingReporter: true, myTurn: true),
            MaintenanceReport(id: 41, title: nil, district: "04", outcome: nil, stepName: "Review", waitingReporter: false, myTurn: true),
            MaintenanceReport(id: 42, title: nil, district: "04", outcome: nil, stepName: "Review", waitingReporter: false,
                              myTurn: false, reportedByMe: true),
        ]
        // incident() has no reporter: only reports filed by this person are listed.
        XCTAssertEqual(MyReports.items(incidents: filed, maintenance: reports, me: 7).map(\.id), [42, 40])
    }
}

final class IncidentReadTests: XCTestCase {
    func testOneIncidentIsReadFromTheEnvelopeTheServerSends() async throws {
        let transport = FakeTransport { _ in
            .init(status: 200, body: #"{"incident": {"id": 14, "title": "Rockfall", "current_stage": "COORDINATOR_REVIEW", "status": "NEW", "maintenance_workflow": false}, "requested_by_user_id": 1}"#)
        }
        let api = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"), transport: transport)
        let incident = try await IncidentsAPI(api: api).get(14)
        XCTAssertEqual(incident.title, "Rockfall")
        XCTAssertEqual(transport.paths(), ["GET /api/incidents/14"])
    }
}
