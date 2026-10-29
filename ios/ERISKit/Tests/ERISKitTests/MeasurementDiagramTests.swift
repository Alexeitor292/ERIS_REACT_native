import XCTest
@testable import ERISKit

/// The measurement diagram's model against the Expo app's own output
/// (Fixtures/measurement-diagram.json, written by
/// ios/scripts/make-parity-fixtures.mjs). The road cross-section cases are
/// mobile/src/measurements/__fixtures__/roadCrossSectionParity.json, which the
/// backend's road_cross_section_build.py is held to as well.
final class MeasurementDiagramTests: XCTestCase {
    private func fixture() throws -> [String: JSONValue] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "measurement-diagram", withExtension: "json",
                                                  subdirectory: "Fixtures"))
        return try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: url))
    }

    private func cases(_ key: String) throws -> [[String: JSONValue]] {
        guard case .array(let items)? = try fixture()[key] else { throw XCTSkip("no \(key)") }
        return items.compactMap { if case .object(let item) = $0 { return item } else { return nil } }
    }

    private func object(_ value: JSONValue?) -> [String: JSONValue]? {
        if case .object(let object)? = value { return object } else { return nil }
    }

    private func form(_ value: JSONValue?) -> GisaForm {
        var form = GisaForm()
        for (key, value) in object(value) ?? [:] { form[key] = JS.string(value) }
        return form
    }

    /// The section as the TypeScript returns it: keys it leaves undefined are absent.
    private func json(_ s: RoadCrossSection) -> [String: JSONValue] {
        var out: [String: JSONValue] = [
            "lt_lane_count": .number(Double(s.ltLaneCount)), "rt_lane_count": .number(Double(s.rtLaneCount)),
            "lt_lane_width_ft": .number(s.ltLaneWidthFt), "rt_lane_width_ft": .number(s.rtLaneWidthFt),
            "lt_outside_shoulder_ft": .number(s.ltOutsideShoulderFt), "lt_inside_shoulder_ft": .number(s.ltInsideShoulderFt),
            "rt_inside_shoulder_ft": .number(s.rtInsideShoulderFt), "rt_outside_shoulder_ft": .number(s.rtOutsideShoulderFt),
            "median_width_ft": .number(s.medianWidthFt), "median_category": .string(s.medianCategory.rawValue),
            "total_width_ft": .number(s.totalWidthFt), "source": .string(s.source.rawValue),
        ]
        if let segment = s.segment {
            func put(_ key: String, _ value: Double?) { if let value { out[key] = .number(value) } }
            put("begin_pm", segment.beginPm)
            put("end_pm", segment.endPm)
            put("length_miles", segment.lengthMiles)
            if let route = segment.routeName { out["route_name"] = .string(route) }
            if let county = segment.countyCode { out["county_code"] = .string(county) }
            out["terrain_code"] = segment.terrainCode.map(JSONValue.string) ?? .null
            out["design_speed"] = segment.designSpeed.map(JSONValue.number) ?? .null
            out["adt"] = segment.adt.map(JSONValue.number) ?? .null
            out["landmark"] = segment.landmark.map(JSONValue.string) ?? .null
        }
        return out
    }

    func testTheRoadIsBuiltAsTheAppAndServerBuildIt() throws {
        let sections = try cases("roadSections")
        XCTAssertGreaterThan(sections.count, 5)
        for section in sections {
            let fallback: Double? = if case .number(let n)? = section["fallback"] { n } else { nil }
            let built = RoadCrossSection(snapshot: object(section["snapshot"]), fallbackRoadwayWidth: fallback)
            XCTAssertEqual(json(built), object(section["expected"]), JS.string(section["name"]))
        }
    }

    func testTheGroundLooksAsTheFormDescribesIt() throws {
        for item in try cases("terrain") {
            let appearance = TerrainAppearance(form: form(item["form"]))
            let a = try XCTUnwrap(object(item["appearance"]))
            let numbers: [(String, Double)] = [
                ("moistureLevel", appearance.moistureLevel), ("vegetationDensity", appearance.vegetationDensity),
                ("rockiness", appearance.rockiness), ("soilPct", appearance.soilPct), ("rockPct", appearance.rockPct),
                ("clayPct", appearance.clayPct), ("siltPct", appearance.siltPct), ("sandPct", appearance.sandPct),
                ("gravelPct", appearance.gravelPct), ("boulderPct", appearance.boulderPct), ("treesPct", appearance.treesPct),
                ("shrubsPct", appearance.shrubsPct), ("groundcoverPct", appearance.groundcoverPct),
            ]
            for (key, value) in numbers {
                guard case .number(let expected)? = a[key] else { return XCTFail(key) }
                XCTAssertEqual(value, expected, accuracy: 1e-12, "\(key) for \(item["form"]!)")
            }
            XCTAssertEqual(appearance.dominantMaterial.rawValue, JS.string(a["dominantMaterial"]))
            XCTAssertEqual(appearance.moisture.rawValue, JS.string(a["moisture"]))
            XCTAssertEqual(appearance.pavementType.map(JSONValue.string) ?? .null, a["pavementType"])
            let flags = [("seep", appearance.seep), ("spring", appearance.spring), ("bedding", appearance.bedding),
                         ("joints", appearance.joints), ("fractures", appearance.fractures)]
            for (key, value) in flags { XCTAssertEqual(.bool(value), a[key], key) }

            let palette = TerrainPalette(appearance)
            let colours = [
                ("skyTop", palette.skyTop), ("skyBottom", palette.skyBottom), ("top", palette.top), ("mid", palette.mid),
                ("deep", palette.deep), ("texture", palette.texture), ("crack", palette.crack),
                ("moisture", palette.moisture), ("vegetation", palette.vegetation),
                ("vegetationDark", palette.vegetationDark), ("stone", palette.stone), ("stoneShade", palette.stoneShade),
                ("road", palette.road), ("roadEdge", palette.roadEdge), ("shoulder", palette.shoulder),
                ("shoulderEdge", palette.shoulderEdge),
            ]
            let p = try XCTUnwrap(object(item["palette"]))
            for (key, value) in colours { XCTAssertEqual(.string(value), p[key], key) }
        }
    }

    func testTheDiagramReadsTheMeasurementsAndPicksItsShape() throws {
        for item in try cases("diagrams") {
            let input = try XCTUnwrap(object(item["input"]))
            let output = try XCTUnwrap(object(item["output"]))
            let template = DiagramTemplate(rawValue: JS.string(input["template"]))
            let profile = object(input["profile"]).flatMap { ElevationProfile(gisa: ["elevation_profile": .object($0)]) }
            let data = MeasurementDiagramData(
                form: form(input["form"]), snapshot: object(input["snapshot"]), template: template,
                failureSide: try XCTUnwrap(FailureSide(rawValue: JS.string(input["failureSide"]))),
                terrainShape: TerrainShape(rawValue: JS.string(input["terrain"])), profile: profile)
            XCTAssertEqual(data.template.rawValue, JS.string(output["template"]))
            XCTAssertEqual(data.failureSide.rawValue, JS.string(output["failureSide"]))
            XCTAssertEqual(data.terrainShape.rawValue, JS.string(output["terrainShape"]))
            XCTAssertEqual(json(data.crossSection), object(output["crossSection"]))
            let m = data.measurements
            let measured: [(String, Double?)] = [
                ("slopeHeight_ft", m.slopeHeightFt), ("originalSlopeDeg", m.originalSlopeDeg),
                ("landslideWidth_ft", m.landslideWidthFt), ("landslideLength_ft", m.landslideLengthFt),
                ("mainScarpHeight_ft", m.mainScarpHeightFt), ("landslideSlopeDeg", m.landslideSlopeDeg),
                ("roadwayLength_ft", m.roadwayLengthFt), ("roadwayWidth_ft", m.roadwayWidthFt),
            ]
            let expected = try XCTUnwrap(object(output["measurements"]))
            for (key, value) in measured { XCTAssertEqual(value.map(JSONValue.number) ?? .null, expected[key], key) }
        }
    }
}
