import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The GISA form's load, rules and save, following the `load` and `saveDraft`
/// of mobile/app/(tabs)/submissions/[id].tsx.
final class GisaFormTests: XCTestCase {
    /// A saved record as `GET /submissions/{id}` sends it: DECIMAL columns as
    /// numbers, TINYINT flags as 0/1, JSON columns as objects.
    private let saved: [String: JSONValue] = [
        "report_date": .string("2026-10-27"), "district": .string("4"), "county": .string("Alameda"),
        "route": .string("880"), "post_mile": .string("12.3"), "ea": .string("04-1A234"),
        "latitude": .number(37.7312), "longitude": .number(-122.1975),
        "lanes_closed_count": .number(2), "crack_length_ft": .number(12.5), "settlement_in": .number(3),
        "pavement_ground_cracks": .number(1), "indented_by_rocks": .number(0),
        "failure_slide": .number(1), "failure_flow": .number(0), "material_soil": .number(1),
        "material_pavement_type": .string("GRAVEL"), "est_clay_pct": .number(40), "est_silt_pct": .number(60),
        "vegetation_trees": .number(30.0), "water_wet": .bool(true), "water_dry": .bool(true),
        "geometry_json": .object(["type": .string("Point"), "coordinates": .array([.number(-122.1975), .number(37.7312)])]),
        "pavement_ground_annotation_layout_json": .object(["crack": .object(["x": .number(0.5), "y": .number(0.25),
                                                                           "rangeEnd": .null])]),
        "geotechnical_assessment_notes": .string("Cut slope failure."),
    ]

    func testASavedRecordLoadsAsTheExpoEditorShowsIt() {
        let form = GisaForm(server: saved, incidentTypes: ["EROSION", "SINK_HOLE"], createdAt: "2026-10-28T09:00:00")
        XCTAssertEqual(form["district"], "04")
        XCTAssertEqual(form["county"], "ALA")
        XCTAssertEqual(form["route"], "880")
        XCTAssertEqual(form["post_mile"], "12.30")
        XCTAssertEqual(form["latitude"], "37.731200")
        XCTAssertEqual(form["longitude"], "-122.197500")
        XCTAssertEqual(form["lanes_closed_count"], "2")
        XCTAssertEqual(form["crack_length_ft"], "12.5")
        XCTAssertEqual(form["vegetation_trees"], "30")
        XCTAssertEqual(form["pavement_ground_cracks"], "YES")
        XCTAssertEqual(form["indented_by_rocks"], "NO")
        // A flag or a listed code ticks an incident type.
        XCTAssertEqual(form["failure_slide"], "YES")
        XCTAssertEqual(form["failure_erosion"], "YES")
        XCTAssertEqual(form["failure_flow"], "NO")
        XCTAssertEqual(form["failure_topple"], "NO")
        XCTAssertEqual(form["material_pavement_type"], "")
        // Only one base water content survives: the first in form order.
        XCTAssertEqual(form["water_dry"], "YES")
        XCTAssertEqual(form["water_wet"], "NO")
        XCTAssertTrue(form["geometry_json"].contains("\"Point\""))
        XCTAssertTrue(form["pavement_ground_annotation_layout"].contains("rangeEnd"))
        XCTAssertEqual(form["report_date"], "2026-10-27")
    }

    func testMissingHeaderValuesComeFromTheCountyAndCreationDate() {
        let form = GisaForm(server: ["county": .string("SM")], incidentTypes: [], createdAt: "2026-10-28 09:00:00")
        XCTAssertEqual(form["district"], "04")
        XCTAssertEqual(form["report_date"], "2026-10-28")
        let unknown = GisaForm(server: ["county": .string("Atlantis"), "district": .string("")], incidentTypes: [],
                               createdAt: nil)
        XCTAssertEqual(unknown["county"], "")
        XCTAssertEqual(unknown["district"], "")
        XCTAssertEqual(unknown["report_date"], "")
        let empty = GisaForm(server: nil, incidentTypes: [], createdAt: nil)
        XCTAssertEqual(empty["failure_slide"], "NO")
        XCTAssertEqual(empty["pavement_ground_cracks"], "")
        XCTAssertEqual(empty["geometry_json"], "")
    }

    func testTheBusinessRulesClearWhatNoLongerApplies() {
        var form = GisaForm()
        form["material_rock"] = "NO"
        form["material_bedding"] = "YES"
        form["est_rock_pct"] = "20"
        form["material_soil"] = ""
        form["est_clay_pct"] = "10"
        form["drainage_surface_runoff"] = "YES"
        form["drainage_torrent_surge_flood"] = "YES"
        form["water_flowing"] = "YES"
        form["water_seep"] = "YES"
        form["water_spring"] = "YES"
        form["pavement_ground_cracks"] = "maybe"
        let next = form.enforcingBusinessRules()
        XCTAssertEqual(next["material_bedding"], "NO")
        XCTAssertEqual(next["est_rock_pct"], "")
        XCTAssertEqual(next["material_soil"], "NO")
        XCTAssertEqual(next["est_clay_pct"], "")
        XCTAssertEqual(next["drainage_surface_runoff"], "YES")
        XCTAssertEqual(next["drainage_torrent_surge_flood"], "NO")
        XCTAssertEqual(next["drainage_clogged_inlet"], "NO")
        XCTAssertEqual(next["water_seep"], "YES")
        XCTAssertEqual(next["water_spring"], "NO")
        XCTAssertEqual(next["pavement_ground_cracks"], "")

        form["water_flowing"] = "NO"
        XCTAssertEqual(form.enforcingBusinessRules()["water_seep"], "NO")
    }

    func testTheSavedBodyHasEveryFieldTypedAsTheServerExpects() throws {
        let body = try GisaForm(server: saved, incidentTypes: [], createdAt: nil).patchBody()
        XCTAssertEqual(body.count, GisaForm.fields.count)
        XCTAssertEqual(body["district"], .string("04"))
        XCTAssertEqual(body["route"], .string("880"))
        XCTAssertEqual(body["post_mile"], .string("12.30"))
        XCTAssertEqual(body["latitude"], .number(37.7312))
        XCTAssertEqual(body["lanes_closed_count"], .number(2))
        XCTAssertEqual(body["crack_length_ft"], .number(12.5))
        XCTAssertEqual(body["vegetation_trees"], .number(30))
        XCTAssertEqual(body["pavement_ground_cracks"], .bool(true))
        XCTAssertEqual(body["indented_by_rocks"], .bool(false))
        XCTAssertEqual(body["failure_slide"], .bool(true))
        XCTAssertEqual(body["material_pavement_type"], .null)
        XCTAssertEqual(body["ea"], .string("04-1A234"))
        XCTAssertEqual(body["project_id"], .null)
        XCTAssertEqual(body["geometry_json"], saved["geometry_json"])
        XCTAssertEqual(body["pavement_ground_annotation_layout_json"], saved["pavement_ground_annotation_layout_json"])
        XCTAssertNil(body["pavement_ground_annotation_layout"])
    }

    func testTheBodyKeepsDataKeysAsWritten() async throws {
        let transport = FakeTransport { _ in .init(status: 200, body: "{}") }
        let api = SubmissionsAPI(api: APIClient(baseURL: base, store: MemorySessionStore(token: "t"), transport: transport))
        let form = GisaForm(server: saved, incidentTypes: [], createdAt: nil)
        try await api.saveGisa(501, form: try form.patchBody(), incidentTypes: form.incidentTypeItems(listed: ["SINK_HOLE"]),
                               actions: .init(immediate: ["CLOSE_LANE"], followUp: []))
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod!) \($0.url!.path)" },
                       ["PATCH /api/submissions/501/gisa", "PUT /api/submissions/501/gisa/incident-types",
                        "PUT /api/submissions/501/gisa/actions"])
        let patch = String(data: transport.requests[0].httpBody!, encoding: .utf8)!
        XCTAssertTrue(patch.contains("\"rangeEnd\""), "camelCase keys inside JSON fields must not be renamed")
        XCTAssertTrue(patch.contains("\"post_mile\":\"12.30\""))
        let types = try JSONDecoder().decode([String: [String]].self, from: transport.requests[1].httpBody!)
        XCTAssertEqual(types["items"], ["SLIDE", "SINK_HOLE"])
        let actions = try JSONDecoder().decode([String: [String]].self, from: transport.requests[2].httpBody!)
        XCTAssertEqual(actions, ["immediate": ["CLOSE_LANE"], "follow_up": []])
    }

    func testAValueTheServerWouldRefuseNamesItsField() {
        func error(_ key: String, _ value: String) -> GisaFieldError? {
            var form = GisaForm()
            form[key] = value
            do { _ = try form.patchBody() } catch let error as GisaFieldError { return error } catch {}
            return nil
        }
        XCTAssertEqual(error("crack_length_ft", "12 ft"), GisaFieldError(key: "crack_length_ft", message: "Crack length must be numeric"))
        XCTAssertEqual(error("lanes_closed_count", "1.5"),
                       GisaFieldError(key: "lanes_closed_count", message: "Lanes closed count must be a whole number"))
        XCTAssertEqual(error("vegetation_trees", "120"),
                       GisaFieldError(key: "vegetation_trees", message: "Trees Coverage % must be between 0 and 100"))
        XCTAssertEqual(error("latitude", "north"), GisaFieldError(key: "latitude", message: "Latitude must be numeric"))
        XCTAssertEqual(error("geometry_json", "{oops"), GisaFieldError(key: "geometry_json", message: "Geometry JSON is invalid."))
        XCTAssertNil(error("lanes_closed_count", "2.0"))
        XCTAssertNil(error("crack_length_ft", " 1e1 "))
    }

    func testAnUnreadablePavementLayoutIsReplacedByTheDefault() throws {
        var form = GisaForm()
        form["pavement_ground_annotation_layout"] = "{not json"
        let body = try form.patchBody()
        guard case .object(let layout)? = body["pavement_ground_annotation_layout_json"] else {
            return XCTFail("expected the default layout")
        }
        XCTAssertEqual(Set(layout.keys), ["crack", "settlement", "bulge", "rocks"])
    }

    func testIncidentTypesFollowTheTickBoxesAndKeepOtherListedTypes() {
        var form = GisaForm()
        form["failure_washout"] = "YES"
        form["failure_rock_fall"] = "YES"
        XCTAssertEqual(form.tickedIncidentTypes, ["ROCK_FALL", "WASHOUT"])
        // A listed form type whose box is now clear is dropped; others stay once.
        XCTAssertEqual(form.incidentTypeItems(listed: ["SLIDE", "HEAVING", "WASHOUT", "HEAVING"]),
                       ["ROCK_FALL", "WASHOUT", "HEAVING"])
    }

    func testDistrictContactsRoundTripAndAcceptOldFreeText() {
        let contacts = DistrictContact.parse(#"[{"first_name":"Ana","last_name":"Ruiz","s_number":"S12","phone":"","cell_phone":5551234}]"#)
        XCTAssertEqual(contacts.map(\.firstName), ["Ana"])
        XCTAssertEqual(contacts[0].cellPhone, "5551234")
        XCTAssertEqual(contacts[0].displayName(index: 0), "Ana Ruiz")
        XCTAssertEqual(DistrictContact().displayName(index: 1), "Contact 2")
        XCTAssertEqual(DistrictContact.parse("Call the district office").map(\.firstName), ["Call the district office"])
        XCTAssertEqual(DistrictContact.parse("123"), [])
        XCTAssertEqual(DistrictContact.parse("  "), [])
        XCTAssertEqual(DistrictContact.serialize(contacts + [DistrictContact(phone: "  ")]),
                       #"[{"first_name":"Ana","last_name":"Ruiz","s_number":"S12","phone":"","cell_phone":"5551234"}]"#)
        XCTAssertEqual(DistrictContact.serialize([DistrictContact()]), "")
        XCTAssertEqual(DistrictContact.serialize([DistrictContact(firstName: "A/B \"C\"")]),
                       #"[{"first_name":"A/B \"C\"","last_name":"","s_number":"","phone":"","cell_phone":""}]"#)
    }

    func testADraftNeedsItsLocationAndASubmissionItsAssessment() {
        var form = GisaForm()
        XCTAssertEqual(Set(GisaValidation.draftErrors(form).keys),
                       ["district", "county", "route", "post_mile", "latitude", "longitude"])
        XCTAssertEqual(GisaValidation.draftErrors(form)["post_mile"], "Post Mile is required.")
        for (key, value) in [("district", "04"), ("county", "ALA"), ("route", "880"), ("post_mile", "1.00"),
                             ("latitude", "37.7"), ("longitude", "-122.1")] {
            form[key] = value
        }
        XCTAssertEqual(GisaValidation.draftErrors(form), [:])
        XCTAssertEqual(GisaValidation.submitErrors(form),
                       ["geotechnical_assessment_notes": "Geotechnical Assessment is required."])
        form["geotechnical_assessment_notes"] = "Stable."
        XCTAssertEqual(GisaValidation.submitErrors(form), [:])
    }

    func testSoilAndDebrisSharesMustTotalOneHundred() {
        var form = GisaForm()
        XCTAssertNil(GisaValidation.soilTotalProblem(form))
        form["material_soil"] = "YES"
        form["est_clay_pct"] = "40"
        form["est_silt_pct"] = "30"
        form["est_sand_pct"] = "20"
        XCTAssertEqual(GisaValidation.soilTotalProblem(form),
                       "Material Soil percentages must total 100%. Current total is 90.00% (under by 10.00%).")
        form["est_gravel_pct"] = "10"
        XCTAssertNil(GisaValidation.soilTotalProblem(form))
        form["est_boulder_pct"] = "x"
        XCTAssertEqual(GisaValidation.soilTotalProblem(form), "Boulder percentage must be numeric.")

        XCTAssertNil(GisaValidation.debrisTotalProblem(form))
        form["est_debris_sand_pct"] = "60"
        form["est_debris_boulder_pct"] = "45.5"
        XCTAssertEqual(GisaValidation.debrisTotalProblem(form),
                       "Landslide Debris percentages must total 100%. Current total is 105.50% (over by 5.50%).")
    }

    func testActionsMustBeInTheirOwnGroup() {
        let lookups = GisaLookups(distribution: [], highwayStatus: [], incidentTypes: [],
                                  actions: .init(immediate: [GisaOption(code: "CLOSE_LANE", label: "Close lane")],
                                                 followUp: [GisaOption(code: "MONITOR", label: "Monitor")]))
        XCTAssertNil(GisaValidation.actionGroupProblem(immediate: ["CLOSE_LANE"], followUp: ["MONITOR"], lookups: lookups))
        XCTAssertEqual(GisaValidation.actionGroupProblem(immediate: ["MONITOR"], followUp: [], lookups: lookups),
                       "Action group mismatch detected.\nImmediate has unknown code(s): MONITOR\nImmediate has FOLLOW_UP code(s): MONITOR")
    }

    func testTheLookupsDecode() async throws {
        let transport = FakeTransport { _ in
            .init(status: 200, body: """
            {"distribution": [{"code": "ADVANCING", "label": "Advancing"}], "highway_status": [],
             "incident_types": [{"code": "SLIDE", "label": "Slide", "sort_order": 3}],
             "actions": {"immediate": [{"code": "CLOSE_LANE", "label": "Close lane", "action_group": "IMMEDIATE"}],
                         "follow_up": []}, "requested_by_user_id": 4}
            """)
        }
        let lookups = try await SubmissionsAPI(api: APIClient(baseURL: base, store: MemorySessionStore(token: "t"),
                                                              transport: transport)).lookups()
        XCTAssertEqual(lookups.distribution.map(\.code), ["ADVANCING"])
        XCTAssertEqual(lookups.actions.immediate.map(\.label), ["Close lane"])
    }
}
