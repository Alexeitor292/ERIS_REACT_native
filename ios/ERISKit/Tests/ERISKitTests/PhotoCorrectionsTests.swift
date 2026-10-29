import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// ERIS with form 501's photo map (photo 77, its heading corrected by hand) and
/// the correction endpoint, which can be out of reach or refuse.
private final class CorrectionServer: HTTPTransport, @unchecked Sendable {
    let lock = NSLock()
    var reachable = true
    var refuse = false
    private(set) var sent: [[String: JSONValue]] = []

    static let photoMap = """
    {"submission_id": 501, "can_edit_corrections": true,
     "photos": [{"attachment_id": 77, "file_name": "a.jpg", "can_edit_correction": true,
                 "latitude": 37.7312, "longitude": -122.1975, "horizontal_accuracy_m": 4.6,
                 "camera_heading_deg": 200, "camera_heading_accuracy_code": null,
                 "location_source": "DEVICE_AT_CAPTURE", "heading_source": "MANUAL",
                 "correction": {"has_history": true, "location_overridden": false, "heading_overridden": true,
                                "location_override": null, "heading_override_deg": 200},
                 "captured_metadata": {"latitude": 37.7312, "longitude": -122.1975, "horizontal_accuracy_m": 4.6,
                                       "camera_heading_deg": 123.4, "camera_heading_accuracy_code": 3,
                                       "heading_reference": "TRUE_NORTH", "location_source": "DEVICE_AT_CAPTURE",
                                       "heading_source": "DEVICE_TRUE_HEADING"}}]}
    """

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body): (Int, String) = try lock.locked {
            guard reachable else { throw APIError.transport("offline") }
            switch (request.httpMethod ?? "GET", request.url!.path) {
            case ("GET", "/api/submissions/501/photo-map"):
                return (200, Self.photoMap)
            case ("PUT", "/api/submissions/501/photo-map/photos/77/correction"):
                if refuse { return (403, #"{"detail": "Not allowed to correct this photo"}"#) }
                sent.append(try JSONDecoder().decode([String: JSONValue].self, from: request.httpBody ?? Data()))
                return (200, #"{"attachment_id": 77}"#)
            default:
                return (404, #"{"detail": "Not found"}"#)
            }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (Data(body.utf8), response)
    }
}

final class PhotoCorrectionsTests: XCTestCase {
    private let server = CorrectionServer()
    private var store: OfflineStore!
    private var api: APIClient!
    private var corrections: PhotoCorrections!

    override func setUp() {
        store = OfflineStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("eris-corrections-\(UUID().uuidString)"))
        api = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"), transport: server)
        corrections = PhotoCorrections(api: api, store: store)
    }

    override func tearDown() { store.wipe() }

    private let moved = PhotoCorrection(locationOverride: .init(latitude: 37.7320, longitude: -122.1960), headingOverrideDeg: 200,
                                        clientCorrectionUuid: "c-1")

    func testAPhotoMovedOfflineShowsWhereItWasPutAndIsSentOnceBackOnline() async throws {
        let submissions = SubmissionsAPI(api: api)
        _ = try await submissions.photoMap(501, keepingIn: store)
        server.reachable = false

        let sent = try await corrections.save(501, attachmentId: 77, moved)
        XCTAssertFalse(sent)
        XCTAssertEqual(store.waiting.summary, "1 photo correction waiting to send")
        XCTAssertTrue(store.waiting.forms.contains(501), "the form's photos are kept while it waits")

        let kept = try await submissions.photoMap(501, keepingIn: store)
        XCTAssertNotNil(kept.keptAt)
        let photo = try XCTUnwrap(kept.value.photos.first)
        XCTAssertEqual(photo.latitude, 37.7320)
        XCTAssertEqual(photo.locationSource, "MANUAL")
        XCTAssertNil(photo.horizontalAccuracyM)
        XCTAssertEqual(photo.cameraHeadingDeg, 200, "the direction correction already made is kept")
        XCTAssertEqual(photo.correction?.waitingToSend, true)

        server.reachable = true
        let outcome = await corrections.sendAll()
        XCTAssertEqual(outcome, .sent)
        XCTAssertEqual(server.sent.map { $0["client_correction_uuid"] }, [.string("c-1")], "sent once, with its own id")
        XCTAssertTrue(store.waiting.isEmpty)
        let fresh = try await submissions.photoMap(501, keepingIn: store)
        XCTAssertNil(fresh.value.photos.first?.correction?.waitingToSend)
    }

    func testOnlineACorrectionIsSentAtOnceAndNothingWaits() async throws {
        let sent = try await corrections.save(501, attachmentId: 77, moved)
        XCTAssertTrue(sent)
        XCTAssertEqual(server.sent.count, 1)
        XCTAssertTrue(store.corrections().isEmpty)
    }

    func testARefusedCorrectionIsKeptWithTheReasonAndNotTriedAgain() async throws {
        server.reachable = false
        _ = try await corrections.save(501, attachmentId: 77, moved)
        server.reachable = true
        server.refuse = true
        _ = await corrections.sendAll()
        XCTAssertEqual(store.corrections().first?.problem, "Not allowed to correct this photo")
        server.refuse = false
        let again = await corrections.sendAll()
        XCTAssertEqual(again, .nothing)
        XCTAssertTrue(server.sent.isEmpty)
    }

    func testOnlyTheLatestCorrectionOfAPhotoWaitsAndANewerOneIsNotLostWhenAnOlderIsSent() {
        let older = QueuedCorrection(submissionId: 501, attachmentId: 77, correction: moved)
        store.keepCorrection(older)
        let newer = QueuedCorrection(submissionId: 501, attachmentId: 77, correction: PhotoCorrection(
            locationOverride: nil, headingOverrideDeg: 90, clientCorrectionUuid: "c-2"))
        store.keepCorrection(newer)
        XCTAssertEqual(store.corrections().map(\.correction.clientCorrectionUuid), ["c-2"])
        store.removeCorrection(older)
        XCTAssertEqual(store.corrections().map(\.correction.clientCorrectionUuid), ["c-2"])
    }

    func testRestoringTheCameraValuesUsesWhatItRecordedWhereGoodEnoughToMap() throws {
        let map = try api.decode(PhotoMap.self, from: Data(CorrectionServer.photoMap.utf8), preservingKeys: false)
        let restored = map.photos[0].corrected(PhotoCorrection(locationOverride: nil, headingOverrideDeg: nil))
        XCTAssertEqual(restored.cameraHeadingDeg, 123.4)
        XCTAssertEqual(restored.headingSource, "DEVICE_TRUE_HEADING")
        XCTAssertEqual(restored.latitude, 37.7312, "the location was never corrected")
        XCTAssertEqual(restored.correction?.headingOverridden, false)
    }
}
