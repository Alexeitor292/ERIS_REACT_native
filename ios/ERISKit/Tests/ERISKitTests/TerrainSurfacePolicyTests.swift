import XCTest
@testable import ERISKit

/// Ported from mobile/src/arcgis/terrainSurfacePolicy.test.ts: exactly one
/// visible terrain surface per base mode, and satellite imagery unlit.
final class TerrainSurfacePolicyTests: XCTestCase {
    typealias Policy = TerrainSurfacePolicy

    private let modes = Policy.BaseMode.allCases
    private let ready = Policy.Inputs(tiledImageryReady: true, singleImageAvailable: false)
    private let single = Policy.Inputs(tiledImageryReady: false, singleImageAvailable: true)
    private let none = Policy.Inputs(tiledImageryReady: false, singleImageAvailable: false)

    func testBaseAndTiledSurfacesAreNEVERBothVisibleAllModeInputCombos() {
        let both = Policy.Inputs(tiledImageryReady: true, singleImageAvailable: true)
        for mode in modes {
            for inputs in [ready, single, none, both] {
                let p = Policy.resolve(mode, inputs)
                XCTAssertTrue(Policy.surfacesAreMutuallyExclusive(p), "\(mode) / \(inputs) showed both surfaces")
                // At least one surface is always visible (never a blank scene).
                XCTAssertTrue(p.baseTerrainVisible || p.tiledImageryVisible, "\(mode) showed no surface")
            }
        }
    }

    func testTerrainReliefUsesTheBaseMeshNeverImagery() {
        for inputs in [ready, single, none] {
            let p = Policy.resolve(.relief, inputs)
            XCTAssertTrue(p.baseTerrainVisible)
            XCTAssertFalse(p.tiledImageryVisible)
            XCTAssertFalse(p.imageryUnlit)
            XCTAssertEqual(p.reason, .relief)
        }
    }

    func testSatelliteWithReadyTilesBaseHIDDENTiledVisibleImageryUNLIT() {
        let p = Policy.resolve(.satellite, ready)
        XCTAssertFalse(p.baseTerrainVisible)
        XCTAssertTrue(p.tiledImageryVisible)
        XCTAssertTrue(p.imageryUnlit)
        XCTAssertFalse(p.hillshadeOnImagery) // satellite = imagery alone
        XCTAssertEqual(p.reason, .tiledSatellite)
    }

    func testHybridWithReadyTilesBaseHIDDENTiledVisibleHillshadeOnTheSAMESurface() {
        let p = Policy.resolve(.hybrid, ready)
        XCTAssertFalse(p.baseTerrainVisible)
        XCTAssertTrue(p.tiledImageryVisible)
        XCTAssertTrue(p.imageryUnlit)
        XCTAssertTrue(p.hillshadeOnImagery) // multiplied onto the imagery surface, not a second mesh
        XCTAssertEqual(p.reason, .tiledHybrid)
    }

    func testLegacySingleImageRepaintsTheBaseMeshOneSurfaceNeverATiledSurface() {
        let sat = Policy.resolve(.satellite, single)
        XCTAssertTrue(sat.baseTerrainVisible)
        XCTAssertFalse(sat.tiledImageryVisible)
        XCTAssertTrue(sat.legacySingleImageOnBase)
        // Mirrors the native legacy branch, which also draws the imagery unlit.
        XCTAssertTrue(sat.imageryUnlit)
        XCTAssertEqual(sat.reason, .legacySingle)
        let hyb = Policy.resolve(.hybrid, single)
        XCTAssertTrue(hyb.hillshadeOnImagery)
        XCTAssertTrue(hyb.legacySingleImageOnBase)
    }

    func testMissingIncompleteImageryFallsBackToReliefNeverAPartialTiledSurface() {
        for mode in [Policy.BaseMode.satellite, .hybrid] {
            let p = Policy.resolve(mode, none)
            XCTAssertTrue(p.baseTerrainVisible)
            XCTAssertFalse(p.tiledImageryVisible)
            XCTAssertEqual(p.reason, .reliefFallback)
        }
    }

    func testReadyTilesTakePriorityOverALegacySingleImage() {
        let p = Policy.resolve(.satellite, Policy.Inputs(tiledImageryReady: true, singleImageAvailable: true))
        XCTAssertTrue(p.tiledImageryVisible)
        XCTAssertFalse(p.legacySingleImageOnBase)
    }
}
