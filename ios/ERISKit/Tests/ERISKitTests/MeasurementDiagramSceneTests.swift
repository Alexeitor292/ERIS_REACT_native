import XCTest
@testable import ERISKit

/// The diagram's geometry and words, worked from
/// mobile/src/components/RoadCrossSectionRenderer.tsx and
/// MeasurementDiagramRenderer.tsx.
final class MeasurementDiagramSceneTests: XCTestCase {
    private func data(_ values: [String: String] = [:], snapshot: [String: JSONValue]? = nil,
                      template: DiagramTemplate? = nil, side: FailureSide = .lt,
                      terrain: TerrainShape? = nil) -> MeasurementDiagramData {
        var form = GisaForm()
        for (key, value) in values { form[key] = value }
        return MeasurementDiagramData(form: form, snapshot: snapshot, template: template, failureSide: side,
                                      terrainShape: terrain, profile: nil)
    }

    private func texts(_ scene: MeasurementDiagramScene) -> [String] {
        scene.items.compactMap { if case .text(let text, _, _, _, _, _) = $0 { return text } else { return nil } }
    }

    func testATwoLaneRoadIsLaidOutUpstationAcrossTheWidth() {
        // 32 ft across 400 − 2 × 32 points: 10.5 points a foot.
        let layout = MeasurementDiagramScene.Layout(data().crossSection, width: 400)
        XCTAssertEqual(layout.elements.map(\.x), [32, 74, 200, 326])
        XCTAssertEqual(layout.elements.map(\.w), [42, 126, 126, 42])
        XCTAssertEqual(layout.ltEdge, 32)
        XCTAssertEqual(layout.rtEdge, 368)
        XCTAssertEqual(layout.cx, 200)
        XCTAssertEqual(MeasurementDiagramScene.widthGroups(layout.elements).map(\.label), ["4'", "LT 12'", "RT 12'", "4'"])
    }

    func testADividedHighwayGroupsItsLanesAndNamesTheMedian() {
        let snapshot: [String: JSONValue] = ["left_lanes": .number(2), "right_lanes": .number(2), "median_type": .string("R"),
                                             "median_width": .number(22), "route_name": .string("17"),
                                             "county_code": .string("SCL"), "begin_pm": .number(5), "end_pm": .number(6.25)]
        let diagram = data(snapshot: snapshot)
        let layout = MeasurementDiagramScene.Layout(diagram.crossSection, width: 600)
        XCTAssertEqual(MeasurementDiagramScene.widthGroups(layout.elements).map(\.label),
                       ["8'", "LT 2×12'", "4'", "MDN 22'", "4'", "RT 2×12'", "8'"])
        let scene = MeasurementDiagramScene(diagram, width: 600)
        XCTAssertEqual(scene.header, "SR 17  |  SCL  |  PM 5–6.25")
        XCTAssertTrue(texts(scene).contains("ROAD INVENTORY"))
    }

    func testANarrowScreenStillGetsTwoHundredPoints() {
        XCTAssertEqual(MeasurementDiagramScene(data(), width: 120).width, 200)
        XCTAssertEqual(MeasurementDiagramScene(data(), width: 120).header, "Road Cross-Section")
    }

    func testAThroughRoadSlideIsDimensionedAcrossTheRoad() {
        let scene = MeasurementDiagramScene(data(["measure_roadway_width_ft": "24", "measure_landslide_length_ft": "60"]),
                                            width: 400)
        let words = texts(scene)
        XCTAssertTrue(words.contains("W-M"))
        XCTAssertTrue(words.contains("R&S 24'"))
        XCTAssertTrue(words.contains("TLS: 60' (along slope)"))
        XCTAssertTrue(words.contains("FROM FORM"))
    }

    func testASlideAboveTheRoadIsDrawnOnEachChosenSide() {
        let values = ["measure_slope_height_ft": "40", "measure_original_slope_deg": "35.5",
                      "measure_main_scarp_height_ft": "6"]
        let one = texts(MeasurementDiagramScene(data(values, template: .aboveRoad, side: .rt), width: 400))
        XCTAssertEqual(one.filter { $0 == "H-S 40'" }.count, 1)
        XCTAssertTrue(one.contains("Φ-OS 35.5°"))
        XCTAssertTrue(one.contains("H-HS 6'"))
        let both = texts(MeasurementDiagramScene(data(values, template: .aboveRoad, side: .both), width: 400))
        XCTAssertEqual(both.filter { $0 == "H-S 40'" }.count, 2)
    }

    func testAZeroMeasurementIsDrawnAsNotGiven() {
        let words = texts(MeasurementDiagramScene(data(["measure_slope_height_ft": "0"], template: .belowRoad), width: 400))
        XCTAssertTrue(words.contains("H-S"))
        XCTAssertTrue(words.contains("Φ-SS"))
    }

    func testTheGroundFollowsTheTerrainShape() {
        let layout = MeasurementDiagramScene.Layout(data().crossSection, width: 400)
        let crown = MeasurementDiagramScene.sides(.crown, layout)
        XCTAssertEqual(crown.map(\.surface.0.y), [8, 88])
        XCTAssertEqual(crown.map(\.surface.1.y), [88, 8])
        let bowl = MeasurementDiagramScene.sides(.bowl, layout)
        XCTAssertEqual(bowl[0].surface.1, .init(32, 148))
        XCTAssertEqual(bowl[0].surface.0.y, 148 + (254 - 148) * 0.65, accuracy: 1e-9)
    }

    func testTheNoteSaysWhatTheDiagramWasDrawnFrom() throws {
        XCTAssertEqual(MeasurementDiagramData.note(source: .standard, template: nil, terrain: nil, profile: nil),
                       "Road: Default  ·  Template: auto · pending GEO  ·  Terrain: auto · no elevation profile  ·  Elevation: not fetched")
        let unknown = try XCTUnwrap(ElevationProfile(gisa: ["elevation_profile": .object([
            "classification": .string("UNKNOWN"), "source": .string("USGS_3DEP_EPQS")])]))
        XCTAssertEqual(MeasurementDiagramData.note(source: .roadInventory, template: .belowRoad, terrain: nil, profile: unknown),
                       "Road: Road inventory  ·  Template: below road  ·  Terrain: auto · elevation unknown  ·  Elevation: USGS_3DEP_EPQS")
        let failed = try XCTUnwrap(ElevationProfile(gisa: ["elevation_profile": .object([
            "classification": .string("BOWL"), "error": .string("timeout")])]))
        XCTAssertEqual(MeasurementDiagramData.note(source: .formFields, template: nil, terrain: .crown, profile: failed),
                       "Road: Form fields  ·  Template: auto · pending GEO  ·  Terrain: manual · crown  ·  Elevation: error · USGS")
        XCTAssertEqual(MeasurementDiagramData.note(source: .formFields, template: nil, terrain: nil, profile: failed)
            .contains("auto · USGS (BOWL)"), true)
    }
}
