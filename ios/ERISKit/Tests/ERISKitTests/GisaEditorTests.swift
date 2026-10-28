import XCTest
@testable import ERISKit

final class GisaEditorTests: XCTestCase {
    private func detail(_ gisa: String, incidentTypes: String = "[]", actions: String = #"{"immediate": [], "follow_up": []}"#)
        throws -> SubmissionDetail {
        try JSONDecoder().decode(SubmissionDetail.self, from: Data("""
        {"submission": {"id": 501, "status": "DRAFT", "created_at": "2026-10-28T09:00:00", "can_edit": true},
         "gisa": \(gisa), "incident_types": \(incidentTypes), "actions": \(actions), "photos": [], "workflow_events": []}
        """.utf8))
    }

    private let located = #"{"district": "04", "county": "ALA", "route": "880", "post_mile": "12.3", "latitude": 37.7312, "longitude": -122.1975}"#

    func testChoosingADistrictKeepsOnlyWhatStillFits() {
        var form = GisaForm()
        form.chooseCounty("ALA")
        form["route"] = "080"
        XCTAssertEqual(form["district"], "04")
        form.chooseDistrict("04")
        XCTAssertEqual(form["county"], "ALA")
        XCTAssertEqual(form["route"], "080", "Alameda has route 80; the padded route must be recognised")
        form.chooseDistrict("07")
        XCTAssertEqual(form["county"], "")
        XCTAssertEqual(form["route"], "")
    }

    func testChoosingACountySetsItsDistrictAndDropsARouteItLacks() {
        var form = GisaForm()
        form["route"] = "001"
        form.chooseCounty("SF")
        XCTAssertEqual(form["district"], "04")
        XCTAssertEqual(form["route"], "001")
        form.chooseCounty("ALA")
        XCTAssertEqual(form["route"], "")
        XCTAssertEqual(CaltransCounties.counties(inDistrict: "04").map(\.code), ["ALA", "CC", "MRN", "NAP", "SF", "SM", "SCL", "SOL", "SON"])
    }

    func testTheLocationLinksNeedBothCoordinates() {
        var form = GisaForm()
        XCTAssertNil(form.mapPreviewURL)
        XCTAssertNil(form.googleMapsURL)
        form["latitude"] = "37.7312"
        XCTAssertNil(form.mapPreviewURL)
        form["longitude"] = "-122.1975"
        XCTAssertEqual(form.googleMapsURL?.absoluteString,
                       "https://www.google.com/maps/place/37.7312%2C-122.1975/@37.7312,-122.1975,17z")
        let preview = try? XCTUnwrap(form.mapPreviewURL)
        XCTAssertEqual(preview?.host, "services.arcgisonline.com")
        XCTAssertTrue(preview?.query?.contains("bboxSR=4326") == true)
    }

    func testNorthingAndEastingFollowTheCountysZone() {
        var form = GisaForm()
        XCTAssertNil(form.statePlane)
        form.chooseCounty("ALA")
        XCTAssertEqual(form.statePlane?.zone, 3)
        XCTAssertEqual(form.statePlane?.northing, "")
        form["latitude"] = "37.731200"
        form["longitude"] = "-122.197500"
        let plane = try? XCTUnwrap(form.statePlane)
        XCTAssertEqual(plane?.northing, "2093160.507")

        var moved = form
        XCTAssertNil(moved.applyStatePlane(northing: "2,093,160.507", easting: plane?.easting ?? ""))
        XCTAssertEqual(moved["latitude"], "37.731200")
        XCTAssertEqual(moved["longitude"], "-122.197500")
        XCTAssertEqual(moved.applyStatePlane(northing: "north", easting: "1"), "Northing and easting must be numeric.")
        moved["county"] = ""
        XCTAssertEqual(moved.applyStatePlane(northing: "1", easting: "1"),
                       "Unable to convert northing/easting for the selected county.")
    }

    func testTheEditorLoadsContactsTypesAndActions() throws {
        let editor = GisaEditor(detail: try detail(
            #"{"failure_slide": 1, "district_contact": "[{\"first_name\": \"Ana\"}]"}"#,
            incidentTypes: #"["HEAVING"]"#, actions: #"{"immediate": ["CLOSE_LANE"], "follow_up": ["MONITOR"]}"#))
        XCTAssertEqual(editor.contacts.map(\.firstName), ["Ana"])
        XCTAssertEqual(editor.listedIncidentTypes, ["HEAVING", "SLIDE"])
        XCTAssertEqual(editor.actions, .init(immediate: ["CLOSE_LANE"], followUp: ["MONITOR"]))
    }

    func testANewContactKeepsItsPlaceUntilItHasAValue() throws {
        var editor = GisaEditor(detail: try detail("null"))
        let added = DistrictContact()
        editor.setContacts(editor.contacts + [added])
        XCTAssertEqual(editor.contacts.map(\.id), [added.id])
        XCTAssertEqual(editor.form["district_contact"], "")
        var named = added
        named.lastName = "Ruiz"
        editor.setContacts([named])
        XCTAssertEqual(editor.form["district_contact"],
                       #"[{"first_name":"","last_name":"Ruiz","s_number":"","phone":"","cell_phone":""}]"#)
    }

    func testSavingAnIncompleteDraftMarksTheFieldsToFill() throws {
        var editor = GisaEditor(detail: try detail(#"{"county": "ALA"}"#))
        guard case .failure(let problem) = editor.prepareSave(lookups: .empty) else { return XCTFail("should not save") }
        XCTAssertEqual(problem.title, "Almost there")
        XCTAssertEqual(Set(editor.errors.keys), ["route", "post_mile", "latitude", "longitude"])
        editor.set("route", "880")
        XCTAssertNil(editor.errors["route"])
    }

    func testSavingNamesAFieldTheServerWouldRefuse() throws {
        var editor = GisaEditor(detail: try detail(located))
        editor.set("crack_length_ft", "about 3")
        guard case .failure(let problem) = editor.prepareSave(lookups: .empty) else { return XCTFail("should not save") }
        XCTAssertEqual(problem.message, "Crack length must be numeric")
        XCTAssertEqual(editor.errors["crack_length_ft"], "Crack length must be numeric")
    }

    func testAReadyDraftBuildsItsRequestWithTheRulesApplied() throws {
        var editor = GisaEditor(detail: try detail(located, incidentTypes: #"["HEAVING"]"#))
        editor.set("material_rock", "NO")
        editor.set("est_rock_pct", "25")
        editor.set("failure_washout", "YES")
        guard case .success(let request) = editor.prepareSave(lookups: .empty) else { return XCTFail("should save") }
        XCTAssertEqual(request.body["est_rock_pct"], .null)
        XCTAssertEqual(request.body["post_mile"], .string("12.30"))
        XCTAssertEqual(request.incidentTypes, ["WASHOUT", "HEAVING"])
        XCTAssertEqual(editor.form["est_rock_pct"], "")
    }

    func testAnActionInTheWrongGroupStopsTheSave() throws {
        var editor = GisaEditor(detail: try detail(located, actions: #"{"immediate": ["X"], "follow_up": []}"#))
        guard case .failure(let problem) = editor.prepareSave(lookups: .empty) else { return XCTFail("should not save") }
        XCTAssertEqual(problem.title, "Cannot Save Yet")
        XCTAssertTrue(problem.message.contains("Immediate has unknown code(s): X"))
    }
}

final class SubmissionDescriptorTests: XCTestCase {
    func testTheDescriptorNamesTheLocationAndMarksWhatIsMissing() {
        XCTAssertEqual(SubmissionDescriptor.text(district: "04", county: "ALA", route: "880", postMile: "12.3", createdAt: nil),
                       "04-ALA-880-12.30")
        XCTAssertEqual(SubmissionDescriptor.text(district: " ", county: nil, route: "", postMile: nil, createdAt: "garbage"),
                       "?-?-?-?")
        XCTAssertTrue(SubmissionDescriptor.text(district: "04", county: "ALA", route: "80", postMile: "1",
                                                createdAt: "2026-10-28T09:00:00").hasPrefix("04-ALA-080-1.00 - "))
    }
}
