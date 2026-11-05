import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class SubmissionsAPITests: XCTestCase {
    func makeAPI(body: String) -> (SubmissionsAPI, FakeTransport) {
        let transport = FakeTransport { _ in .init(status: 200, body: body) }
        return (SubmissionsAPI(api: APIClient(baseURL: base, store: MemorySessionStore(token: "t"), transport: transport)),
                transport)
    }

    func testTheListDecodesAndDescribesEachSubmission() async throws {
        let (submissions, transport) = makeAPI(body: """
        {"items": [{"id": 5, "created_by_user_id": 7, "status": "REJECTED", "district": "03", "county": "PLA",
                    "route": "080", "post_mile": "12.35", "created_at": "2026-10-01T10:00:00", "submitted_at": null}]}
        """)
        let item = try await submissions.list()[0]
        XCTAssertEqual(transport.requests.first?.url?.query, "limit=100")
        XCTAssertEqual(item.displayTitle, "Submission #5")
        XCTAssertEqual(item.locationLine, "D03 · PLA · 080 · PM 12.35")
        XCTAssertTrue(item.isWorkInProgress)
        XCTAssertEqual(SubmissionLabels.status(item.status), "Returned")
    }

    func testTheDetailKeepsTheGisaFormAndPhotos() async throws {
        let (submissions, _) = makeAPI(body: """
        {"submission": {"id": 5, "status": "SUBMITTED", "title": "PLA-80 slipout", "can_edit": false, "can_review": true},
         "gisa": {"district": "03", "slope_height_ft": 25, "rock_present": true, "notes": "", "nested": {"a": 1}},
         "incident_types": ["SLIPOUT"], "actions": {"immediate": [], "follow_up": []},
         "photos": [{"id": 9, "kind": "PHOTO", "file_name": "p1.jpg", "mime_type": "image/jpeg", "section_key": "site"}],
         "attachments": [], "workflow_events": [], "context": null}
        """)
        let detail = try await submissions.detail(5)
        XCTAssertEqual(detail.submission.title, "PLA-80 slipout")
        XCTAssertEqual(detail.submission.canReview, true)
        XCTAssertEqual(detail.photos?.first?.fileName, "p1.jpg")
        let gisa = try XCTUnwrap(detail.gisa)
        XCTAssertEqual(gisa["slope_height_ft"].flatMap(SubmissionLabels.text), "25")
        XCTAssertEqual(gisa["rock_present"].flatMap(SubmissionLabels.text), "Yes")
        XCTAssertNil(gisa["notes"].flatMap(SubmissionLabels.text))
        XCTAssertEqual(SubmissionLabels.fieldName("slope_height_ft"), "Slope height ft")
    }

    func testDownloadLinksAreFetchedFromTheApi() async throws {
        let (submissions, transport) = makeAPI(body: #"{"download_url": "https://files.example/x?X-Amz-Signature=s"}"#)
        let link = try await submissions.attachmentLink(9)
        XCTAssertEqual(link.downloadUrl, "https://files.example/x?X-Amz-Signature=s")
        XCTAssertEqual(transport.paths(), ["GET /api/attachments/9/download-url"])
    }
}
