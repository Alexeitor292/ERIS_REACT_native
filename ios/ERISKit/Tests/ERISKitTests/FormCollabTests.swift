import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Several people in one form. The merge and presence rules mirror
/// web/src/features/submissions/collab/collab.test.ts.
final class FormCollabTests: XCTestCase {
    private func s(_ text: String) -> JSONValue { .string(text) }

    func testASaveSendsOnlyWhatThisPersonChanged() {
        let base: FormMerge.Snapshot = ["ea": s("0A1"), "settlement_in": s("3"), "notes": s(""), "list": .array([s("A")])]
        var mine = base
        mine["settlement_in"] = s("5")
        mine["notes"] = .null
        XCTAssertEqual(FormMerge.changedKeys(base: base, mine: mine), ["settlement_in"])
        XCTAssertTrue(FormMerge.same(nil, s("")))
        XCTAssertFalse(FormMerge.same(.array([s("A")]), .array([s("A"), s("B")])))
    }

    func testOthersSavesLandWhereThisPersonHasNotTypedAndBothChangedIsTheirsToDecide() {
        let base: FormMerge.Snapshot = ["ea": s("0A1"), "crack": s("3"), "slope": s("40"), "memo": s("<p>a</p>")]
        var mine = base, fresh = base
        mine["crack"] = s("7"); mine["slope"] = s("42")
        fresh["ea"] = s("0B2"); fresh["crack"] = s("5"); fresh["slope"] = s("42")
        let result = FormMerge.mergeFresh(base: base, mine: mine, fresh: fresh)
        XCTAssertEqual(result.theirs, ["ea"])
        XCTAssertEqual(result.conflicts, ["crack"], "slope: both made it 42, nothing to decide")
        XCTAssertEqual(result.merged["ea"], s("0B2"))
        XCTAssertEqual(result.merged["crack"], s("7"))
        var expected = fresh
        expected["crack"] = s("3")
        XCTAssertEqual(FormMerge.rebase(base: base, fresh: fresh, keep: result.conflicts), expected)
    }

    func testValuesCompareAsTheServerStoresThem() {
        XCTAssertTrue(FormMerge.savedSame(.string("12.30"), .number(12.3)))
        XCTAssertTrue(FormMerge.savedSame(.bool(true), .number(1)))
        XCTAssertTrue(FormMerge.savedSame(.string("  "), nil))
        XCTAssertFalse(FormMerge.savedSame(.string("12.3a"), .number(12.3)))
    }

    func testWhoIsWhereInCirclesWithTheirInitials() {
        XCTAssertEqual(Presence.initials("Maria Garcia"), "MG")
        XCTAssertEqual(Presence.initials("Juan Alejandro Campos"), "JC")
        XCTAssertEqual(Presence.initials("maria.garcia@dot.ca.gov"), "MG")
        XCTAssertEqual(Presence.initials("Kevin"), "KE")
        XCTAssertEqual(Presence.color(7), Presence.color(7))
        XCTAssertNotEqual(Presence.color(1), Presence.color(2))
        let others = [
            PresenceOther(sessionId: "a", userId: 1, name: "Maria Garcia", area: "card:report-header", field: "EA"),
            PresenceOther(sessionId: "b", userId: 1, name: "Maria Garcia", area: "card:report-header"),
            PresenceOther(sessionId: "c", userId: 2, name: "John Lee", area: "memo:recommendations_notes",
                          memos: ["recommendations_notes"]),
        ]
        XCTAssertEqual(Presence.writers(others)["recommendations_notes"]?.name, "John Lee")
        XCTAssertEqual(Presence.sentence(others), "Maria Garcia and John Lee are also in this form")
        XCTAssertEqual(Presence.fieldLabel("settlement_in"), "Settlement (in)")
        XCTAssertEqual(Presence.fieldLabel("est_soil_pct"), "Estimated soil (%)")
        XCTAssertEqual(Presence.fieldLabel("memo:recommendations_notes"), "Recommendations")
    }

    // MARK: The editor

    private func detail(_ gisa: String, revision: Int = 1, incidentTypes: String = "[]") throws -> SubmissionDetail {
        try JSONDecoder().decode(SubmissionDetail.self, from: Data("""
        {"submission": {"id": 501, "status": "DRAFT", "created_at": "2026-10-28T09:00:00", "can_edit": true},
         "gisa": {"revision": \(revision), "district": "04", "county": "ALA", "route": "880", "post_mile": "12.3",
                  "latitude": 37.7312, "longitude": -122.1975\(gisa)},
         "incident_types": \(incidentTypes), "actions": {"immediate": [], "follow_up": []}}
        """.utf8))
    }

    func testSomeoneElsesSaveIsShownWhereThisPersonHasNotTyped() throws {
        var editor = GisaEditor(detail: try detail(#", "ea": "0A1", "settlement_in": 3"#))
        editor.set("settlement_in", "7")
        let taken = editor.catchUp(with: try detail(#", "ea": "0B2", "settlement_in": 3"#, revision: 2), savedBy: "Maria Garcia")
        XCTAssertEqual(taken, ["EA"])
        XCTAssertEqual(editor.form["ea"], "0B2")
        XCTAssertEqual(editor.form["settlement_in"], "7", "what this person typed stays")
        XCTAssertNil(editor.pending)
        // Caught up: the next save sends only the settlement, checked against what is saved now.
        let request = try editor.changes()
        XCTAssertEqual(request.body, ["settlement_in": .number(7), "base": .object(["settlement_in": .number(3)])])
        XCTAssertEqual(editor.base.revision, 2)
    }

    func testAFieldBothChangedWaitsForAChoice() throws {
        var editor = GisaEditor(detail: try detail(#", "settlement_in": 3"#))
        editor.set("settlement_in", "7")
        editor.catchUp(with: try detail(#", "settlement_in": 5"#, revision: 2), savedBy: "Maria Garcia")
        let pending = try XCTUnwrap(editor.pending)
        XCTAssertEqual(pending.conflicts, [.init(key: "settlement_in", label: "Settlement", mine: "7", theirs: "5")])
        XCTAssertEqual(pending.savedBy, "Maria Garcia")
        // Until chosen, a save of it is still checked against the old value, so the server refuses it.
        XCTAssertEqual(try editor.changes().body?["base"], .object(["settlement_in": .number(3)]))

        editor.resolve(takingTheirs: ["settlement_in"])
        XCTAssertEqual(editor.form["settlement_in"], "5")
        XCTAssertNil(editor.pending)
        XCTAssertTrue(try editor.changes().isEmpty, "their value taken: nothing left to save")
    }

    func testKeepingMineSavesItAgainstWhatIsSavedNow() throws {
        var editor = GisaEditor(detail: try detail(#", "settlement_in": 3"#))
        editor.set("settlement_in", "7")
        editor.catchUp(with: try detail(#", "settlement_in": 5"#, revision: 2), savedBy: nil)
        editor.resolve(takingTheirs: [])
        XCTAssertEqual(try editor.changes().body, ["settlement_in": .number(7), "base": .object(["settlement_in": .number(5)])])
    }

    func testListsAreMergedAsWholes() throws {
        var editor = GisaEditor(detail: try detail("", incidentTypes: #"["HEAVING"]"#))
        editor.catchUp(with: try detail("", revision: 2, incidentTypes: #"["HEAVING", "ROCK_FALL"]"#), savedBy: nil)
        XCTAssertEqual(Set(editor.listedIncidentTypes), ["HEAVING", "ROCK_FALL"])
        XCTAssertNil(try editor.changes().incidentTypes)
    }

    // MARK: API

    private func api(_ transport: FakeTransport) -> SubmissionsAPI {
        SubmissionsAPI(api: APIClient(baseURL: base, store: MemorySessionStore(token: "t"), transport: transport))
    }

    func testARefusedSaveSaysWhetherAFieldChangedOrAMemoIsBeingWritten() async throws {
        let request = GisaEditor.SaveRequest(form: GisaForm(), body: ["ea": .string("1"), "base": .object(["ea": .null])],
                                             incidentTypes: nil, actions: nil)
        let changed = FakeTransport { _ in .init(status: 409, body: #"""
            {"detail": {"message": "Someone else saved changes", "conflicts": [{"field": "ea", "theirs": "2"}], "saved_by": "Maria Garcia", "revision": 4}}
            """#) }
        do {
            try await api(changed).saveGisa(501, request)
            XCTFail("should be refused")
        } catch let refusal as FormRefusal {
            XCTAssertEqual(refusal, .conflicts(savedBy: "Maria Garcia"))
        }
        let locked = FakeTransport { _ in .init(status: 409, body: #"""
            {"detail": {"message": "John Lee is writing Observations.", "locked": {"observations_notes": {"user_id": 2, "name": "John Lee"}}}}
            """#) }
        do {
            try await api(locked).saveGisa(501, request)
            XCTFail("should be refused")
        } catch let refusal as FormRefusal {
            XCTAssertEqual(refusal, .locked("John Lee is writing Observations."))
        }
        XCTAssertEqual(changed.requests.count, 1, "nothing after a refused part")
    }

    func testTheHeartbeatSaysWhoElseIsHere() async throws {
        let transport = FakeTransport { _ in .init(status: 200, body: #"""
            {"others": [{"session_id": "s2", "user_id": 2, "name": "John Lee", "area": null, "field": null, "memos": ["observations_notes"]}],
             "granted": [], "denied": {"observations_notes": {"user_id": 2, "name": "John Lee"}}, "revision": 5,
             "saved_by": {"user_id": 2, "name": "John Lee"}, "saved_at": null}
            """#) }
        let reply = try await api(transport).presence(501, session: "session-1", area: nil, field: nil,
                                                      memos: ["observations_notes"], typing: true)
        XCTAssertEqual(reply.revision, 5)
        XCTAssertEqual(reply.denied["observations_notes"]?.name, "John Lee")
        XCTAssertEqual(Presence.writers(reply.others)["observations_notes"]?.name, "John Lee")
        let sent = try JSONDecoder().decode([String: JSONValue].self, from: try XCTUnwrap(transport.requests.first?.httpBody))
        XCTAssertEqual(sent["memos"], .array([.string("observations_notes")]))
        XCTAssertEqual(transport.requests.first?.url?.path, "/api/submissions/501/presence")
    }
}
