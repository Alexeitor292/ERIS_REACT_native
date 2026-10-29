import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// ERIS with one assessment assigned to user 41: incident 12 with a photo, form 501 with a photo.
private final class WorkServer: HTTPTransport, @unchecked Sendable {
    let lock = NSLock()
    var reachable = true
    var assigned = true
    private(set) var paths: [String] = []

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body): (Int, Any) = try lock.locked {
            guard reachable else { throw APIError.transport("offline") }
            let path = request.url!.path
            paths.append(path)
            let assessment: [String: Any] = ["id": 5, "incident_id": 12, "submission_id": 501, "submission_ids": [501],
                                             "assigned_engineer_user_id": 41, "state": "DRAFT", "updated_at": "2026-10-28T09:00:00"]
            switch path {
            case "/api/assessments":
                return (200, ["items": assigned ? [assessment] : []])
            case "/api/assessments/5":
                return (200, ["assessment": assessment, "events": []])
            case "/api/incidents/12":
                return (200, ["incident": ["id": 12, "title": "Slip", "current_stage": "X", "status": "NEW"]])
            case "/api/incidents/12/attachments":
                return (200, ["items": [["attachment_id": 70, "kind": "PHOTO", "mime_type": "image/jpeg",
                                         "download_url": "https://storage.test/70"]]])
            case "/api/submissions/501":
                return (200, ["submission": ["id": 501, "status": "DRAFT", "can_edit": true], "gisa": ["district": "04"],
                              "photos": [["id": 801, "kind": "PHOTO", "mime_type": "image/jpeg", "section_key": "material"]],
                              "attachments": [["id": 801, "kind": "PHOTO", "mime_type": "image/jpeg", "section_key": "material"]]])
            case "/api/submissions/501/site-history":
                return (200, ["anchor": ["radius_m": 150], "incidents": []])
            case "/api/attachments/801/download-url":
                return (200, ["download_url": "https://storage.test/801"])
            case "/api/gisa/lookups":
                return (200, ["distribution": [], "highway_status": [], "incident_types": [], "actions": ["immediate": [], "follow_up": []]])
            default:
                return (404, ["detail": "Not found"])
            }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (try JSONSerialization.data(withJSONObject: body), response)
    }
}

final class AssignedWorkTests: XCTestCase {
    private var store: OfflineStore!
    private let server = WorkServer()
    private var api: APIClient!
    private var work: AssignedWork!

    override func setUp() {
        store = OfflineStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("eris-work-\(UUID().uuidString)"))
        api = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"), transport: server)
        work = AssignedWork(api: api, store: store, me: 41, download: { url in Data(url.lastPathComponent.utf8) })
    }

    override func tearDown() { store.wipe() }

    private func queue() async -> MyWork.Loaded {
        await MyWork.load(api: api, roles: ["STAFF"], maintenanceDuties: false, store: store)
    }

    func testEverythingAssignedIsKeptWithoutBeingAsked() async throws {
        let loaded = await queue()
        let summary = await work.prepare(loaded.assessments)
        XCTAssertEqual(summary, .init(assessments: 1, forms: 1, photos: 2, unreachable: false))
        XCTAssertEqual(store.file(801), Data("801".utf8), "the form's photo")
        XCTAssertEqual(store.file(70), Data("70".utf8), "the incident's photo")

        // Then, out of reach, all of it opens from the iPhone.
        server.reachable = false
        let offlineQueue = await queue()
        XCTAssertEqual(offlineQueue.assessments.map(\.id), [5])
        XCTAssertNotNil(offlineQueue.keptAt)
        let assessment = try await AssessmentsAPI(api: api).detail(5, keepingIn: store)
        XCTAssertNotNil(assessment.keptAt)
        let form = try await SubmissionsAPI(api: api).detail(501, keepingIn: store)
        XCTAssertEqual(form.value.form["district"], "04")
        let history = try await SubmissionsAPI(api: api).siteHistory(501, keepingIn: store)
        XCTAssertEqual(history.anchor?.radiusM, 150)
        let lookups = try await SubmissionsAPI(api: api).lookups(keepingIn: store)
        XCTAssertNotNil(lookups.keptAt)
    }

    func testPhotosAlreadyKeptAreNotFetchedAgainAndThoseOfWorkNoLongerAssignedGo() async {
        _ = await work.prepare(await queue().assessments)
        let again = await work.prepare(await queue().assessments)
        XCTAssertEqual(again.photos, 0)
        server.assigned = false
        _ = await work.prepare(await queue().assessments)
        XCTAssertNil(store.file(801))
        XCTAssertNil(store.file(70))
    }

    func testOfflineNothingKeptIsLost() async {
        _ = await work.prepare(await queue().assessments)
        server.reachable = false
        let summary = await work.prepare(await queue().assessments)
        XCTAssertTrue(summary.unreachable)
        XCTAssertNotNil(store.file(801), "kept photos stay when ERIS cannot be reached")
    }

    func testOnlyThisPersonsOpenAssessmentsCount() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func assessment(_ id: Int, _ assignee: Int, _ state: String) throws -> Assessment {
            try decoder.decode(Assessment.self, from: JSONSerialization.data(withJSONObject: [
                "id": id, "incident_id": 1, "assigned_engineer_user_id": assignee, "state": state]))
        }
        let all = [try assessment(1, 41, "DRAFT"), try assessment(2, 41, "REVISION_REQUESTED"), try assessment(3, 41, "SUBMITTED"),
                   try assessment(4, 9, "DRAFT"), try assessment(1, 41, "DRAFT")]
        XCTAssertEqual(AssignedWork.assigned(all, to: 41).map(\.id), [1, 2])
    }
}
