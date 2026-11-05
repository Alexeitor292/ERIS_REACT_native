import XCTest
@testable import ERISKit

/// Ported from mobile/src/arcgis/terrainOverlays.test.ts.
final class TerrainOverlaysTests: XCTestCase {
    typealias TO = TerrainOverlays
    typealias LL = TerrainOverlays.LonLat

    // A 3x3 grid over a 0.04deg x 0.04deg area; NW corner = (min_lon, max_lat).
    private let terrain = TerrainBundle.TerrainMeta(
        file: "elevation-grid.bin", rows: 3, columns: 3, encoding: "float32", byteOrder: "little", noDataValue: -9999,
        minElevationM: 1, maxElevationM: 9, verticalUnits: "meters",
        bounds: TerrainBundle.Bounds(minLat: 38.48, minLon: -121.52, maxLat: 38.52, maxLon: -121.48),
        localTransform: TerrainBundle.LocalTransform(originLon: -121.52, originLat: 38.52, lonPerCol: 0.02, latPerRow: -0.02),
        sha256: String(repeating: "a", count: 64))
    private let ws: Double = 100 // world half-extent

    private func near(_ a: Double, _ b: Double, _ eps: Double = 1e-6) -> Bool { abs(a - b) < eps }

    private func kinds(_ prims: [TO.OverlayPrimitive]) -> [TO.OverlayKind] { prims.map(\.kind) }

    private func json(_ text: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private func normalize(_ text: String) -> [TO.OverlayPrimitive] { TO.normalizeOverlayGeometry(json(text)) }

    private func mesh(_ p: LL) -> TO.MeshXZ { TO.lonLatToMeshXZ(terrain, lon: p.lon, lat: p.lat, worldSize: ws) }

    func testPointCoordinateMapsToTheTerrainMeshCenterCorners() {
        // Incident centre -> mesh origin.
        let c = TO.lonLatToMeshXZ(terrain, lon: -121.5, lat: 38.5, worldSize: ws)
        XCTAssertTrue(near(c.x, 0) && near(c.z, 0))
        // NW corner (min_lon, max_lat) -> (-WS, -WS); SE corner -> (+WS, +WS).
        let nw = TO.lonLatToMeshXZ(terrain, lon: -121.52, lat: 38.52, worldSize: ws)
        XCTAssertTrue(near(nw.x, -ws) && near(nw.z, -ws))
        let se = TO.lonLatToMeshXZ(terrain, lon: -121.48, lat: 38.48, worldSize: ws)
        XCTAssertTrue(near(se.x, ws) && near(se.z, ws))
    }

    func testAGeoJSONPointNormalizesMapsOntoTheMesh() {
        let prims = normalize(#"{"type": "Point", "coordinates": [-121.5, 38.5]}"#)
        XCTAssertEqual(kinds(prims), [.point])
        let xz = mesh(prims[0].coords[0])
        XCTAssertTrue(near(xz.x, 0) && near(xz.z, 0))
    }

    func testALineLineStringMapsEachVertexToTheMesh() {
        // NW, centre, SE.
        let prims = normalize(#"{"type": "LineString", "coordinates": [[-121.52, 38.52], [-121.5, 38.5], [-121.48, 38.48]]}"#)
        XCTAssertEqual(kinds(prims), [.line])
        let pts = prims[0].coords.map(mesh)
        XCTAssertTrue(near(pts[0].x, -ws) && near(pts[0].z, -ws))
        XCTAssertTrue(near(pts[1].x, 0) && near(pts[1].z, 0))
        XCTAssertTrue(near(pts[2].x, ws) && near(pts[2].z, ws))
    }

    func testAPolygonRingMapsItsCornersToTheMesh() {
        let prims = normalize(#"{"type": "Polygon", "coordinates": [[[-121.52, 38.52], [-121.48, 38.52], [-121.48, 38.48], [-121.52, 38.48], [-121.52, 38.52]]]}"#)
        XCTAssertEqual(kinds(prims), [.polygon])
        let pts = prims[0].coords.map(mesh)
        // NW, NE, SE, SW corners of the mesh.
        XCTAssertTrue(near(pts[0].x, -ws) && near(pts[0].z, -ws))
        XCTAssertTrue(near(pts[1].x, ws) && near(pts[1].z, -ws))
        XCTAssertTrue(near(pts[2].x, ws) && near(pts[2].z, ws))
        XCTAssertTrue(near(pts[3].x, -ws) && near(pts[3].z, ws))
    }

    func testSampleExtentRingMapsToTheFourMeshCorners() {
        let ring = TO.sampleExtentRing(minLat: 38.48, minLon: -121.52, maxLat: 38.52, maxLon: -121.48)
        XCTAssertEqual(ring.count, 5) // closed rectangle
        let pts = ring.map(mesh)
        XCTAssertTrue(near(pts[0].x, -ws) && near(pts[0].z, ws)) // SW (minLon, minLat)
        XCTAssertTrue(near(pts[1].x, ws) && near(pts[1].z, ws)) // SE
        XCTAssertTrue(near(pts[2].x, ws) && near(pts[2].z, -ws)) // NE
        XCTAssertTrue(near(pts[3].x, -ws) && near(pts[3].z, -ws)) // NW
        XCTAssertEqual(pts[0], pts[4]) // closed
    }

    func testColRowMeshMappingComposeConsistently() {
        let cell = TO.lonLatToColRow(terrain, lon: -121.5, lat: 38.5)
        XCTAssertTrue(near(cell.col, 1) && near(cell.row, 1))
        let xz = TO.colRowToMeshXZ(rows: terrain.rows, cols: terrain.columns, col: cell.col, row: cell.row, worldSize: ws)
        XCTAssertTrue(near(xz.x, 0) && near(xz.z, 0))
    }

    func testNormalizeOverlayGeometryHandlesFeatureFeatureCollectionGeometryCollection() {
        XCTAssertEqual(kinds(normalize(#"{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-121.5, 38.5]}}"#)), [.point])
        XCTAssertEqual(kinds(normalize(#"""
        {"type": "FeatureCollection", "features": [
          {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-121.5, 38.5]}},
          {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[-121.52, 38.52], [-121.48, 38.48]]}}
        ]}
        """#)), [.point, .line])
        XCTAssertEqual(kinds(normalize(#"""
        {"type": "GeometryCollection", "geometries": [
          {"type": "Point", "coordinates": [-121.5, 38.5]},
          {"type": "Polygon", "coordinates": [[[-121.52, 38.52], [-121.48, 38.52], [-121.48, 38.48], [-121.52, 38.52]]]}
        ]}
        """#)), [.point, .polygon])
    }

    func testNormalizeOverlayGeometryHandlesMultiGeometriesEsriJSON() {
        XCTAssertEqual(kinds(normalize(#"{"type": "MultiPoint", "coordinates": [[-121.5, 38.5], [-121.49, 38.49]]}"#)), [.point, .point])
        XCTAssertEqual(kinds(normalize(#"{"type": "MultiLineString", "coordinates": [[[-121.52, 38.52], [-121.5, 38.5]]]}"#)), [.line])
        XCTAssertEqual(kinds(normalize(#"{"type": "MultiPolygon", "coordinates": [[[[-121.52, 38.52], [-121.48, 38.52], [-121.48, 38.48], [-121.52, 38.52]]]]}"#)),
                       [.polygon])
        // Esri JSON shapes.
        XCTAssertEqual(kinds(normalize(#"{"x": -121.5, "y": 38.5}"#)), [.point])
        XCTAssertEqual(kinds(normalize(#"{"points": [[-121.5, 38.5], [-121.49, 38.49]]}"#)), [.point, .point])
        XCTAssertEqual(kinds(normalize(#"{"paths": [[[-121.52, 38.52], [-121.5, 38.5]]]}"#)), [.line])
        XCTAssertEqual(kinds(normalize(#"{"rings": [[[-121.52, 38.52], [-121.48, 38.52], [-121.48, 38.48], [-121.52, 38.52]]]}"#)), [.polygon])
    }

    func testWebMercatorCoordinatesAreCoercedToLonLatNotInvented() throws {
        // -121.5, 38.5 in EPSG:3857 metres.
        let xMerc: Double = (-121.5 / 180) * 20_037_508.34
        let latRad: Double = (38.5 * Double.pi) / 180
        let tangent: Double = tan(Double.pi / 4 + latRad / 2)
        let yMerc: Double = (20_037_508.34 / Double.pi) * log(tangent)
        let ll = try XCTUnwrap(TO.toLonLat(.array([.number(xMerc), .number(yMerc)])))
        XCTAssertTrue(near(ll.lon, -121.5, 1e-4) && near(ll.lat, 38.5, 1e-4))
        // A WGS84 pair is returned unchanged.
        XCTAssertEqual(TO.toLonLat(.array([.number(-121.5), .number(38.5)])), LL(-121.5, 38.5))
        XCTAssertNil(TO.toLonLat(.array([.number(.nan), .number(1)])))
    }

    func testInBoundsDetectionClippingDropOutOfBoundsVerticesNoInventedCoords() {
        XCTAssertTrue(TO.isLonLatInBounds(terrain, lon: -121.5, lat: 38.5)) // centre
        XCTAssertTrue(TO.isLonLatInBounds(terrain, lon: -121.52, lat: 38.52)) // NW corner
        XCTAssertFalse(TO.isLonLatInBounds(terrain, lon: -120.0, lat: 38.5)) // far east of the area
        XCTAssertFalse(TO.isLonLatInBounds(terrain, lon: -121.5, lat: 39.0)) // north of the area
        let clipped = TO.clipToBounds(terrain, [
            LL(-121.5, 38.5), // in
            LL(-120.0, 38.5), // out (east)
            LL(-121.49, 38.49), // in
        ])
        XCTAssertEqual(clipped, [LL(-121.5, 38.5), LL(-121.49, 38.49)])
    }
}
