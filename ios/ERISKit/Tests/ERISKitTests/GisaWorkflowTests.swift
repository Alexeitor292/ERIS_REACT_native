import XCTest
@testable import ERISKit

final class GisaWorkflowTests: XCTestCase {
    private func detail(_ json: String) throws -> SubmissionDetail {
        try JSONDecoder().decode(SubmissionDetail.self, from: Data(json.utf8))
    }

    private var located: GisaForm {
        var form = GisaForm()
        for (key, value) in [("district", "04"), ("county", "ALA"), ("route", "880"), ("post_mile", "1.00"),
                             ("latitude", "37.7"), ("longitude", "-122.1")] {
            form[key] = value
        }
        return form
    }

    func testTheRequirementsAreTheServersInTheEditorsOrder() {
        var form = GisaForm()
        form["county"] = "ALA"
        let first = GisaWorkflow.requirements(form: form, photoCount: 0)
        XCTAssertEqual(first.map(\.kind), [.location, .geotechnical, .photo])
        XCTAssertEqual(first[0].problem, "Missing: District, Route, Post Mile, Latitude, Longitude.")
        XCTAssertEqual(GisaWorkflow.submitProblem(first),
                       .init(title: "Almost there", message: "Please fill the highlighted required fields before continuing."))

        form = located
        let second = GisaWorkflow.requirements(form: form, photoCount: 0)
        XCTAssertTrue(second[0].met)
        XCTAssertEqual(GisaWorkflow.submitProblem(second),
                       .init(title: "Cannot Submit Yet", message: "Geotechnical Assessment is required before submitting."))

        form["geotechnical_assessment_notes_html"] = "<p>Stable for now.</p>"
        XCTAssertEqual(GisaWorkflow.submitProblem(GisaWorkflow.requirements(form: form, photoCount: 0))?.message,
                       "Please upload at least one photo before submitting.")
        XCTAssertNil(GisaWorkflow.submitProblem(GisaWorkflow.requirements(form: form, photoCount: 1)))
    }

    func testSoilAndDebrisAreCheckedOnlyWhenTheyApply() {
        var form = located
        form["geotechnical_assessment_notes_html"] = "<p>Done.</p>"
        form["material_soil"] = "YES"
        form["est_clay_pct"] = "40"
        form["est_silt_pct"] = "20"
        form["est_debris_sand_pct"] = "100"
        let requirements = GisaWorkflow.requirements(form: form, photoCount: 2)
        XCTAssertEqual(requirements.map(\.kind), [.location, .geotechnical, .photo, .soil, .debris])
        XCTAssertFalse(requirements[3].met)
        XCTAssertTrue(requirements[4].met)
        XCTAssertEqual(GisaWorkflow.submitProblem(requirements)?.message,
                       "Material Soil percentages must total 100%. Current total is 60.00% (under by 40.00%).")
    }

    func testTheServersRefusalIsPutInWords() {
        XCTAssertEqual(GisaWorkflow.submitRefusal("Cannot submit: missing required fields [photo]"),
                       "Please upload at least one photo before submitting.")
        XCTAssertEqual(GisaWorkflow.submitRefusal("Cannot submit: missing required fields [geotechnical_assessment, photo]"),
                       "Please complete required items before submitting: geotechnical_assessment, photo.")
        XCTAssertNil(GisaWorkflow.submitRefusal("Only DRAFT or REJECTED submissions can be submitted"))
    }

    func testNotifyingNeedsAnImmediateActionAndAMessage() {
        XCTAssertEqual(GisaWorkflow.notifyProblem(immediate: [], message: "Road is closing")?.title, "Immediate Action Required")
        XCTAssertEqual(GisaWorkflow.notifyProblem(immediate: ["CLOSE_LANE"], message: "  \n")?.message,
                       "Please add a justification message before notifying.")
        XCTAssertNil(GisaWorkflow.notifyProblem(immediate: ["CLOSE_LANE"], message: "Road is closing"))
    }

    func testEarlierNoticesAreReadFromTheFormsEvents() throws {
        let detail = try detail("""
        {"submission": {"id": 5, "status": "DRAFT"}, "gisa": {},
         "workflow_events": [
           {"id": 1, "event_type": "CREATE", "comment": null, "created_at": "2026-10-28T09:00:00"},
           {"id": 2, "event_type": "COORDINATOR_NOTIFIED", "from_status": "DRAFT", "to_status": "DRAFT",
            "comment": "Immediate actions: CLOSE_LANE, REMOVE_DEBRIS | Message: Rock on the road | lane 2",
            "created_at": "2026-10-28T10:00:00"},
           {"id": 3, "event_type": "COORDINATOR_NOTIFIED", "comment": "Something else", "created_at": "2026-10-28T11:00:00"}]}
        """)
        let notices = GisaWorkflow.coordinatorNotices(detail.workflowEvents ?? [])
        XCTAssertEqual(notices.map(\.id), [3, 2], "newest first")
        XCTAssertEqual(notices[1].actions, ["CLOSE_LANE", "REMOVE_DEBRIS"])
        XCTAssertEqual(notices[1].message, "Rock on the road | lane 2")
        XCTAssertEqual(notices[0].message, "Something else")
        let lookups = GisaLookups(distribution: [], highwayStatus: [], incidentTypes: [],
                                  actions: .init(immediate: [GisaOption(code: "CLOSE_LANE", label: "Close lane")], followUp: []))
        XCTAssertEqual(GisaWorkflow.actionLabels(notices[1].actions, lookups: lookups), ["Close lane", "REMOVE_DEBRIS"])
    }

    func testAFormOfAnAssessmentIsSentAndDecidedThere() throws {
        let linked = try detail("""
        {"submission": {"id": 5, "status": "SUBMITTED", "can_review": true}, "gisa": {},
         "context": {"incident_id": 12, "incident_title": "Slip", "event_group_id": null, "assessment_id": 3,
                     "assessment_state": "SUBMITTED", "assessment_routing_path": "BRANCH", "can_review": true}}
        """)
        XCTAssertEqual(linked.context?.incidentId, 12)
        XCTAssertEqual(GisaWorkflow.route(linked), .assessment(3))
        XCTAssertFalse(GisaWorkflow.decidesHere(linked), "the server refuses a decision on the form")
        XCTAssertEqual(GisaWorkflow.submittedHint(linked), "Awaiting branch chief review")

        let legacy = try detail(#"{"submission": {"id": 6, "status": "SUBMITTED", "can_review": true}, "gisa": {}, "context": null}"#)
        XCTAssertEqual(GisaWorkflow.route(legacy), .form)
        XCTAssertTrue(GisaWorkflow.decidesHere(legacy))
        XCTAssertEqual(GisaWorkflow.submittedHint(legacy), "Sent for review")

        let incidentOnly = try detail("""
        {"submission": {"id": 7, "status": "SUBMITTED", "can_review": false}, "gisa": {},
         "context": {"incident_id": 4, "assessment_id": null}}
        """)
        XCTAssertEqual(GisaWorkflow.route(incidentOnly), .form)
        XCTAssertFalse(GisaWorkflow.decidesHere(incidentOnly), "only those the server allows")
    }
}
