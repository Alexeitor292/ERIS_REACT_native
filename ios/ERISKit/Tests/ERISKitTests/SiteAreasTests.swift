import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Ported from web/src/components/siteAreasModel.test.ts.
final class SiteAreasTests: XCTestCase {
    // A square 0.001° on a side near Sacramento (~111 m × ~87 m).
    private let square: SiteAreas.Ring = [[-121.5, 38.5], [-121.499, 38.5], [-121.499, 38.501], [-121.5, 38.501], [-121.5, 38.5]]

    func testASmallSquaresGeodesicAreaIsRightToWithinAFractionOfAPercent() {
        let side: Double = 111.32 * 0.001 * 1000
        let latitude: Double = 38.5005 * Double.pi / 180
        let expected: Double = side * (side * cos(latitude))
        let actual = SiteAreas.ringArea(square)
        XCTAssertLessThan(abs(actual - expected) / expected, 0.005)
        XCTAssertEqual(SiteAreas.ringArea(square.reversed()).rounded(), actual.rounded(), "winding does not matter")
    }

    func testHolesAreSubtracted() {
        let hole: SiteAreas.Ring = [[-121.4998, 38.5002], [-121.4992, 38.5002], [-121.4992, 38.5008], [-121.4998, 38.5008], [-121.4998, 38.5002]]
        XCTAssertLessThan(SiteAreas.area([square, hole]), SiteAreas.ringArea(square))
    }

    func testStoredGeometryYieldsItsPolygonsAndAreasStoreBackAsPolygonOrMultiPolygon() throws {
        func json(_ text: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }
        let ring = "[[-121.5,38.5],[-121.499,38.5],[-121.499,38.501],[-121.5,38.501],[-121.5,38.5]]"
        XCTAssertEqual(SiteAreas.areas(fromGeoJSON: try json(#"{"type": "Polygon", "coordinates": [\#(ring)]}"#)).count, 1)
        XCTAssertEqual(SiteAreas.areas(fromGeoJSON: try json(#"{"type": "MultiPolygon", "coordinates": [[\#(ring)], [\#(ring)]]}"#)).count, 2)
        XCTAssertEqual(SiteAreas.areas(fromGeoJSON: try json(#"{"type": "GeometryCollection", "geometries": [{"type": "Polygon", "coordinates": [\#(ring)]}, {"type": "Point", "coordinates": [0, 0]}]}"#)).count, 1)
        XCTAssertEqual(SiteAreas.areas(fromGeoJSON: try json(#"{"type": "LineString", "coordinates": [[0, 0], [1, 1]]}"#)).count, 0)
        XCTAssertEqual(SiteAreas.areas(fromGeoJSON: nil).count, 0)
        XCTAssertEqual(SiteAreas.areas(fromText: ""), [])

        XCTAssertNil(SiteAreas.geoJSON([]))
        XCTAssertEqual(SiteAreas.areas(fromText: SiteAreas.text([[square]])), [[square]], "round trip")
        XCTAssertTrue(SiteAreas.text([[square]]).contains(#""type":"Polygon""#))
        XCTAssertTrue(SiteAreas.text([[square], [square]]).contains(#""type":"MultiPolygon""#))
        XCTAssertNil(SiteAreas.geoJSON([[[[0, 0], [1, 1], [0, 0]]]]), "a degenerate ring is not an area")
    }

    func testAreasReadInTheUnitsACaltransEngineerUses() {
        XCTAssertEqual(SiteAreas.format(5020), "5,020 m² · 1.24 ac")
        XCTAssertEqual(SiteAreas.format(650), "650 m² · 6,997 ft²")
        XCTAssertEqual(SiteAreas.summary([]), "No areas drawn")
        XCTAssertTrue(SiteAreas.summary([[square], [square]]).hasPrefix("2 areas · "))
    }
}

final class ArcGISConfigTests: XCTestCase {
    func testTheKeyAndLicenseComeFromERISAndAKeptCopyLastsTheOfflineWindow() async throws {
        final class Server: HTTPTransport, @unchecked Sendable {
            var reachable = true
            func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
                guard reachable else { throw APIError.transport("offline") }
                let body = #"{"runtime_enabled": true, "api_key": "AAPK-test", "license_key": "runtimelite,1000,rud0001", "license_expires_at": null, "mmpk_url": null, "offline_ttl_hours": 72, "issued_at": "2026-10-28T12:00:00+00:00", "requested_by_user_id": 1}"#
                return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }
        }
        let server = Server()
        let store = OfflineStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("eris-arcgis-\(UUID().uuidString)"))
        defer { store.wipe() }
        let api = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"), transport: server)
        let issued = try XCTUnwrap(ServerDate.parse("2026-10-28T12:00:00+00:00"))
        let online = try await api.arcGISConfig(keepingIn: store, now: issued)
        XCTAssertEqual(online?.apiKey, "AAPK-test")
        server.reachable = false
        let withinWindow = try await api.arcGISConfig(keepingIn: store, now: issued.addingTimeInterval(71 * 3600))
        XCTAssertEqual(withinWindow?.licenseKey, "runtimelite,1000,rud0001")
        let expired = try await api.arcGISConfig(keepingIn: store, now: issued.addingTimeInterval(73 * 3600))
        XCTAssertNil(expired, "past the server's offline window")
    }
}
