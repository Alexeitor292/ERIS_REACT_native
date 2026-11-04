import XCTest
@testable import ERISKit

/// Held to the numbers the website's siteTerrainModel.ts gives for the same slope.
final class SiteMeasuringTests: XCTestCase {
    private let lon = -121.433, lat = 35.866
    private var ring: [SiteTerrain.Spot] {
        [(-0.0016, 0.0026), (0.0016, 0.0026), (0.0018, -0.0022), (-0.0018, -0.0022), (-0.0016, 0.0026)]
            .map { SiteTerrain.Spot(lon: lon + $0.0, lat: lat + $0.1) }
    }
    private var area: SiteAreas.Area { [ring.map { [$0.lon, $0.lat] }] }

    private func before(_ s: SiteTerrain.Spot) -> Double {
        let (x, y) = ((s.lon - lon) / 0.004, (s.lat - lat) / 0.004)
        return 300 + 240 * y + 12 * sin(x * 4) + 6 * cos(y * 9)
    }

    private func after(_ s: SiteTerrain.Spot) -> Double {
        let (x, y) = ((s.lon - lon) / 0.004, (s.lat - lat) / 0.004)
        var z = before(s)
        if abs(x) < 0.45 {
            if y < 0.5, y > 0 { z -= 30 * min(1, (0.5 - y) / 0.1) * (y / 0.5 + 0.15) }
            if y <= 0, y > -0.5 { z += 24 * sin(-y / 0.5 * .pi) }
        }
        return z
    }

    private struct Formula: ElevationSampling {
        let f: @Sendable (SiteTerrain.Spot) -> Double
        var sourceName: String { "Formula" }
        func heights(at spots: [SiteTerrain.Spot]) async throws -> [Double?] { spots.map(f) }
    }

    func testTheSamePointsAreSampledAsOnTheWebsite() {
        let plan = SiteTerrain.samplePlan([ring])
        XCTAssertEqual(plan.inside.count, 598)
        XCTAssertEqual(plan.around.count, 420)
        XCTAssertEqual(plan.spacingM, 16.469375230743434, accuracy: 1e-9)
        XCTAssertEqual(plan.bufferM, 60)
    }

    func testAMeasurementMatchesTheWebsite() throws {
        let plan = SiteTerrain.samplePlan([ring])
        let inside = plan.inside.map { SiteTerrain.Sample(spot: $0, z: before($0)) }
        let around = plan.around.map { SiteTerrain.Sample(spot: $0, z: before($0)) }
        let m = try XCTUnwrap(SiteTerrain.measure([ring], inside: inside, around: around))
        XCTAssertEqual(m.landslideSlopeDeg, 29.04525689583681, accuracy: 1e-6)
        XCTAssertEqual(try XCTUnwrap(m.originalSlopeDeg), 28.701945900000606, accuracy: 1e-6)
        XCTAssertEqual(m.downslopeBearingDeg, 190.14035281916878, accuracy: 1e-6)
        XCTAssertEqual(m.horizontalLengthM, 576.3053262835442, accuracy: 1e-6)
        XCTAssertEqual(m.slopeLengthM, 659.2098723216824, accuracy: 1e-6)
        XCTAssertEqual(m.widthM, 395.34679734406086, accuracy: 1e-6)
        XCTAssertEqual(m.slopeHeightM, 342.7452685652692, accuracy: 1e-6)
        XCTAssertEqual(SiteTerrain.fieldValues(m), [
            "measure_slope_height_ft": "1124", "measure_landslide_width_ft": "1297", "measure_landslide_length_ft": "2163",
            "measure_landslide_slope_deg": "29.0", "measure_original_slope_deg": "28.7",
        ])
    }

    func testAComparisonMatchesTheWebsite() throws {
        let plan = SiteTerrain.samplePlan([ring])
        let all = plan.inside + plan.around
        let c = try XCTUnwrap(SiteTerrain.compare([ring], plan: plan, before: all.map(before), now: all.map(after)))
        XCTAssertEqual(c.updated.landslideSlopeDeg, 26.075698341789714, accuracy: 1e-6)
        XCTAssertEqual(c.updated.slopeLengthM, 647.0345853194439, accuracy: 1e-6)
        XCTAssertEqual(c.coverage, 1)
        XCTAssertEqual(c.maxLossM, 28.16888208221951, accuracy: 1e-6)
        XCTAssertEqual(c.maxGainM, 23.93982110849572, accuracy: 1e-6)
        XCTAssertEqual(c.meanChangeM, 0.16165261775810286, accuracy: 1e-6)
        XCTAssertEqual(c.lossVolumeM3, 1063484.8162991859, accuracy: 1e-3)
        XCTAssertEqual(c.gainVolumeM3, 1089705.147592843, accuracy: 1e-3)
        XCTAssertEqual(c.netVolumeM3, 26220.33129365719, accuracy: 1e-3)
        XCTAssertEqual(SiteTerrain.fieldValues(c), [
            "measure_slope_height_ft": "1124", "measure_original_slope_deg": "29.0", "measure_landslide_slope_deg": "26.1",
            "measure_landslide_length_ft": "2123", "measure_landslide_width_ft": "1334",
        ])
    }

    func testTheSectionAndScarpMatchTheWebsite() throws {
        let plan = SiteTerrain.samplePlan([ring])
        let all = plan.inside + plan.around
        let c = try XCTUnwrap(SiteTerrain.compare([ring], plan: plan, before: all.map(before), now: all.map(after)))
        let line = SiteTerrain.profileLine([ring], bearingDeg: c.original.downslopeBearingDeg, marginM: max(10, plan.bufferM))
        XCTAssertEqual(line.top.lon, -121.43232363849025, accuracy: 1e-9)
        XCTAssertEqual(line.bottom.lat, 35.86308549133411, accuracy: 1e-9)
        let section = SiteTerrain.spots(from: line.top, to: line.bottom, count: 90).map {
            SiteTerrain.SectionSpot(distanceM: $0.distanceM, spot: $0.spot, before: before($0.spot), now: after($0.spot))
        }
        let scarp = try XCTUnwrap(SiteTerrain.scarpSuggestion([ring], section: section))
        XCTAssertEqual(scarp.heightM, 27.698617509805615, accuracy: 1e-6)
    }

    func testNoScarpWithoutARealDropOrFromTheSea() {
        let inside = SiteTerrain.spots(from: SiteTerrain.Spot(lon: lon, lat: lat + 0.002), to: SiteTerrain.Spot(lon: lon, lat: lat - 0.002), count: 12)
        func section(_ now: Double?, sea: Bool = false) -> [SiteTerrain.SectionSpot] {
            inside.map { SiteTerrain.SectionSpot(distanceM: $0.distanceM, spot: $0.spot, before: 100, beforeIsSea: sea, now: now) }
        }
        XCTAssertNil(SiteTerrain.scarpSuggestion([ring], section: section(99.9)), "within the noise")
        XCTAssertNil(SiteTerrain.scarpSuggestion([ring], section: section(90, sea: true)), "water is not a crown")
        XCTAssertNil(SiteTerrain.scarpSuggestion([ring], section: section(nil)), "no survey there")
        XCTAssertNil(SiteTerrain.scarpSuggestion([ring], section: Array(section(90).prefix(2))), "too few spots to tell")
    }

    // MARK: The elevation patch

    private func grid(_ f: (SiteTerrain.Spot) -> Double) -> DroneGrid {
        let (cols, rows) = (240, 240)
        let (west, east, south, north) = (lon - 0.004, lon + 0.004, lat - 0.004, lat + 0.004)
        var values = [Float](repeating: 0, count: cols * rows)
        for r in 0..<rows {
            for c in 0..<cols {
                let spot = SiteTerrain.Spot(lon: west + (Double(c) + 0.5) / Double(cols) * (east - west),
                                            lat: north - (Double(r) + 0.5) / Double(rows) * (north - south))
                values[r * cols + c] = Float(f(spot))
            }
        }
        return DroneGrid(west: west, south: south, east: east, north: north, cols: cols, rows: rows, values: values)
    }

    func testAPatchRoundTripsAndADamagedOneIsRefused() throws {
        var g = grid(before)
        g.values[5] = .nan
        let decoded = try DroneGrid(patch: g.patch())
        XCTAssertEqual(decoded.cols, 240)
        XCTAssertEqual(decoded.values[6], g.values[6])
        XCTAssertTrue(decoded.values[5].isNaN)
        XCTAssertThrowsError(try DroneGrid(patch: Data("not a patch".utf8)))
        XCTAssertThrowsError(try DroneGrid(patch: g.patch().dropLast(4)))
    }

    func testAWebsitePatchIsRead() throws {
        // As the website's encodeGrid writes one: 2 by 1, header padded with spaces.
        let json = #"{"west":-122,"south":37,"east":-121,"north":38,"cols":2,"rows":1}"#
        var header = Data(json.utf8)
        while (12 + header.count) % 4 != 0 { header.append(0x20) }
        var data = Data("ERISDSM1".utf8)
        withUnsafeBytes(of: UInt32(header.count).littleEndian) { data.append(contentsOf: $0) }
        data.append(header)
        for value: Float in [10, 20] { withUnsafeBytes(of: value.bitPattern.littleEndian) { data.append(contentsOf: $0) } }
        let g = try DroneGrid(patch: data)
        XCTAssertEqual(g.values, [10, 20])
        XCTAssertEqual(g.west, -122)
    }

    func testHeightsAreReadBetweenCells() {
        let g = DroneGrid(west: 0, south: 0, east: 2, north: 1, cols: 2, rows: 1, values: [10, 20])
        XCTAssertEqual(g.height(at: .init(lon: 1, lat: 0.5)), 15)
        XCTAssertEqual(g.height(at: .init(lon: 0.5, lat: 0.5)), 10)
        XCTAssertNil(g.height(at: .init(lon: 3, lat: 0.5)), "outside")
        let hole = DroneGrid(west: 0, south: 0, east: 2, north: 1, cols: 2, rows: 1, values: [10, .nan])
        XCTAssertNil(hole.height(at: .init(lon: 1.5, lat: 0.5)), "over a hole")
    }

    func testAGapAtTheShoreIsSeaAndAnInlandHoleIsNot() {
        let shore = DroneGrid(west: 0, south: 0, east: 3, north: 1, cols: 3, rows: 1, values: [.nan, 2, 2])
        XCTAssertEqual(shore.seaFilled(offsetM: 0).values[0], 0)
        let inland = DroneGrid(west: 0, south: 0, east: 3, north: 1, cols: 3, rows: 1, values: [.nan, 200, 200])
        XCTAssertTrue(inland.seaFilled(offsetM: 0).values[0].isNaN)
    }

    // MARK: A whole measurement

    func testWithoutASurveyTheTerrainSuggestsAndThereIsNoScarp() async throws {
        let result = try await SiteMeasureResult.measure(area: area, terrain: Formula(f: before), now: nil, before: nil)
        XCTAssertNil(result.drone)
        XCTAssertNil(result.scarp, "only a drone survey can suggest Hs")
        XCTAssertEqual(result.suggestions["measure_landslide_length_ft"], "2163")
        XCTAssertNil(result.suggestions["measure_main_scarp_height_ft"], "not a value to fill with the rest")
        XCTAssertEqual(result.from("measure_slope_height_ft"), "Formula")
        XCTAssertEqual(result.section.count, 90)
        XCTAssertTrue(result.section.allSatisfy { $0.now == nil && $0.before != nil })
    }

    private func survey(_ id: Int, _ label: String, _ date: String, offset: Double = 0) -> DroneSurvey {
        DroneSurvey(id: id, label: label, dsmFilename: nil, capturedOn: date, source: nil, verticalOffsetM: offset, compareWithSurveyId: nil)
    }

    func testTwoSurveysSuggestFromEachGroundAndSuggestTheScarp() async throws {
        let now = SurveyGround(survey: survey(2, "Post", "2017-05-27"), grid: grid(after))
        let earlier = SurveyGround(survey: survey(1, "Pre", "2017-05-19"), grid: grid(before))
        let result = try await SiteMeasureResult.measure(area: area, terrain: Formula { _ in 0 }, now: now, before: earlier)
        let drone = try XCTUnwrap(result.drone)
        XCTAssertEqual(drone.comparison.coverage, 1)
        XCTAssertEqual(result.from("measure_slope_height_ft"), "Before: Pre, 2017-05-19")
        XCTAssertEqual(result.from("measure_landslide_length_ft"), "Now: Post, 2017-05-27")
        XCTAssertNotNil(result.scarp)
        XCTAssertNil(result.suggestions["measure_main_scarp_height_ft"], "kept out of the values used together")
        XCTAssertTrue(result.section.contains { ($0.changeM ?? 0) < -1 })
    }

    func testASurveyCoveringTooLittleFallsBackToTheTerrain() async throws {
        let tiny = DroneGrid(west: lon + 0.0015, south: lat - 0.0003, east: lon + 0.0025, north: lat + 0.0003, cols: 4, rows: 4,
                             values: [Float](repeating: 5, count: 16))
        let result = try await SiteMeasureResult.measure(area: area, terrain: Formula(f: before),
                                                         now: SurveyGround(survey: survey(2, "Post", "2017-05-27"), grid: tiny), before: nil)
        XCTAssertNil(result.drone)
        XCTAssertLessThan(try XCTUnwrap(result.droneCoverage), 0.5)
        XCTAssertEqual(result.suggestions["measure_landslide_length_ft"], "2163")
    }

    func testNoDataUnderTheAreaIsSaid() async {
        struct Nothing: ElevationSampling {
            var sourceName: String { "Nothing" }
            func heights(at spots: [SiteTerrain.Spot]) async throws -> [Double?] { spots.map { _ in nil } }
        }
        do {
            _ = try await SiteMeasureResult.measure(area: area, terrain: Nothing(), now: nil, before: nil)
            XCTFail("should refuse")
        } catch {
            XCTAssertEqual((error as? SiteMeasureResult.Problem)?.message, "The terrain model has no usable data under this area.")
        }
    }

    // MARK: Entering them

    func testTheFieldsAreTheFormsEight() {
        XCTAssertEqual(GisaEditor.measurementFields.count, 8)
        XCTAssertEqual(GisaEditor.measurementGroups.map(\.title), ["Slope", "Landslide", "Roadway encroached"])
        XCTAssertEqual(GisaEditor.measurementField(after: "measure_slope_height_ft"), "measure_original_slope_deg")
        XCTAssertNil(GisaEditor.measurementField(after: "measure_roadway_width_ft"))
    }

    func testAnAngleGoesBetweenTheSliderAndTheField() {
        XCTAssertNil(GisaEditor.measurementAngle(""))
        XCTAssertNil(GisaEditor.measurementAngle("steep"))
        XCTAssertEqual(GisaEditor.measurementAngle("27.3"), 27.3)
        XCTAssertEqual(GisaEditor.measurementAngle("120"), 90, "a slider stops at 90")
        XCTAssertEqual(GisaEditor.measurementAngleText(27.5), "27.5")
        XCTAssertEqual(GisaEditor.measurementAngleText(28), "28")
    }

    // MARK: With no signal

    func testTheTerrainKeptOnTheIPhoneIsRead() async throws {
        let t = TerrainBundle.TerrainMeta(
            file: "", rows: 2, columns: 2, encoding: "float32", byteOrder: "little", noDataValue: -9999,
            minElevationM: 0, maxElevationM: 30, verticalUnits: "m",
            bounds: TerrainBundle.Bounds(minLat: 0, minLon: 0, maxLat: 1, maxLon: 1),
            localTransform: TerrainBundle.LocalTransform(originLon: 0, originLat: 1, lonPerCol: 1, latPerRow: -1), sha256: nil)
        let kept = PackagedElevation(meta: t, grid: [0, 10, 20, 30])
        let heights = try await kept.heights(at: [.init(lon: 0.5, lat: 0.5), .init(lon: 5, lat: 5)])
        XCTAssertEqual(heights[0], 15)
        XCTAssertNil(heights[1], "outside the package")
        let holed = PackagedElevation(meta: t, grid: [-9999, 10, 20, 30])
        let hole = try await holed.heights(at: [.init(lon: 0.5, lat: 0.5)])
        XCTAssertNil(hole[0], "over no data")
    }

    func testSurveysReadOnceAreThereWithNoSignal() async throws {
        let store = OfflineStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("eris-drone-\(UUID().uuidString)"))
        defer { store.wipe() }
        let patch = DroneGrid(west: 0, south: 0, east: 1, north: 1, cols: 1, rows: 1, values: [42]).patch()
        let list = #"{"items": [{"id": 2, "label": "Post", "dsm_filename": null, "captured_on": "2017-05-27", "source": null, "vertical_offset_m": 1.5, "compare_with_survey_id": 1}]}"#
        final class Online: @unchecked Sendable { var on = true }
        let online = Online()
        let api = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"),
                            transport: SurveyServer(online: { online.on }, list: Data(list.utf8), patch: patch))
        let surveys = DroneSurveysAPI(api: api, store: store)
        let first = try await surveys.list(501)
        XCTAssertEqual(first.first?.title, "Post, 2017-05-27")
        XCTAssertEqual(first.first?.verticalOffsetM, 1.5)
        XCTAssertEqual(first.first?.compareWithSurveyId, 1)
        let grid = try await surveys.grid(501, survey: 2)
        XCTAssertEqual(grid.values, [42])

        online.on = false
        let kept = try await surveys.list(501)
        XCTAssertEqual(kept, first)
        let keptGrid = try await surveys.grid(501, survey: 2)
        XCTAssertEqual(keptGrid.values, [42])
        do {
            _ = try await surveys.grid(501, survey: 9)
            XCTFail("never read, so not kept")
        } catch let error as APIError {
            XCTAssertTrue(error.isUnreachable)
        }
    }
}

private struct SurveyServer: HTTPTransport {
    let online: @Sendable () -> Bool
    let list: Data
    let patch: Data

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard online() else { throw APIError.transport("offline") }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (request.url!.path.hasSuffix("/patch") ? patch : list, response)
    }
}
