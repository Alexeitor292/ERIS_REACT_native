import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// ERIS with a terrain package for form 501 (or none yet), and storage with its bytes.
private final class TerrainServer: HTTPTransport, @unchecked Sendable {
    let lock = NSLock()
    var prepared = true
    var package: [UInt8] = []
    private(set) var generated = 0
    private(set) var grants = 0

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body): (Int, Any) = lock.locked {
            let path = request.url!.path
            let sha = SHA256.hex(Data(package))
            switch (request.httpMethod ?? "GET", path) {
            case ("GET", "/api/submissions/501/gisa/offline-scene-package"):
                guard prepared else { return (200, ["submission_id": 501, "available": false, "reason": "Not prepared yet"]) }
                return (200, ["submission_id": 501, "available": true,
                              "package": ["format": "eristerrain", "version": "3", "size_bytes": package.count, "sha256": sha,
                                          "elevation": ["dataset": "USGS 3DEP"]]])
            case ("POST", "/api/submissions/501/gisa/offline-scene-package/generate"):
                generated += 1
                return (202, ["id": 9, "submission_id": 501, "status": "QUEUED"])
            case ("GET", "/api/submissions/501/gisa/offline-scene-package/download"):
                grants += 1
                return (200, ["submission_id": 501, "url": "https://storage.test/501.eristerrain", "expires_in_seconds": 900,
                              "object_key": "scenes/501.eristerrain", "sha256": sha, "size_bytes": package.count,
                              "package_version": "3", "package_format": "eristerrain", "content_signature": "sig"])
            default:
                return (404, ["detail": "Not found"])
            }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (try JSONSerialization.data(withJSONObject: body), response)
    }
}

final class AssignedTerrainTests: XCTestCase {
    private let server = TerrainServer()
    private var store: OfflineStore!
    private var api: APIClient!

    override func setUp() {
        store = OfflineStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("eris-terrain-\(UUID().uuidString)"))
        api = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"), transport: server)
        let manifest = #"{"format":"eristerrain","format_version":2,"elevation":{"source":"USGS_3DEP","dataset":"USGS 3DEP","version":"2026-06-27","resolution":"10 m/px"},"terrain":{"file":"elevation-grid.bin","rows":3,"columns":3,"encoding":"float32","byte_order":"little","no_data_value":-9999,"min_elevation_m":1,"max_elevation_m":9,"vertical_units":"meters","bounds":{"min_lat":38.48,"min_lon":-121.52,"max_lat":38.52,"max_lon":-121.48},"local_transform":{"origin_lon":-121.52,"origin_lat":38.52,"lon_per_col":0.02,"lat_per_row":-0.02},"sha256":"\#(String(repeating: "a", count: 64))"}}"#
        server.package = makeStoredZip([("manifest.json", Array(manifest.utf8)), ("elevation-grid.bin", f32le([1, 2, 3, 4, 5, 6, 7, 8, 9]))])
    }

    override func tearDown() { store.wipe() }

    private func terrain(_ download: @escaping @Sendable (URL) async throws -> Data) -> AssignedTerrain {
        AssignedTerrain(api: api, store: store, download: download)
    }

    func testAPreparedTerrainIsDownloadedCheckedAndUnpackedOnce() async throws {
        let bytes = Data(server.package)
        let first = await terrain { _ in bytes }.keep(501)
        XCTAssertEqual(first, .downloaded)
        let folder = try XCTUnwrap(store.terrainFolder(501))
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent("elevation-grid.bin").path))
        let again = await terrain { _ in bytes }.keep(501)
        XCTAssertEqual(again, .kept)
        XCTAssertEqual(server.grants, 1, "not downloaded twice")
    }

    func testADamagedDownloadIsRefusedAndNothingIsKept() async {
        let outcome = await terrain { _ in Data([1, 2, 3]) }.keep(501)
        XCTAssertEqual(outcome, .unavailable("The terrain download was damaged; it will be tried again."))
        XCTAssertNil(store.terrainFolder(501))
    }

    func testASiteWithNoTerrainYetIsAskedFor() async {
        server.prepared = false
        let outcome = await terrain { _ in Data() }.keep(501)
        XCTAssertEqual(outcome, .preparing)
        XCTAssertEqual(server.generated, 1)
    }
}
