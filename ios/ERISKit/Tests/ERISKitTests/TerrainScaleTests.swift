import XCTest
@testable import ERISKit

/// Ported from mobile/src/arcgis/terrainScale.test.ts.
final class TerrainScaleTests: XCTestCase {
    typealias TS = TerrainScale

    // A 3x3 grid over a 0.04deg x 0.04deg area near lat 38.5; NW corner = (min_lon, max_lat).
    private let meta = TS.Grid(rows: 3, columns: 3,
                               bounds: TerrainBundle.Bounds(minLat: 38.48, minLon: -121.52, maxLat: 38.52, maxLon: -121.48),
                               localTransform: TerrainBundle.LocalTransform(originLon: -121.52, originLat: 38.52, lonPerCol: 0.02, latPerRow: -0.02))
    private let ws: Double = 100

    private func near(_ a: Double, _ b: Double, _ epsRel: Double = 1e-6) -> Bool {
        let tolerance: Double = abs(b) * epsRel + 1e-9
        return abs(a - b) <= tolerance
    }

    func testPhysicalFootprintMetresFromLocalTransformCosLatAdjusted() throws {
        let fp = try XCTUnwrap(TS.physicalFootprintMeters(meta))
        // height = 0.04deg * 111320
        let height: Double = 0.04 * 111_320
        XCTAssertTrue(near(fp.heightM, height))
        // width = 0.04deg * 111320 * cos(38.5deg)  (< height, since |cos| < 1)
        let cosLat: Double = cos((38.5 * Double.pi) / 180)
        let width: Double = height * cosLat
        XCTAssertTrue(near(fp.widthM, width))
        XCTAssertLessThan(fp.widthM, fp.heightM)
    }

    func testLocalTransformAndBoundsAgree() throws {
        var boundsOnly = meta
        boundsOnly.localTransform = nil
        let fromBounds = try XCTUnwrap(TS.physicalFootprintMeters(boundsOnly))
        let fromLt = try XCTUnwrap(TS.physicalFootprintMeters(meta))
        XCTAssertTrue(near(fromBounds.widthM, fromLt.widthM) && near(fromBounds.heightM, fromLt.heightM))
    }

    func testSceneScalePreservesPhysicalAspectRatioNotForcedSquare() throws {
        let s = try XCTUnwrap(TS.sceneScale(meta, worldSize: ws))
        // The larger dimension (height) fills 2*worldSize; the smaller (width) keeps the ratio.
        XCTAssertTrue(near(s.halfDepthUnits, ws)) // height is the max dim -> half-extent == worldSize
        XCTAssertLessThan(s.halfWidthUnits, s.halfDepthUnits) // narrower east-west -> smaller X extent
        XCTAssertTrue(near(s.halfWidthUnits / s.halfDepthUnits, s.widthM / s.heightM))
        // scene units per metre = 2*worldSize / max(width, height)
        XCTAssertTrue(near(s.sceneUnitsPerMeter, (2 * ws) / s.heightM))
    }

    func test10xIsTrueScaleSceneYUsesTheHorizontalSceneUnitsPerMetre() throws {
        let s = try XCTUnwrap(TS.sceneScale(meta, worldSize: ws))
        let y1 = TS.elevationToSceneY(150, 100, s.sceneUnitsPerMeter, 1.0)
        XCTAssertTrue(near(y1, 50 * s.sceneUnitsPerMeter)) // 50 m of relief * units/m
    }

    func test20xExactlyDoublesAnd05xExactlyHalvesTheVerticalDisplayHeight() throws {
        let s = try XCTUnwrap(TS.sceneScale(meta, worldSize: ws))
        let y1 = TS.elevationToSceneY(150, 100, s.sceneUnitsPerMeter, 1.0)
        let y2 = TS.elevationToSceneY(150, 100, s.sceneUnitsPerMeter, 2.0)
        let yHalf = TS.elevationToSceneY(150, 100, s.sceneUnitsPerMeter, 0.5)
        XCTAssertTrue(near(y2, 2 * y1))
        XCTAssertTrue(near(yHalf, 0.5 * y1))
    }

    func testHorizontalScaleDoesNOTChangeWhenVerticalExaggerationChanges() throws {
        let s = try XCTUnwrap(TS.sceneScale(meta, worldSize: ws))
        // sceneScale has no exaggeration input; horizontal half-extents are fixed.
        for exag in [0.5, 1.0, 2.0, 3.0] {
            // Only Y depends on exag; X/Z (halfWidthUnits/halfDepthUnits) are exag-independent.
            let y = TS.elevationToSceneY(120, 100, s.sceneUnitsPerMeter, exag)
            let expected: Double = 20 * s.sceneUnitsPerMeter * exag
            XCTAssertTrue(near(y, expected))
        }
        XCTAssertTrue(near(s.halfWidthUnits, (s.widthM * s.sceneUnitsPerMeter) / 2))
    }

    func testDegenerateMalformedMetadataFailsSafeNullNeverThrows() {
        XCTAssertNil(TS.physicalFootprintMeters(nil))
        XCTAssertNil(TS.physicalFootprintMeters(TS.Grid(rows: 1, columns: 3, bounds: meta.bounds, localTransform: nil)))
        XCTAssertNil(TS.physicalFootprintMeters(TS.Grid(rows: 3, columns: 3,
                                                        bounds: TerrainBundle.Bounds(minLat: 1, minLon: 1, maxLat: 1, maxLon: 2),
                                                        localTransform: nil))) // zero-height bounds
        XCTAssertNil(TS.sceneScale(nil, worldSize: ws))
        XCTAssertNil(TS.sceneScale(meta, worldSize: 0)) // bad worldSize
        // An invalid local_transform (lon_per_col <= 0) falls back to the bounds.
        var badTransform = meta
        badTransform.localTransform = TerrainBundle.LocalTransform(originLon: -121.52, originLat: 38.52, lonPerCol: -1, latPerRow: -0.02)
        let s = TS.sceneScale(badTransform, worldSize: ws)
        XCTAssertTrue(s != nil && s!.sceneUnitsPerMeter > 0)
    }

    func testSnapLabels0530Step01TrueScaleDefault() {
        XCTAssertEqual(TS.snapExaggeration(1.04), 1.0)
        XCTAssertEqual(TS.snapExaggeration(1.06), 1.1)
        XCTAssertEqual(TS.snapExaggeration(0.1), TS.vertExagMin) // clamp low
        XCTAssertEqual(TS.snapExaggeration(9), TS.vertExagMax) // clamp high
        XCTAssertEqual(TS.snapExaggeration(.nan), TS.vertExagDefault)
        XCTAssertTrue(TS.exaggerationLabel(1.0).contains("1.0× True scale"))
        XCTAssertTrue(TS.exaggerationLabel(0.5).contains("Flattened"))
        XCTAssertTrue(TS.exaggerationLabel(2.0).contains("Enhanced relief"))
        XCTAssertTrue(TS.exaggerationLabel(3.0).contains("High relief"))
    }

    // A ~3 km area (the field package scale that exposed the 27 m road-float bug).
    private let meta3km = TS.Grid(rows: 3, columns: 3,
                                  bounds: TerrainBundle.Bounds(minLat: 38.485, minLon: -121.517, maxLat: 38.512, maxLon: -121.483),
                                  localTransform: TerrainBundle.LocalTransform(originLon: -121.517, originLat: 38.512, lonPerCol: 0.017, latPerRow: -0.0135))

    func testPhysicalScaleRoadDrapeLiftIsMetreDerivedAnd030MNOTTheOld27M() throws {
        let s = try XCTUnwrap(TS.sceneScale(meta3km, worldSize: ws))
        let maxDim = max(s.widthM, s.heightM)
        XCTAssertTrue(maxDim > 2500 && maxDim < 3500, "area is ~3 km")

        // The metre-derived road lift converts back to ~0.30 m, well below 1 m.
        let roadLiftUnits = TS.drapeLiftSceneUnits(s, .road)
        let roadLiftMeters = TS.sceneUnitsToMeters(s, roadLiftUnits)
        XCTAssertTrue(near(roadLiftMeters, TS.DrapeLayer.road.liftMeters), "road lift round-trips to its metre value")
        XCTAssertLessThan(roadLiftMeters, 1.0, "road lift \(roadLiftMeters) m must be < 1 m")

        // The OLD worldSize-percentage lift (worldSize * 0.018) is ~27 m on this area: the bug.
        let legacyUnits = ws * TS.legacyRoadLiftWorldSizeFactor
        let legacyMeters = TS.sceneUnitsToMeters(s, legacyUnits)
        XCTAssertTrue(legacyMeters > 20 && legacyMeters < 35, "legacy lift \(legacyMeters) m ≈ 27 m (documents the bug)")
        XCTAssertLessThan(roadLiftMeters, legacyMeters / 20, "new lift is dramatically smaller than the old one")
    }

    func testPhysicalScaleIncidentMarkerIsA10MRingNeverA75MFootprint() {
        XCTAssertTrue(TS.incidentRingDiameterM >= 8 && TS.incidentRingDiameterM <= 12, "8–12 m ground ring")
        XCTAssertLessThan(TS.incidentRingDiameterM, 75, "not the old 75 m sphere")
    }

    func testPhysicalScaleDrapedLayersAreOrderedCloselyStackedAll1MNoParallaxGap() {
        let order: [TS.DrapeLayer] = [.imagery, .road, .submitted, .boundary, .selectedRoad, .sliceIndicator]
        for i in 1..<order.count {
            XCTAssertGreaterThan(order[i].liftMeters, order[i - 1].liftMeters, "\(order[i]) lifts above \(order[i - 1])")
        }
        for layer in order { XCTAssertLessThan(layer.liftMeters, 1.0, "\(layer) lift < 1 m") }
        // Imagery, road and the slice indicator sit within ~0.6 m of each other: no large
        // parallax-producing gap between the aerial drape and the overlays.
        XCTAssertLessThan(TS.DrapeLayer.sliceIndicator.liftMeters - TS.DrapeLayer.imagery.liftMeters, 0.7)
    }
}
