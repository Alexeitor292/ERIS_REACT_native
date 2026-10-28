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
        editor.set("settlement_in", "about 3")
        guard case .failure(let problem) = editor.prepareSave(lookups: .empty) else { return XCTFail("should not save") }
        XCTAssertEqual(problem.message, "Settlement must be numeric")
        XCTAssertEqual(editor.errors["settlement_in"], "Settlement must be numeric")
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

/// Step 2: Distribution, Highway Status and Incident Type.
final class GisaBodyTests: XCTestCase {
    private func editor(_ gisa: String = "null", incidentTypes: String = "[]",
                        actions: String = #"{"immediate": [], "follow_up": []}"#) throws -> GisaEditor {
        GisaEditor(detail: try JSONDecoder().decode(SubmissionDetail.self, from: Data("""
        {"submission": {"id": 1, "status": "DRAFT", "can_edit": true}, "gisa": \(gisa),
         "incident_types": \(incidentTypes), "actions": \(actions)}
        """.utf8)))
    }

    func testTheIncidentTypeListMatchesTheExpoEditor() {
        XCTAssertEqual(GisaEditor.incidentTypeOptions.map(\.label),
                       ["Rock Fall", "Topple", "Slide", "Spread", "Flow", "Compound", "Erosion", "Surficial Sloughing",
                        "Scoured Toe", "Washout", "Sink Hole", "Depression", "Heaving"])
        XCTAssertEqual(GisaEditor.incidentTypeOptions.filter { $0.key == nil }.map(\.code), ["SINK_HOLE", "DEPRESSION", "HEAVING"])
    }

    func testAnIncidentTypeTogglesInTheListAndOnItsTickBox() throws {
        var editor = try editor()
        let slide = try XCTUnwrap(GisaEditor.incidentTypeOptions.first { $0.code == "SLIDE" })
        let heaving = try XCTUnwrap(GisaEditor.incidentTypeOptions.first { $0.code == "HEAVING" })
        editor.toggleIncidentType(slide)
        editor.toggleIncidentType(heaving)
        XCTAssertTrue(editor.isIncidentTypeOn(slide))
        XCTAssertEqual(editor.form["failure_slide"], "YES")
        XCTAssertEqual(editor.listedIncidentTypes, ["SLIDE", "HEAVING"])
        editor.toggleIncidentType(slide)
        XCTAssertFalse(editor.isIncidentTypeOn(slide))
        XCTAssertEqual(editor.form["failure_slide"], "NO")
        XCTAssertEqual(editor.form.incidentTypeItems(listed: editor.listedIncidentTypes), ["HEAVING"])
    }

    func testAFlagSetOnTheServerShowsItsTypeAsOn() throws {
        let editor = try editor(#"{"failure_topple": 1}"#)
        XCTAssertTrue(editor.isIncidentTypeOn(GisaEditor.incidentTypeOptions[1]))
    }

    func testDistributionIsOneChoiceThatCanBeCleared() throws {
        var editor = try editor()
        editor.toggleDistribution("ADVANCING")
        editor.toggleDistribution("CONFINED")
        XCTAssertEqual(editor.form["distribution_code"], "CONFINED")
        editor.toggleDistribution("CONFINED")
        XCTAssertEqual(editor.form["distribution_code"], "")
    }

    func testHighwayStatusOptionsAppearOnceThereIsSomethingToSay() throws {
        var editor = try editor()
        XCTAssertFalse(editor.showsHighwayStatusOptions)
        editor.set("highway_status_cause", "  ")
        XCTAssertFalse(editor.showsHighwayStatusOptions)
        editor.set("highway_status_cause", "Debris on the shoulder")
        XCTAssertTrue(editor.showsHighwayStatusOptions)
        XCTAssertTrue(try self.editor(actions: #"{"immediate": [], "follow_up": ["OPEN_HIGHWAY_TRAFFIC"]}"#).showsHighwayStatusOptions)
        XCTAssertTrue(try self.editor(#"{"lanes_closed_count": 2}"#).showsHighwayStatusOptions)
    }

    func testALaneCountBelongsOnlyToLanesClosed() throws {
        var editor = try editor()
        editor.toggleHighwayStatus("LANES_CLOSED")
        XCTAssertTrue(editor.asksLanesClosedCount)
        editor.set("lanes_closed_count", "2")
        editor.toggleHighwayStatus("SHOULDER_CLOSED")
        XCTAssertEqual(editor.form["highway_status_code"], "SHOULDER_CLOSED")
        XCTAssertEqual(editor.form["lanes_closed_count"], "")
        editor.toggleHighwayStatus("SHOULDER_CLOSED")
        XCTAssertEqual(editor.form["highway_status_code"], "")
    }
}

/// Step 2: Material.
final class GisaMaterialTests: XCTestCase {
    private func editor(_ gisa: String = "null") throws -> GisaEditor {
        GisaEditor(detail: try JSONDecoder().decode(SubmissionDetail.self, from: Data("""
        {"submission": {"id": 1, "status": "DRAFT", "can_edit": true}, "gisa": \(gisa)}
        """.utf8)))
    }

    func testSlidersShowFiveStepsAndBlankAsZero() {
        XCTAssertEqual(GisaEditor.steppedPercent(""), 0)
        XCTAssertEqual(GisaEditor.steppedPercent("33"), 35)
        XCTAssertEqual(GisaEditor.steppedPercent("32.4"), 30)
        XCTAssertEqual(GisaEditor.steppedPercent("2.5"), 5, "halves round up, as Math.round does")
        XCTAssertEqual(GisaEditor.steppedPercent("140"), 100)
        XCTAssertEqual(GisaEditor.steppedPercent("-3"), 0)
        XCTAssertEqual(GisaEditor.steppedPercent("lots"), 0)
    }

    func testMovingASliderStoresTheStep() throws {
        var editor = try editor()
        editor.setPercent("est_sand_pct", 42.6)
        XCTAssertEqual(editor.form["est_sand_pct"], "45")
    }

    func testClayAndSiltShareOneSlider() throws {
        var editor = try editor(#"{"material_soil": 1, "est_clay_pct": 20, "est_silt_pct": 13}"#)
        XCTAssertEqual(editor.claySiltPercent, "35")
        editor.setClaySiltPercent(40)
        XCTAssertEqual(editor.form["est_clay_pct"], "40")
        XCTAssertEqual(editor.form["est_silt_pct"], "0")
        XCTAssertEqual(try self.editor(#"{"material_soil": 1}"#).claySiltPercent, "")
    }

    func testTurningSoilOrRockOffClearsItsDetail() throws {
        var editor = try editor(#"{"material_soil": 1, "material_rock": 1, "est_sand_pct": 30, "est_rock_pct": 60, "material_joints": 1}"#)
        editor.toggleMaterial("material_soil")
        XCTAssertEqual(editor.form["material_soil"], "NO")
        XCTAssertEqual(editor.form["est_sand_pct"], "")
        editor.toggleMaterial("material_rock")
        XCTAssertEqual(editor.form["est_rock_pct"], "")
        XCTAssertEqual(editor.form["material_joints"], "NO")
        editor.toggleMaterial("material_rock")
        XCTAssertEqual(editor.form["material_rock"], "YES")
    }

    func testRockSubtypesNeedRock() throws {
        var editor = try editor()
        editor.toggleRockSubtype("material_bedding")
        XCTAssertEqual(editor.form["material_bedding"], "NO")
        editor.toggleMaterial("material_rock")
        editor.toggleRockSubtype("material_bedding")
        editor.toggleRockSubtype("material_fractures")
        XCTAssertEqual(editor.form["material_bedding"], "YES")
        XCTAssertEqual(editor.form["material_fractures"], "YES")
        editor.toggleRockSubtype("material_bedding")
        XCTAssertEqual(editor.form["material_bedding"], "NO")
    }

    func testPavementTypeIsOneChoice() throws {
        var editor = try editor()
        editor.togglePavementType("ASPHALT")
        editor.togglePavementType("CONCRETE")
        XCTAssertEqual(editor.form["material_pavement_type"], "CONCRETE")
        editor.togglePavementType("CONCRETE")
        XCTAssertEqual(editor.form["material_pavement_type"], "")
    }

    func testTheSharesTotalAsSubmitChecksThem() throws {
        var editor = try editor(#"{"material_soil": 1, "est_clay_pct": 40, "est_silt_pct": 10, "est_sand_pct": 30}"#)
        XCTAssertEqual(editor.soilShareTotal, 80)
        editor.set("est_boulder_pct", "x")
        XCTAssertNil(editor.soilShareTotal)
        editor.setPercent("est_debris_sand_pct", 60)
        editor.setPercent("est_debris_boulder_pct", 40)
        XCTAssertEqual(editor.debrisShareTotal, 100)
    }
}

/// Step 2: Vegetation on Slope, Water / Drainage and Water Content.
final class GisaWaterTests: XCTestCase {
    private func editor(_ gisa: String = "null") throws -> GisaEditor {
        GisaEditor(detail: try JSONDecoder().decode(SubmissionDetail.self, from: Data("""
        {"submission": {"id": 1, "status": "DRAFT", "can_edit": true}, "gisa": \(gisa)}
        """.utf8)))
    }

    func testDrainageIsOneConditionThatCanBeCleared() throws {
        var editor = try editor()
        editor.toggleDrainage("drainage_surface_runoff")
        editor.toggleDrainage("drainage_clogged_inlet")
        XCTAssertEqual(GisaEditor.drainageChoices.map { editor.form[$0.0] }, ["YES", "NO", "NO", "NO"])
        editor.toggleDrainage("drainage_clogged_inlet")
        XCTAssertEqual(GisaEditor.drainageChoices.map { editor.form[$0.0] }, ["NO", "NO", "NO", "NO"])
    }

    func testSeepAndSpringBelongToFlowingWater() throws {
        var editor = try editor()
        editor.toggleFlowing("water_seep")
        XCTAssertEqual(editor.form["water_seep"], "NO", "not offered until the water is flowing")
        editor.toggleWaterContent("water_flowing")
        editor.toggleFlowing("water_seep")
        editor.toggleFlowing("water_spring")
        XCTAssertEqual(editor.form["water_seep"], "NO")
        XCTAssertEqual(editor.form["water_spring"], "YES")
        editor.toggleWaterContent("water_wet")
        XCTAssertEqual(editor.form["water_flowing"], "NO")
        XCTAssertEqual(editor.form["water_spring"], "NO")
        XCTAssertEqual(editor.form["water_wet"], "YES")
    }

    func testImpactedAndMayBeImpactedExcludeEachOther() throws {
        var editor = try editor(#"{"impact_maybe_adj_utilities": 1}"#)
        XCTAssertEqual(editor.form["impact_maybe_adj_utilities"], "YES")
        editor.toggleImpact(impactedKey: "impact_impacted_adj_utilities", maybeKey: "impact_maybe_adj_utilities", .impacted)
        XCTAssertEqual(editor.form["impact_impacted_adj_utilities"], "YES")
        XCTAssertEqual(editor.form["impact_maybe_adj_utilities"], "")
        editor.toggleImpact(impactedKey: "impact_impacted_adj_utilities", maybeKey: "impact_maybe_adj_utilities", .impacted)
        XCTAssertEqual(editor.form["impact_impacted_adj_utilities"], "")
        guard case .success(let request) = { var e = editor; e.set("district", "04"); e.set("county", "ALA"); e.set("route", "880");
            e.set("post_mile", "1"); e.set("latitude", "37.7"); e.set("longitude", "-122.2"); return e.prepareSave(lookups: .empty) }()
        else { return XCTFail("should save") }
        XCTAssertEqual(request.body["impact_impacted_adj_utilities"], .null, "a cleared answer is sent as no answer")
    }
}
