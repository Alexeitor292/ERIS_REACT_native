import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A small ERIS for one form: it judges saves against their base as the
/// server does, and can be out of reach.
private final class FormServer: HTTPTransport, @unchecked Sendable {
    let lock = NSLock()
    var reachable = true
    var status = "DRAFT"
    var gisa: [String: Any] = ["district": "04", "county": "ALA", "route": "880", "post_mile": 12.3,
                               "latitude": 37.7312, "longitude": -122.1975, "ea": "", "project_id": "", "revision": 1]
    var attachments: [[String: Any]] = []
    private(set) var log: [String] = []

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body): (Int, Any) = try lock.locked {
            guard reachable else { throw APIError.transport("The Internet connection appears to be offline.") }
            let method = request.httpMethod ?? "GET", path = request.url!.path
            log.append("\(method) \(path)")
            let sent = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            switch (method, path) {
            case ("GET", "/api/submissions/501"):
                return (200, ["submission": ["id": 501, "status": self.status, "can_edit": true],
                              "gisa": gisa, "incident_types": [], "actions": ["immediate": [], "follow_up": []],
                              "attachments": attachments, "photos": [], "workflow_events": []] as [String: Any])
            case ("GET", "/api/gisa/lookups"):
                return (200, ["distribution": [], "highway_status": [], "incident_types": [],
                              "actions": ["immediate": [], "follow_up": []]] as [String: Any])
            case ("PATCH", "/api/submissions/501/gisa"):
                var changes = sent
                let base = changes.removeValue(forKey: "base") as? [String: Any] ?? [:]
                let moved = base.keys.filter { "\(base[$0] ?? "")" != "\(gisa[$0] ?? "")" }
                if !moved.isEmpty {
                    return (409, ["detail": ["message": "Changed meanwhile", "saved_by": "Maria Garcia",
                                             "conflicts": moved.map { ["field": $0, "theirs": gisa[$0] ?? NSNull()] }]])
                }
                gisa.merge(changes) { _, new in new }
                gisa["revision"] = (gisa["revision"] as? Int ?? 1) + 1
                return (200, ["submission_id": 501])
            case ("POST", "/api/submissions/501/attachments"):
                let size = request.httpBody?.count ?? 0
                if size > 4000 { return (413, ["detail": "big.mov is larger than 95 MB."]) }
                attachments.append(["id": 900 + attachments.count, "file_name": "site.jpg", "file_size_bytes": 3, "kind": "PHOTO"])
                return (200, ["attachment_id": 900, "section_key": "material"])
            default:
                return (404, ["detail": "Not found"])
            }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        return (try JSONSerialization.data(withJSONObject: body), response)
    }

    func requests() -> [String] { lock.locked { log } }
}

final class OfflineTests: XCTestCase {
    private var folder: URL!
    private var store: OfflineStore!
    private let server = FormServer()
    private var api: APIClient!

    override func setUp() {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("eris-offline-\(UUID().uuidString)")
        store = OfflineStore(directory: folder)
        api = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"), transport: server)
    }

    override func tearDown() {
        store.wipe()
    }

    /// Opens the form while ERIS can be reached, as the editor does.
    private func open() async throws -> GisaEditor {
        GisaEditor(detail: try await SubmissionsAPI(api: api).detail(501, keepingIn: store).value)
    }

    func testAFormOpenedOnceOpensAgainWithoutAConnection() async throws {
        let submissions = SubmissionsAPI(api: api)
        let first = try await submissions.detail(501, keepingIn: store)
        XCTAssertNil(first.keptAt)
        server.reachable = false
        let again = try await submissions.detail(501, keepingIn: store)
        XCTAssertNotNil(again.keptAt, "the copy kept on this iPhone")
        XCTAssertEqual(again.value.form["route"], "880")
        do {
            _ = try await submissions.list(keepingIn: store)
            XCTFail("a list never opened has no copy")
        } catch let error as APIError {
            XCTAssertTrue(error.isUnreachable)
        }
    }

    func testKeptChangesRebuildTheSameEditor() async throws {
        var editor = try await open()
        editor.set("ea", "04-1A234")
        let kept = editor.edits(501, state: .waiting)
        store.keepEdits(kept)
        let restored = GisaEditor(edits: try XCTUnwrap(store.edits(501)))
        XCTAssertEqual(restored.form["ea"], "04-1A234")
        XCTAssertEqual(restored.changedKeys, ["ea"])
        XCTAssertEqual(try restored.changes(), try editor.changes())
        XCTAssertEqual(store.waiting.summary, "1 form with changes waiting to send")
    }

    func testSavedChangesAreSentWhenERISCanBeReachedAgain() async throws {
        var editor = try await open()
        editor.set("ea", "04-1A234")
        store.keepEdits(editor.edits(501, state: .waiting))
        server.reachable = false
        let sync = FormSync(api: api, store: store)
        let offline = await sync.send(501)
        XCTAssertEqual(offline, .unreachable)
        XCTAssertEqual(store.edits(501)?.state, .waiting, "kept to try again")

        server.reachable = true
        let online = await sync.send(501)
        XCTAssertEqual(online, .sent)
        XCTAssertNil(store.edits(501))
        XCTAssertEqual(server.gisa["ea"] as? String, "04-1A234")
    }

    func testChangesBeingTypedAreNotSentUntilSaved() async throws {
        var editor = try await open()
        editor.set("ea", "04-1A")
        store.keepEdits(editor.edits(501, state: .editing))
        let outcome = await FormSync(api: api, store: store).send(501)
        XCTAssertEqual(outcome, .nothing)
        XCTAssertFalse(server.requests().contains("PATCH /api/submissions/501/gisa"))
    }

    func testAColleaguesSaveElsewhereIsKeptAndTheSameFieldWaitsForAChoice() async throws {
        var editor = try await open()
        editor.set("ea", "04-1A234")
        store.keepEdits(editor.edits(501, state: .waiting))
        // Meanwhile Maria saves another field: both are kept.
        server.gisa["project_id"] = "From Maria"
        let first = await FormSync(api: api, store: store).send(501)
        XCTAssertEqual(first, .sent)
        XCTAssertEqual(server.gisa["project_id"] as? String, "From Maria")
        XCTAssertEqual(server.gisa["ea"] as? String, "04-1A234")

        // Then both change Project ID: nothing is overwritten.
        editor = try await open()
        editor.set("project_id", "Mine")
        store.keepEdits(editor.edits(501, state: .waiting))
        server.gisa["project_id"] = "Maria again"
        let second = await FormSync(api: api, store: store).send(501)
        XCTAssertEqual(second, .needsChoice)
        XCTAssertEqual(server.gisa["project_id"] as? String, "Maria again")
        let kept = try XCTUnwrap(store.edits(501))
        XCTAssertEqual(kept.state, .needsChoice)
        XCTAssertEqual(kept.note, "Someone else changed Project ID too. Open the form to choose which to keep.")
        // Opening the form offers the choice.
        var reopened = GisaEditor(edits: kept)
        reopened.catchUp(with: try await SubmissionsAPI(api: api).detail(501, keepingIn: store).value, savedBy: nil)
        XCTAssertEqual(reopened.pending?.conflicts.map(\.key), ["project_id"])
    }

    func testAFormNoLongerADraftKeepsTheChangesAndSaysWhy() async throws {
        var editor = try await open()
        editor.set("ea", "04-1A234")
        store.keepEdits(editor.edits(501, state: .waiting))
        server.status = "SUBMITTED"
        let outcome = await FormSync(api: api, store: store).send(501)
        guard case .refused(let why) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertTrue(why.hasPrefix("This form is submitted now"), why)
        XCTAssertEqual(store.edits(501)?.state, .refused)
    }

    func testFilesAreUploadedOnceEvenWhenAnAnswerWasLost() async throws {
        let photo = PendingUpload(submissionId: 501, fileName: "site.jpg", mimeType: "image/jpeg", sectionKey: "material",
                                  kind: "PHOTO", capture: nil, size: 3)
        store.addUpload(photo, file: Data([1, 2, 3]))
        XCTAssertEqual(store.waiting.summary, "1 file waiting to send")
        // An earlier try reached ERIS but its answer did not come back.
        var tried = photo
        tried.attempted = true
        store.updateUpload(tried)
        server.attachments = [["id": 950, "file_name": "site.jpg", "file_size_bytes": 3, "kind": "PHOTO"]]
        let outcome = await FormSync(api: api, store: store).send(501)
        XCTAssertEqual(outcome, .sent)
        XCTAssertTrue(store.uploads().isEmpty)
        XCTAssertFalse(server.requests().contains("POST /api/submissions/501/attachments"), "not sent twice")

        let big = PendingUpload(submissionId: 501, fileName: "big.mov", mimeType: "video/quicktime", sectionKey: nil,
                                kind: "VIDEO", capture: nil, size: 5000)
        store.addUpload(big, file: Data(count: 5000))
        let refused = await FormSync(api: api, store: store).send(501)
        XCTAssertEqual(refused, .refused("big.mov is larger than 95 MB."))
        XCTAssertEqual(store.uploads().first?.problem, "big.mov is larger than 95 MB.", "kept for this person to see")
    }

    func testWipingRemovesEverything() async throws {
        _ = try await open()
        store.addUpload(PendingUpload(submissionId: 501, fileName: "a.jpg", mimeType: "image/jpeg", sectionKey: nil,
                                      kind: "PHOTO", capture: nil, size: 1), file: Data([1]))
        store.wipe()
        XCTAssertNil(store.form(501))
        XCTAssertTrue(store.waiting.isEmpty)
    }
}
