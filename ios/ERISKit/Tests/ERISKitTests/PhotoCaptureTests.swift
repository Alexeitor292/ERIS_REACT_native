import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Capture metadata against Fixtures/photo-capture.json, written from
/// mobile/src/photos/captureMetadata.ts by ios/scripts/make-parity-fixtures.mjs.
final class PhotoCaptureParityTests: XCTestCase {
    struct Fixture: Decodable {
        struct Coords: Decodable { let latitude: Double; let longitude: Double; let accuracy: Double?; let altitude: Double? }
        struct Position: Decodable { let coords: Coords }
        struct Direction: Decodable { let heading: Double; let accuracyCode: Int }
        struct DeviceInput: Decodable { let position: Position?; let direction: Direction? }
        struct Device: Decodable { let input: DeviceInput; let output: PhotoCaptureMetadata? }
        struct Exif: Decodable { let exif: [String: JSONValue]; let output: PhotoCaptureMetadata? }
        struct Merge: Decodable { let primary: PhotoCaptureMetadata?; let fallback: PhotoCaptureMetadata?; let output: PhotoCaptureMetadata? }
        struct Heading: Decodable { let input: JSONValue; let output: Double? }
        let devices: [Device]
        let exifs: [Exif]
        let merges: [Merge]
        let headings: [Heading]
    }

    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "photo-capture", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testWhatThePhoneMeasuredMatchesTheExpoApp() throws {
        for (index, device) in try fixture().devices.enumerated() {
            let position = device.input.position.map {
                PositionSample(latitude: $0.coords.latitude, longitude: $0.coords.longitude, accuracy: $0.coords.accuracy,
                               altitude: $0.coords.altitude, observedAtMs: 0)
            }
            let direction = device.input.direction.map {
                CameraDirectionSample(heading: $0.heading, accuracyCode: $0.accuracyCode, sampleAgeMs: 0,
                                      elevationDeg: 0, horizontalProjection: 1)
            }
            XCTAssertEqual(PhotoCapture.metadata(capturedAt: "2026-10-28T19:01:10.123Z", position: position,
                                                 direction: direction), device.output, "device case \(index)")
        }
    }

    func testWhatThePhotoFileSaysMatchesTheExpoApp() throws {
        for (index, exif) in try fixture().exifs.enumerated() {
            XCTAssertEqual(PhotoCapture.metadata(exif: exif.exif, assetId: "asset-1"), exif.output, "EXIF case \(index)")
        }
        XCTAssertNil(PhotoCapture.metadata(exif: nil, assetId: nil))
    }

    func testMergingPrefersThePhonesMeasurementLikeTheExpoApp() throws {
        for (index, merge) in try fixture().merges.enumerated() {
            XCTAssertEqual(PhotoCapture.merge(merge.primary, merge.fallback), merge.output, "merge case \(index)")
        }
    }

    func testHeadingsNormaliseLikeTheExpoApp() throws {
        for heading in try fixture().headings {
            let input: Double?
            if case .number(let value) = heading.input { input = value } else { input = nil }
            XCTAssertEqual(PhotoCapture.normalizedHeading(input), heading.output, "\(heading.input)")
        }
    }
}

/// The rear camera's direction, from ErisCameraDirectionModule.m.
final class CameraDirectionTests: XCTestCase {
    /// The attitude matrix's third row is the device Z axis in the
    /// true-north frame (+X north, +Y west, +Z up); the camera looks along −Z.
    private func direction(cameraPointing north: Double, west: Double, up: Double, age: Double = 0.1,
                           accuracy: Int = 3) -> Result<CameraDirectionSample, PhotoCapture.DirectionProblem> {
        PhotoCapture.cameraDirection(m31: -north, m32: -west, m33: -up, ageSeconds: age, accuracyCode: accuracy)
    }

    func testTheCompassDirectionIsWhereTheRearCameraLooks() throws {
        XCTAssertEqual(try direction(cameraPointing: 1, west: 0, up: 0).get().heading, 0, accuracy: 1e-9)
        XCTAssertEqual(try direction(cameraPointing: 0, west: -1, up: 0).get().heading, 90, accuracy: 1e-9)
        XCTAssertEqual(try direction(cameraPointing: 0, west: 1, up: 0).get().heading, 270, accuracy: 1e-9)
        let downhill = try direction(cameraPointing: -cos(.pi / 6), west: 0, up: -sin(.pi / 6)).get()
        XCTAssertEqual(downhill.heading, 180, accuracy: 1e-9)
        XCTAssertEqual(downhill.elevationDeg, -30, accuracy: 1e-9)
        let northEast = try direction(cameraPointing: 0.5, west: -0.5, up: 0).get()
        XCTAssertEqual(northEast.heading, 45, accuracy: 1e-9)
        XCTAssertEqual(PhotoCapture.compassPoint(northEast.heading), "NE")
    }

    func testAFlatOrOldSampleGivesNoDirection() {
        XCTAssertEqual(direction(cameraPointing: 0, west: 0, up: -1), .failure(.nearVertical))
        XCTAssertEqual(direction(cameraPointing: 0.1, west: 0, up: -0.99), .failure(.nearVertical))
        XCTAssertEqual(direction(cameraPointing: 1, west: 0, up: 0, age: 0.6), .failure(.stale))
    }

    func testOnlyACalibratedFreshDirectionIsRecorded() throws {
        let good = try direction(cameraPointing: 1, west: 0, up: 0, accuracy: 2).get()
        XCTAssertNotNil(PhotoCapture.recordable(good))
        XCTAssertNil(PhotoCapture.recordable(try direction(cameraPointing: 1, west: 0, up: 0, accuracy: 1).get()))
        XCTAssertNil(PhotoCapture.recordable(CameraDirectionSample(heading: 10, accuracyCode: 3, sampleAgeMs: 501,
                                                                   elevationDeg: 0, horizontalProjection: 1)))
    }

    func testTheCameraSaysHowGoodItsReadingsAre() throws {
        XCTAssertEqual(PhotoCapture.directionLabel(try direction(cameraPointing: 1, west: 0, up: 0).get()),
                       "Rear camera 0° true • high calibration")
        XCTAssertEqual(PhotoCapture.directionLabel(try direction(cameraPointing: 0, west: -1, up: 0, accuracy: 2).get()),
                       "Rear camera 90° true • medium calibration")
        XCTAssertEqual(PhotoCapture.directionLabel(try direction(cameraPointing: 0, west: -1, up: 0, accuracy: 0).get()),
                       "Rear camera 90° • calibration weak")
        XCTAssertEqual(PhotoCapture.directionLabel(nil), "Camera direction calibrating… move phone in a figure eight")
        let fix = { (accuracy: Double?) in PositionSample(latitude: 37, longitude: -122, accuracy: accuracy, altitude: nil, observedAtMs: 0) }
        XCTAssertEqual(PhotoCapture.locationLabel(fix(4.4)), "GPS best recent ±4 m")
        XCTAssertEqual(PhotoCapture.locationLabel(fix(35)), "GPS weak ±35 m • mapped with uncertainty")
        XCTAssertEqual(PhotoCapture.locationLabel(fix(nil)), "GPS fix acquired • accuracy unknown")
        XCTAssertEqual(PhotoCapture.locationLabel(nil), "GPS acquiring…")
    }

    func testTheShutterUsesTheMostAccurateRecentFix() {
        func fix(_ accuracy: Double?, at ms: Double) -> PositionSample {
            PositionSample(latitude: 37, longitude: -122, accuracy: accuracy, altitude: nil, observedAtMs: ms)
        }
        var samples: [PositionSample] = []
        for sample in [fix(3, at: 0), fix(8, at: 4000), fix(5, at: 6000), fix(5, at: 6500), fix(nil, at: 7000)] {
            samples = PhotoCapture.recording(sample, into: samples)
        }
        XCTAssertEqual(samples.map(\.observedAtMs), [4000, 6000, 6500, 7000], "fixes older than 5 s are dropped")
        XCTAssertEqual(PhotoCapture.bestPosition(samples, atMs: 7000)?.observedAtMs, 6500, "most accurate, then newest")
        XCTAssertEqual(PhotoCapture.bestPosition(samples, atMs: 12000)?.observedAtMs, nil, "nothing within 3 s")
    }
}

final class PhotoMapAPITests: XCTestCase {
    private func api(_ transport: FakeTransport) -> SubmissionsAPI {
        SubmissionsAPI(api: APIClient(baseURL: base, store: MemorySessionStore(token: "t"), transport: transport))
    }

    func testAPhotoUploadsToItsSectionWithWhereItWasTaken() async throws {
        let transport = FakeTransport { _ in .init(status: 200, body: #"{"attachment_id": 77, "section_key": "material", "kind": "PHOTO"}"#) }
        let capture = PhotoCaptureMetadata(capturedAt: "2026-10-28T19:01:10.123Z", latitude: 37.7, longitude: -122.2,
                                           cameraHeadingDeg: 123, headingSource: "DEVICE_TRUE_HEADING")
        let uploaded = try await api(transport).uploadAttachment(501, file: Data([0xFF, 0xD8]), fileName: "field-photo-1.jpg",
                                                                 mimeType: "image/jpeg", sectionKey: "material",
                                                                 kind: "PHOTO", capture: capture)
        XCTAssertEqual(uploaded.attachmentId, 77)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url?.path, "/api/submissions/501/attachments")
        XCTAssertEqual(request.url?.query, "section_key=material&kind=PHOTO")
        XCTAssertTrue(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
        let body = String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self)
        XCTAssertTrue(body.contains(#"name="capture_metadata_json""#))
        XCTAssertTrue(body.contains(#""camera_heading_deg":123"#))
        XCTAssertTrue(body.contains(#"name="file"; filename="field-photo-1.jpg""#))
        XCTAssertLessThan(try XCTUnwrap(body.range(of: "capture_metadata_json")).lowerBound,
                          try XCTUnwrap(body.range(of: "filename=")).lowerBound)
    }

    func testThePhotoMapDescribesEachPhoto() async throws {
        let transport = FakeTransport { _ in
            .init(status: 200, body: """
            {"submission_id": 501, "can_edit_corrections": true,
             "summary": {"photos_total": 2, "photos_geotagged": 1, "photos_with_heading": 1, "photos_unmapped": 1},
             "photos": [{"attachment_id": 77, "file_name": "a.jpg", "mime_type": "image/jpeg", "section_key": "material",
                         "source_scope": "SUBMISSION", "can_edit_correction": true, "captured_at": "2026-10-28T19:01:10",
                         "latitude": 37.7312, "longitude": -122.1975, "horizontal_accuracy_m": 4.6,
                         "camera_heading_deg": 123.4, "camera_heading_accuracy_code": 3,
                         "location_source": "DEVICE_AT_CAPTURE", "heading_source": "MANUAL",
                         "correction": {"has_history": true, "location_overridden": false, "heading_overridden": true,
                                        "location_override": null, "heading_override_deg": 123.4},
                         "download_url": "https://s3.example/a.jpg?sig=1"},
                        {"attachment_id": 78, "source_scope": "INCIDENT", "latitude": null, "longitude": null,
                         "camera_heading_deg": null}]}
            """)
        }
        let map = try await api(transport).photoMap(501)
        XCTAssertEqual(map.summary?.photosUnmapped, 1)
        let photo = map.photos[0]
        XCTAssertEqual(photo.locationText, "37.731200, -122.197500 · ±5 m")
        XCTAssertEqual(photo.directionText, "Facing 123° (SE)")
        XCTAssertEqual(photo.sourceText, "Location measured by the phone; direction corrected by hand")
        XCTAssertEqual(photo.correction?.headingOverrideDeg, 123.4)
        XCTAssertNil(map.photos[1].locationText)
        XCTAssertNil(map.photos[1].directionText)
    }

    func testACorrectionSendsTheWholeCorrectedState() async throws {
        let transport = FakeTransport { _ in .init(status: 200, body: "{}") }
        try await api(transport).correctPhoto(501, attachmentId: 77, PhotoCorrection(
            locationOverride: nil, headingOverrideDeg: 95, clientCorrectionUuid: "c-1"))
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/submissions/501/photo-map/photos/77/correction")
        let body = try JSONDecoder().decode([String: JSONValue].self, from: try XCTUnwrap(request.httpBody))
        XCTAssertEqual(body, ["client_correction_uuid": .string("c-1"), "location_override": .null,
                              "heading_override_deg": .number(95)])
    }

    func testAFormSectionListsOnlyItsPictures() throws {
        let detail = try JSONDecoder().decode(SubmissionDetail.self, from: Data("""
        {"submission": {"id": 1, "status": "DRAFT"},
         "photos": [{"id": 1, "file_name": "a.jpg", "mime_type": "image/jpeg", "section_key": "material"}],
         "attachments": [{"id": 1, "file_name": "a.jpg", "mime_type": "image/jpeg", "section_key": "material"},
                         {"id": 2, "file_name": "b.png", "mime_type": "image/png", "section_key": "material"},
                         {"id": 3, "file_name": "c.pdf", "mime_type": "application/pdf", "section_key": "material"},
                         {"id": 4, "file_name": "d.jpg", "mime_type": "image/jpeg", "section_key": "distribution"}]}
        """.utf8))
        XCTAssertEqual(GisaPhotoSections.photos(in: "material", of: detail).map(\.id), [1, 2])
        XCTAssertEqual(GisaPhotoSections.all.map(\.figureSection), Array(1...15))
    }
}
