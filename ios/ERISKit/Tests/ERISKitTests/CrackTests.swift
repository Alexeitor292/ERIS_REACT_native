import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Cracks as their own records. The rules mirror
/// web/src/features/submissions/cracks/crackModel.test.ts.
final class CrackTests: XCTestCase {
    private let crackJSON = """
    {"id": 7, "submission_id": 501, "client_uuid": "u", "sort_order": 1, "label": null,
     "latitude": 37.7312, "longitude": -122.1975, "location_source": "PHOTO", "geometry_json": null,
     "trend_deg": 35.0, "orientation": "TRANSVERSE", "length_ft": 12.5, "width_in": 0.75, "horizontal_disp_in": null,
     "vertical_disp_in": 2.25, "depth_in": 6.0, "notes": null, "photo_attachment_id": 41,
     "annotations_json": {"version": 1, "shapes": [{"type": "label", "at": [0.5, 0.4], "measure": "length_ft"},
                                                   {"type": "path", "points": [[0.1, 0.7], [0.3, 0.6]]}]},
     "revision": 3, "created_by_user_id": 4, "created_by_name": "A. Rivera"}
    """

    private func crack() throws -> Crack {
        try JSONDecoder().decode(Crack.self, from: Data(crackJSON.utf8))
    }

    func testEachCrackIsNamedByItsLabelOrItsPlace() throws {
        let crack = try crack()
        XCTAssertEqual(crack.title(index: 1), "Crack 2")
        XCTAssertEqual(crack.annotations?.shapes.count, 2)
        XCTAssertEqual(crack.orientation, .transverse)
    }

    func testTheSummarySaysWhatIsKnown() throws {
        XCTAssertEqual(try crack().summary,
                       "12.5 ft long · 0.75 in wide · 2.25 in vertical · 6 in deep · trends 035° (NE–SW) · transverse")
    }

    func testACrackLinesDirectionReadsBothWays() {
        XCTAssertEqual(Crack.trendText(0), "000° (N–S)")
        XCTAssertEqual(Crack.trendText(90), "090° (E–W)")
        XCTAssertEqual(Crack.trendText(135), "135° (SE–NW)")
        XCTAssertEqual(Crack.trendText(200), "020° (NNE–SSW)")
        XCTAssertNil(Crack.trendText(nil))
    }

    func testOnlyWhatChangedIsSentAndBlanksClear() throws {
        let crack = try crack()
        var draft = CrackDraft(crack)
        XCTAssertEqual(try draft.changes(from: crack).get(), [:])
        draft[.depthIn] = "8"
        draft[.widthIn] = ""
        draft.label = " Toe "
        XCTAssertEqual(try draft.changes(from: crack).get(),
                       ["label": .string("Toe"), "width_in": .null, "depth_in": .number(8)])
    }

    func testATypedLocationIsMarkedAsEnteredAndBothPartsGoTogether() throws {
        let crack = try crack()
        var draft = CrackDraft(crack)
        draft.latitude = "37.7320"
        XCTAssertEqual(try draft.changes(from: crack).get(),
                       ["latitude": .number(37.732), "longitude": .number(-122.1975), "location_source": .string("MANUAL")])
        draft.latitude = ""
        XCTAssertEqual(draft.changes(from: crack), .failure(CrackProblem(message: "Enter both latitude and longitude, or neither.")))
    }

    func testAValueTheServerWouldRefuseIsNamedBeforeSaving() throws {
        let crack = try crack()
        var draft = CrackDraft(crack)
        draft[.lengthFt] = "-2"
        XCTAssertEqual(draft.changes(from: crack), .failure(CrackProblem(message: "Length must be a number from 0 to 100000.")))
        draft = CrackDraft(crack)
        draft.trendDeg = "360"
        XCTAssertEqual(draft.changes(from: crack),
                       .failure(CrackProblem(message: "Direction must be a number from 0 to less than 360.")))
    }

    func testALabelFollowsTheMeasureItNames() throws {
        let crack = try crack()
        XCTAssertEqual(crack.words(for: CrackShape(type: .label, at: [0.5, 0.5], measure: .lengthFt)), "Length 12.5 ft")
        XCTAssertEqual(crack.words(for: CrackShape(type: .label, at: [0.5, 0.5], measure: .horizontalDispIn)),
                       "Horizontal displacement —")
        XCTAssertEqual(crack.words(for: CrackShape(type: .label, at: [0.5, 0.5], text: "Scarp", measure: .lengthFt)), "Scarp")
        XCTAssertNil(crack.words(for: CrackShape(type: .path, points: [[0, 0], [1, 1]])))
    }

    func testTheLocationSaysWhereItCameFrom() throws {
        XCTAssertEqual(try crack().locationText, "37.731200, -122.197500 (approximate, from its photo)")
    }

    func testANewDrawingIsSentAsShapes() throws {
        let crack = try crack()
        var draft = CrackDraft(crack)
        draft.annotations = CrackAnnotations(shapes: [CrackShape(type: .arrow, points: [[0.4, 0.55], [0.44, 0.66]],
                                                                 measure: .horizontalDispIn)])
        let changes = try draft.changes(from: crack).get()
        guard case .object(let drawing)? = changes["annotations_json"], case .array(let shapes)? = drawing["shapes"] else {
            return XCTFail("expected the drawing")
        }
        XCTAssertEqual(shapes.count, 1)
        XCTAssertEqual(changes.count, 1)
    }

    // MARK: API

    private func api(_ transport: FakeTransport) -> SubmissionsAPI {
        SubmissionsAPI(api: APIClient(baseURL: base, store: MemorySessionStore(token: "t"), transport: transport))
    }

    func testAddingACrackSendsItsOwnIdSoARetryMakesNoSecond() async throws {
        let json = crackJSON
        let transport = FakeTransport { _ in .init(status: 201, body: #"{"crack": \#(json), "idempotent_replay": false}"#) }
        let id = UUID()
        let made = try await api(transport).createCrack(501, clientUuid: id, fields: ["length_ft": .number(3)])
        XCTAssertEqual(made.id, 7)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url?.path, "/api/submissions/501/cracks")
        let body = try JSONDecoder().decode([String: JSONValue].self, from: try XCTUnwrap(request.httpBody))
        XCTAssertEqual(body, ["client_uuid": .string(id.uuidString.lowercased()), "length_ft": .number(3)])
    }

    func testAStaleEditComesBackAsTheSavedCrack() async throws {
        let json = crackJSON
        let transport = FakeTransport { request in
            request.httpMethod == "PATCH"
                ? .init(status: 409, body: #"{"detail": {"message": "Someone else saved this crack after you opened it."}}"#)
                : .init(status: 200, body: #"{"items": [\#(json)]}"#)
        }
        do {
            _ = try await api(transport).updateCrack(501, crackId: 7, revision: 2, changes: ["depth_in": .number(9)])
            XCTFail("a stale edit must be refused")
        } catch let conflict as CrackConflict {
            XCTAssertEqual(conflict.theirs?.revision, 3)
        }
        let patch = try JSONDecoder().decode([String: JSONValue].self, from: try XCTUnwrap(transport.requests[0].httpBody))
        XCTAssertEqual(patch, ["revision": .number(2), "depth_in": .number(9)])
    }

    func testTheFormDetailCarriesItsCracks() throws {
        let detail = try JSONDecoder().decode(SubmissionDetail.self, from: Data("""
        {"submission": {"id": 501, "status": "DRAFT"}, "cracks": [\(crackJSON)]}
        """.utf8))
        XCTAssertEqual(detail.cracks?.map(\.id), [7])
    }
}
