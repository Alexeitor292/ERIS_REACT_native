import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class IncidentsAPITests: XCTestCase {
    let incidentJSON = #"{"id": 12, "current_stage": "COORDINATOR_REVIEW", "status": "NEW"}"#

    func makeAPI(_ reply: @escaping (URLRequest) -> FakeTransport.Reply) -> (IncidentsAPI, FakeTransport) {
        let transport = FakeTransport(reply)
        return (IncidentsAPI(api: APIClient(baseURL: base, store: MemorySessionStore(token: "t"), transport: transport)),
                transport)
    }

    func draft() -> IncidentDraft {
        IncidentDraft(title: "Slipout", incidentType: "SLIPOUT", firstObservedAt: "2026-10-28T08:00:00Z",
                      latitude: 37.8, longitude: -122.2, district: "04", county: "ALA", route: "880", postMile: "12.3")
    }

    func testCreateSendsTheServersFieldNames() async throws {
        let (incidents, transport) = makeAPI { _ in .init(status: 200, body: #"{"incident": \#(self.incidentJSON)}"#) }
        let created = try await incidents.create(draft())
        XCTAssertEqual(created.id, 12)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])
        XCTAssertEqual(body["post_mile"] as? String, "12.3")
        XCTAssertEqual(body["first_observed_at"] as? String, "2026-10-28T08:00:00Z")
        XCTAssertEqual(body["incident_type"] as? String, "SLIPOUT")
    }

    func testListAsksForTheMobileScope() async throws {
        let (incidents, transport) = makeAPI { _ in .init(status: 200, body: #"{"items": []}"#) }
        _ = try await incidents.list(status: "NEW", unclaimedOnly: true)
        XCTAssertEqual(transport.requests.first?.url?.query, "status=NEW&unclaimed_only=true&scope=mobile")
    }

    func testWorkflowActionsHitTheirEndpoints() async throws {
        let (incidents, transport) = makeAPI { _ in .init(status: 200, body: "{}") }
        try await incidents.claim(12)
        try await incidents.resolve(12, comment: "Cleared")
        try await incidents.forwardByCoordinator(12, comment: nil)
        try await incidents.requestRevision(12, comment: "Add photos", fields: ["photos"])
        XCTAssertEqual(transport.paths(), [
            "POST /api/incidents/12/claim", "POST /api/incidents/12/resolve",
            "POST /api/incidents/12/coordinator/approve", "POST /api/incidents/12/coordinator/request-revision",
        ])
        let revision = try XCTUnwrap(JSONSerialization.jsonObject(with: transport.requests[3].httpBody ?? Data())
            as? [String: Any])
        XCTAssertEqual(revision["revision_fields"] as? [String], ["photos"])
    }

    func testAPhotoUploadIsMultipartWithItsKind() async throws {
        let (incidents, transport) = makeAPI { _ in .init(status: 200, body: #"{"attachment_id": 3}"#) }
        try await incidents.upload(12, file: Data([1, 2, 3]), fileName: "photo.jpg", mimeType: "image/jpeg", kind: .photo)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url?.query, "kind=PHOTO")
        XCTAssertTrue(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") ?? false)
    }

    func testTheMultipartBodyIsWellFormed() {
        let form = MultipartForm(file: Data("abc".utf8), fieldName: "file", fileName: "a\"b.jpg", mimeType: "image/jpeg",
                                 boundary: "B")
        XCTAssertEqual(String(data: form.body, encoding: .utf8),
                       "--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a_b.jpg\"\r\n"
                           + "Content-Type: image/jpeg\r\n\r\nabc\r\n--B--\r\n")
    }

    func testADraftNamesWhatIsMissing() {
        var incomplete = draft()
        incomplete.route = " "
        incomplete.latitude = 0
        incomplete.longitude = 0
        XCTAssertEqual(incomplete.problems, ["A valid location is required.", "Route is required."])
        XCTAssertEqual(draft().problems, [])
    }
}
