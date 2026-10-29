import XCTest
@testable import ERISKit

final class RoadInventoryTests: XCTestCase {
    /// `{"schema_version":2,"segments":[],"postmile_points":[]}`, gzipped by Python with mtime 0.
    private let gzipped = Data([31, 139, 8, 0, 0, 0, 0, 0, 2, 255, 171, 86, 42, 78, 206, 72, 205, 77, 140, 47, 75, 45, 42, 206, 204,
                                207, 83, 178, 50, 210, 81, 42, 78, 77, 207, 77, 205, 43, 41, 86, 178, 138, 142, 213, 81, 42, 200, 47,
                                46, 201, 205, 204, 73, 141, 47, 200, 207, 132, 10, 214, 2, 0, 59, 218, 218, 171, 55, 0, 0, 0])
    private let gzippedSHA = "a5c1e22e09ea7019fe72cf8bb599f5ebc97b5c6e44f2b1049bcd14444a9e5168"

    func testSHA256MatchesTheStandard() {
        XCTAssertEqual(SHA256.hex(Data()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(SHA256.hex(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(SHA256.hex(Data(repeating: 0x61, count: 1000)),
                       "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3", "several blocks")
        XCTAssertEqual(SHA256.hex(gzipped), gzippedSHA)
    }

    func testADamagedDownloadIsRefusedBeforeItIsRead() {
        XCTAssertThrowsError(try RoadInventoryPackage.read(gzipped, expectedSHA256: String(repeating: "0", count: 64))) { error in
            guard case RoadInventoryError.integrity = error else { return XCTFail("\(error)") }
        }
        XCTAssertThrowsError(try RoadInventoryPackage.parse(Data(#"{"schema_version": 3, "segments": []}"#.utf8))) { error in
            XCTAssertEqual(error as? RoadInventoryError, .unsupported(3))
        }
        XCTAssertThrowsError(try RoadInventoryPackage.parse(Data(#"{"schema_version": 2, "segments": []}"#.utf8)),
                             "schema 2 carries the postmile points")
    }

    #if canImport(Compression)
    func testThePackageIsUnzippedAndRead() throws {
        let read = try RoadInventoryPackage.read(gzipped, expectedSHA256: gzippedSHA)
        XCTAssertEqual(read.segments, [])
        XCTAssertEqual(read.points, [])
    }
    #endif

    /// Route 880 in Alameda, running north from PM 10.0 with a reference every tenth of a mile.
    private let reference: RoadReference = {
        let step = 0.1 * 1609.344 / 111_320  // a tenth of a mile, in degrees of latitude
        let points = (0...3).map { i in
            PostmilePoint(districtCode: "04", countyCode: "ALA", routeName: "880", postmile: 10.0 + Double(i) / 10,
                          latitude: 37.0 + Double(i) * step, longitude: -122.0)
        }
        let segments = [
            RoadSegment(id: 1, districtCode: "03", countyCode: "ALA", routeName: "880", beginPm: 0, endPm: 20, leftLanes: 3, rightLanes: 3),
            RoadSegment(id: 2, districtCode: "04", countyCode: "ALA", routeName: "880", beginPm: 9, endPm: 11, leftLanes: 2, rightLanes: 2,
                        leftSurfaceType: "AC", rightSurfaceType: "AC", designSpeed: 65),
            RoadSegment(id: 3, districtCode: "04", countyCode: "ALA", routeName: "580", beginPm: 9, endPm: 11),
        ]
        return RoadReference(segments: segments, points: points)
    }()

    func testACoordinateFindsItsPostMileBetweenReferencePoints() throws {
        let step = 0.1 * 1609.344 / 111_320
        let east20m = 20 / (111_320 * cos(37.0 * .pi / 180))
        let fix = try XCTUnwrap(reference.locate(latitude: 37.0 + 1.5 * step, longitude: -122.0 + east20m))
        XCTAssertEqual(fix.method, .projectedReference)
        XCTAssertEqual(fix.postMile, "10.15")
        XCTAssertEqual(fix.route, "880")
        XCTAssertEqual(fix.county, "ALA")
        XCTAssertEqual(fix.district, "04")
        XCTAssertEqual(fix.distanceMeters ?? 0, 20, accuracy: 0.5)
        XCTAssertNil(reference.locate(latitude: 38.0, longitude: -122.0), "no highway within 3 km")
    }

    func testAPostMileFindsWhereItIs() throws {
        let step = 0.1 * 1609.344 / 111_320
        let exact = try XCTUnwrap(reference.position(district: "4", county: "ala", route: "SR 880", postMile: "10.2"))
        XCTAssertEqual(exact.method, .exactPostmile)
        XCTAssertEqual(exact.latitude, 37.0 + 2 * step, accuracy: 1e-9)
        let between = try XCTUnwrap(reference.position(district: nil, county: "ALA", route: "880", postMile: "10.15"))
        XCTAssertEqual(between.method, .interpolatedPostmile)
        XCTAssertEqual(between.latitude, 37.0 + 1.5 * step, accuracy: 1e-9)
        XCTAssertEqual(between.postMile, "10.15")
        let past = try XCTUnwrap(reference.position(district: nil, county: "ALA", route: "880", postMile: "10.40"))
        XCTAssertEqual(past.method, .nearestReference, "within 0.12 mile of the last point")
        XCTAssertNil(reference.position(district: nil, county: "ALA", route: "880", postMile: "10.50"))
        XCTAssertNil(reference.position(district: nil, county: "ALA", route: "880", postMile: "R10.2"), "no realigned section here")
    }

    func testTheRoadAtAPostMileIsTheDistrictsShortestSegment() {
        let found = reference.segments(county: "ALA", route: "880", postMile: 10.1, district: "04")
        XCTAssertEqual(found.map(\.id), [2, 1])
        XCTAssertEqual(found[0].summary, "2 + 2 lanes · AC / AC · 65 mph")
    }

    func testRoutesAndPostMilesAreReadAsCaltransWritesThem() {
        XCTAssertEqual(RoadReference.normalizeRoute("SR 001"), "1")
        XCTAssertEqual(RoadReference.normalizeRoute("US101"), "101")
        XCTAssertEqual(RoadReference.paddedRoute("1"), "001")
        XCTAssertEqual(RoadReference.normalizeDistrict("4"), "04")
        let parsed = RoadReference.parsePostmile("r12.3l")
        XCTAssertEqual(parsed?.prefix, "R")
        XCTAssertEqual(parsed?.value, 12.3)
        XCTAssertEqual(parsed?.suffix, "L")
        XCTAssertNil(RoadReference.parsePostmile("12.3.4"))
        XCTAssertEqual(RoadReference.formatPostmile(12.345, "r", nil), "R12.35")
    }

    #if canImport(Compression)
    func testThePackageIsKeptAndOnlyDownloadedWhenItChanges() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("road-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let body = gzipped, sha = gzippedSHA
        // The package is binary; serve it through a transport that returns bytes.
        let bytes = BytesTransport(manifestSHA: sha, package: body)
        let api = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"), transport: bytes)
        let store = RoadInventoryStore(directory: folder)
        XCTAssertTrue(store.due())
        let meta = try await store.update(api: api)
        XCTAssertEqual(meta.versionTag, "2026-10")
        XCTAssertNotNil(store.loaded())
        XCTAssertFalse(store.due())
        _ = try await store.update(api: api)
        XCTAssertEqual(bytes.downloads, 1, "the same package is not downloaded again")
    }
    #endif
}

/// Serves the manifest as JSON and the package as its own bytes.
private final class BytesTransport: HTTPTransport, @unchecked Sendable {
    let manifestSHA: String
    let package: Data
    private(set) var downloads = 0

    init(manifestSHA: String, package: Data) {
        self.manifestSHA = manifestSHA
        self.package = package
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        if request.url!.path.hasSuffix("/manifest") {
            return (Data(#"{"version_id": 4, "version_tag": "2026-10", "extract_date": "2026-10-01", "package": {"available": true, "size_bytes": 72, "sha256": "\#(manifestSHA)", "generated_at": "2026-10-02"}}"#.utf8), response)
        }
        downloads += 1
        return (package, response)
    }
}
