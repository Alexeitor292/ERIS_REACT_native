import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A small ERIS for incident reports: it files them, takes their photos, can
/// lose an answer, and can be out of reach.
private final class ReportServer: HTTPTransport, @unchecked Sendable {
    let lock = NSLock()
    var reachable = true
    var listReachable = true
    /// File the next report but lose the answer.
    var loseNextAnswer = false
    var refuse: String?
    var incidents: [[String: Any]] = []
    var workflow: [[String: Any]] = []
    private(set) var posts = 0
    private(set) var uploads: [Int] = []

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body): (Int, Any) = try lock.locked {
            guard reachable else { throw APIError.transport("offline") }
            let path = request.url!.path, method = request.httpMethod ?? "GET"
            switch (method, path) {
            case ("POST", "/api/incidents"):
                if let refuse { return (422, ["detail": refuse]) }
                posts += 1
                let sent = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
                var filed = sent
                filed["id"] = 100 + incidents.count
                filed["reporter_user_id"] = 7
                filed["current_stage"] = "COORDINATOR_REVIEW"
                filed["status"] = "NEW"
                incidents.append(filed)
                if loseNextAnswer {
                    loseNextAnswer = false
                    throw APIError.transport("The network connection was lost.")
                }
                return (200, ["incident": filed])
            case ("GET", "/api/incidents"):
                guard listReachable else { throw APIError.transport("offline") }
                return (200, ["items": incidents])
            case ("GET", "/api/maintenance-work/incidents"):
                return (200, ["items": workflow])
            case ("GET", let p) where p.hasPrefix("/api/incidents/"):
                let id = Int(p.split(separator: "/").last!)!
                let all = incidents + workflow.compactMap { $0["incident"] as? [String: Any] }
                return all.first { $0["id"] as? Int == id }.map { (200, ["incident": $0]) } ?? (404, ["detail": "no"])
            case ("POST", let p) where p.hasSuffix("/attachments"):
                uploads.append(Int(p.split(separator: "/")[2])!)
                return (200, ["attachment_id": 1])
            default:
                return (404, ["detail": "Not found"])
            }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (try JSONSerialization.data(withJSONObject: body), response)
    }
}

final class IncidentQueueTests: XCTestCase {
    private var store: OfflineStore!
    private let server = ReportServer()
    private var sync: IncidentSync!

    override func setUp() {
        store = OfflineStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("eris-reports-\(UUID().uuidString)"))
        let api = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"), transport: server)
        sync = IncidentSync(api: api, store: store, me: 7)
    }

    override func tearDown() { store.wipe() }

    private let draft = IncidentDraft(title: "Rockfall", description: "Rocks in lane 2", firstObservedAt: "2026-10-28T06:30:00Z",
                                      latitude: 37.59, longitude: -122.51, district: "04", county: "SM", route: "001", postMile: "38.20")

    private func keep(photos: Int = 1) -> QueuedIncident {
        let files = (0..<photos).map { QueuedIncident.File(fileName: "photo-\($0 + 1).jpg", mimeType: "image/jpeg", kind: .photo) }
        let queued = QueuedIncident(draft: draft, files: files)
        store.queueIncident(queued, files: Dictionary(uniqueKeysWithValues: files.map { ($0.id, Data([1, 2, 3])) }))
        return queued
    }

    func testAReportMadeOfflineIsFiledWithItsPhotosWhenERISCanBeReached() async {
        _ = keep(photos: 2)
        XCTAssertEqual(store.waiting.summary, "1 report waiting to send")
        server.reachable = false
        let offline = await sync.sendAll()
        XCTAssertEqual(offline, .unreachable)
        XCTAssertEqual(store.queuedIncidents().count, 1)

        server.reachable = true
        let online = await sync.sendAll()
        XCTAssertEqual(online, .sent)
        XCTAssertEqual(server.posts, 1)
        XCTAssertEqual(server.uploads, [100, 100])
        XCTAssertTrue(store.queuedIncidents().isEmpty)
    }

    func testAReportWhoseAnswerWasLostIsNotFiledTwice() async {
        _ = keep()
        server.loseNextAnswer = true
        let lost = await sync.sendAll()
        XCTAssertEqual(lost, .unreachable)
        XCTAssertNotNil(store.queuedIncidents().first?.attemptedAt)

        // The next round finds it filed, and only adds the photo.
        let next = await sync.sendAll()
        XCTAssertEqual(next, .sent)
        XCTAssertEqual(server.posts, 1, "filed once")
        XCTAssertEqual(server.uploads, [100])
    }

    func testWhenTheCheckCannotBeMadeNothingIsFiled() async {
        _ = keep()
        server.loseNextAnswer = true
        _ = await sync.sendAll()
        server.listReachable = false
        let outcome = await sync.sendAll()
        XCTAssertEqual(outcome, .unreachable)
        XCTAssertEqual(server.posts, 1, "never filed blind")
    }

    func testAReportInADistrictWorkflowIsFoundThroughTheMaintenanceList() async {
        _ = keep(photos: 0)
        server.loseNextAnswer = true
        _ = await sync.sendAll()
        // The server lists workflow reports apart, not in the incident list.
        let filed = server.incidents.removeLast()
        server.workflow = [["id": filed["id"]!, "title": "Rockfall", "district": "04", "outcome": NSNull(), "step_name": "Review",
                            "waiting_reporter": false, "my_turn": false, "reported_by_me": true, "incident": filed]]
        let outcome = await sync.sendAll()
        XCTAssertEqual(outcome, .sent)
        XCTAssertEqual(server.posts, 1)
    }

    func testAReportERISRefusesIsKeptWithTheReason() async {
        _ = keep()
        server.refuse = "Post mile is outside the route."
        let outcome = await sync.sendAll()
        XCTAssertEqual(outcome, .refused("Post mile is outside the route."))
        XCTAssertEqual(store.queuedIncidents().first?.problem, "Post mile is outside the route.")
        let again = await sync.sendAll()
        XCTAssertEqual(again, .nothing, "not retried until the reporter acts")
    }

    func testOnlyTheSameReportMatches() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func incident(_ fields: [String: Any]) throws -> Incident {
            var base: [String: Any] = ["id": 1, "reporter_user_id": 7, "latitude": 37.59, "longitude": -122.51, "county": "SM",
                                       "route": "1", "description": "Rocks in lane 2", "first_observed_at": "2026-10-28T06:30:00",
                                       "current_stage": "X", "status": "NEW"]
            base.merge(fields) { _, new in new }
            return try decoder.decode(Incident.self, from: JSONSerialization.data(withJSONObject: base))
        }
        XCTAssertTrue(IncidentSync.same(draft, try incident([:]), reporter: 7), "the time as written")
        XCTAssertTrue(IncidentSync.same(draft, try incident(["first_observed_at": "2026-10-27T23:30:00"]), reporter: 7),
                      "the same instant in Pacific time")
        XCTAssertFalse(IncidentSync.same(draft, try incident(["reporter_user_id": 8]), reporter: 7))
        XCTAssertFalse(IncidentSync.same(draft, try incident(["first_observed_at": "2026-10-28T06:31:00"]), reporter: 7))
        XCTAssertFalse(IncidentSync.same(draft, try incident(["latitude": 37.5901]), reporter: 7))
        XCTAssertFalse(IncidentSync.same(draft, try incident(["description": "Something else"]), reporter: 7))
    }
}
