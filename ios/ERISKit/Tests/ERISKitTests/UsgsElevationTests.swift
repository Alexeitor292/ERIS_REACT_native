import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A tile as USGS sends it: 17 x 17 heights near Hayward. The website's test reads this same one.
private let realTile = "Q250WkltYWdlIAsAAAAIAAAAEQAAABEAAABhMlUwKqkTPwAAAAAAAAAAAAAAAAAAgD8BAAAAAQAAAJMCAACNkI5DAXD/dUNSIQGOB6MmOhBzwUHxBxfYa/ChUgNaGw9gTkABAACwkN6A1jsplFWOzrwUojQI4wVUH+90J3H6EQ5aPNNwbQMJdDAgwK2B1o4OAEunRFUIElneBEx4PUsYyJLw0hwHk2/BWMYT0FVk4XAE4wI2vAW0AbEHfq31QNQLV+4MeuQNfzYL/pLCtYsg7JCokVVHzlBogLd5BLsWMvy7YFrRcha5EGZxjU8cYABU8FEwj9+A4s5KrHqk2IjeyFEnX+jwcWHiD8lt0mf3EmgTxkk1c1dEazI1Y+mOiwXR1Fk4jYI1t1QYw0boJc8WtjnUToRFQ8SGFl5X7YSlZGtTmJH9BE0TEHI+9/APlMzTOfp2U2KtcKJJsow4i2VuSOydhYxYkXk3nXJZksNIMcW09FF/Sotw+WOco7sAyjIaRCyIXlf65oIeL2+BWcfPVKpWZ/FftZW2WsJRO4X5eECmLuPrdbKibcA+qI0kOWnQBSWel7ZnjX3kZRpgaNgxcNbGLVh4hHHdQFO70ycPicVqQOsjlqKYmxt6r9l8Zp1DclYllZfax2/g1rPly5nS5oovK+Bw/QSBXi3eX/aOz71RJ2D9efXecph+6YUCIG43KaDsXawR7NJ2s1TdUpITJb+l9vVYOGFJf88eE5nSZpcAWPt4WWV6cRhWfgV9e4Y2LxUoarS6LaqDeWOUh6n2WukeRKbogFG6FCqVa33eT0OiBi+XN7e97hrQa2aTCqXukm0mzYkzh7EEnKGbAW6vU9k+mYIp2Q37z3kb9L/nqx65ayfln9w+RkqlIrsuur3syvHJ2DKPi14wKxygVnUPujz99loUPapLri829LpyrsNQ4rs9O/TfGYFvPey2xL8rgz8Awr4AAAA="

/// The iPhone reads the same USGS tiles as the website, the same way, so it gets the same heights.
final class UsgsElevationTests: XCTestCase {
    func testARealTileIsRead() throws {
        let tile = try ElevationTile(data: try XCTUnwrap(Data(base64Encoded: realTile)))
        XCTAssertEqual(tile.width, 17)
        XCTAssertEqual(tile.height, 17)
        // USGS's uncompressed answer to the same request.
        XCTAssertEqual(Double(tile.values[0]), 251.9324, accuracy: 0.001)
        XCTAssertEqual(Double(tile.values[8 * 17 + 8]), 259.3095, accuracy: 0.001)
        XCTAssertEqual(Double(tile.values[288]), 275.2982, accuracy: 0.001)
        XCTAssertEqual(tile.values.map(Double.init).reduce(0, +), 75892.456, accuracy: 0.05)
    }

    func testAPlaceIsReadFromTheSameTileAtTheSameHeightAsOnTheWebsite() async throws {
        final class Asked: @unchecked Sendable {
            let lock = NSLock()
            var tiles = [String]()
        }
        let asked = Asked()
        let data = try XCTUnwrap(Data(base64Encoded: realTile))
        let elevation = UsgsElevation { row, col in
            asked.lock.lock()
            asked.tiles.append("\(row)/\(col)")
            asked.lock.unlock()
            return data
        }
        let heights = try await elevation.heights(at: [SiteTerrain.Spot(lon: -122.08, lat: 37.67)])
        XCTAssertEqual(asked.tiles, ["50710/21088"])
        // elevationTile.test.ts expects this same height.
        XCTAssertEqual(try XCTUnwrap(heights[0]), 268.28704101514217, accuracy: 0.0001)
    }

    private func header(height: Int = 2, width: Int = 2, maxError: Double = 0) -> Data {
        var d = Data("CntZImage ".utf8)
        for value: Int32 in [11, 8, Int32(height), Int32(width)] { withUnsafeBytes(of: value.littleEndian) { d.append(contentsOf: $0) } }
        withUnsafeBytes(of: maxError.bitPattern.littleEndian) { d.append(contentsOf: $0) }
        return d
    }

    private func part(_ y: Int32, _ x: Int32, _ bytes: Int32, _ maximum: Float) -> Data {
        var d = Data()
        for value in [y, x, bytes] { withUnsafeBytes(of: value.littleEndian) { d.append(contentsOf: $0) } }
        withUnsafeBytes(of: maximum.bitPattern.littleEndian) { d.append(contentsOf: $0) }
        return d
    }

    func testATileWithNoDataIsAllHoles() throws {
        let tile = try ElevationTile(data: header() + part(0, 0, 0, 0) + part(1, 1, 1, 0) + Data([2]))
        XCTAssertTrue(tile.values.allSatisfy(\.isNaN))
    }

    func testAFlatTileIsOneHeight() throws {
        let tile = try ElevationTile(data: header() + part(0, 0, 0, 1) + part(0, 0, 0, 7.5))
        XCTAssertEqual(tile.values, [7.5, 7.5, 7.5, 7.5])
    }

    func testEachKindOfBlockIsRead() throws {
        // One block, stuffed: offset 10 as a 16-bit whole number, four 8-bit values, in steps of 0.5.
        let stuffed = header(maxError: 0.25) + part(0, 0, 0, 1) + part(1, 1, 12, 100)
            + Data([0b0100_0001, 10, 0, 0b1000_1000, 4]) + Data([3, 2, 1, 0])
        XCTAssertEqual(try ElevationTile(data: stuffed).values, [10, 10.5, 11, 11.5])

        let constant = header() + part(0, 0, 0, 1) + part(1, 1, 3, 100) + Data([0b0100_0011, 42, 0])
        XCTAssertEqual(try ElevationTile(data: constant).values, [42, 42, 42, 42])

        let zero = header() + part(0, 0, 0, 1) + part(1, 1, 1, 100) + Data([2])
        XCTAssertEqual(try ElevationTile(data: zero).values, [0, 0, 0, 0])

        var plain = Data([0])
        for value: Float in [1, 2, 3, 4] { withUnsafeBytes(of: value.bitPattern.littleEndian) { plain.append(contentsOf: $0) } }
        let raw = header() + part(0, 0, 0, 1) + part(1, 1, 17, 100) + plain
        XCTAssertEqual(try ElevationTile(data: raw).values, [1, 2, 3, 4])
    }

    func testAnythingElseIsRefused() {
        XCTAssertThrowsError(try ElevationTile(data: Data("{\"error\": 404}".utf8)))
        XCTAssertThrowsError(try ElevationTile(data: header()), "cut short")
    }

    func testHeightsAreReadBetweenPosts() {
        let tile = ElevationTile(width: 2, height: 2, values: [0, 10, 20, 30])
        XCTAssertEqual(tile.height(atX: 0, y: 0), 0)
        XCTAssertEqual(tile.height(atX: 1, y: 1), 30)
        XCTAssertEqual(tile.height(atX: 0.5, y: 0.5), 15)
        XCTAssertNil(ElevationTile(width: 2, height: 2, values: [.nan, 10, 20, 30]).height(atX: 0.5, y: 0.5))
    }

    func testNoDataIsOnlyMissingWhereItIsMissing() async throws {
        let flat = header() + part(0, 0, 0, 1) + part(0, 0, 0, 7.5)
        let inland = SiteTerrain.Spot(lon: -121.433, lat: 35.866), farAway = SiteTerrain.Spot(lon: -120, lat: 37)
        // Only the tile under the first spot has data.
        let inlandCol = Int(((UsgsElevation.mercator(inland).x - UsgsElevation.originX)
            / UsgsElevation.tileSizeM).rounded(.down))
        let elevation = UsgsElevation { _, col in col == inlandCol ? flat : nil }
        let heights = try await elevation.heights(at: [inland, farAway])
        XCTAssertEqual(heights, [7.5, nil])
    }

    func testAFailedFetchIsNotTakenForNoData() async {
        struct Offline: Error {}
        do {
            _ = try await UsgsElevation { _, _ in throw Offline() }.heights(at: [SiteTerrain.Spot(lon: -121, lat: 35)])
            XCTFail("should throw, so the iPhone falls back to the terrain package")
        } catch {
            XCTAssertTrue(error is Offline)
        }
    }

    func testTheTilesKeptCoverTheAreaAndTheSection() {
        let ring = [(-0.0016, 0.0026), (0.0016, 0.0026), (0.0018, -0.0022), (-0.0018, -0.0022), (-0.0016, 0.0026)]
            .map { SiteTerrain.Spot(lon: -121.433 + $0.0, lat: 35.866 + $0.1) }
        let plan = SiteTerrain.samplePlan([ring])
        let spots = SiteTerrain.spotsToKeep([ring])
        XCTAssertEqual(spots.count, plan.inside.count + plan.around.count + 4)
        let line = SiteTerrain.profileLine([ring], bearingDeg: 190, marginM: max(10, plan.bufferM))
        XCTAssertLessThan(spots.map(\.lat).min()!, line.bottom.lat)
        XCTAssertGreaterThan(spots.map(\.lat).max()!, line.top.lat)
    }

    func testTheGroundAroundASiteTouchesEveryTileWithin750Metres() {
        let spots = SiteTerrain.spotsAround(latitude: 35.866, longitude: -121.433)
        XCTAssertEqual(spots.count, 81)
        let metresPerDegree = 111_320.0
        XCTAssertEqual((spots.map(\.lat).max()! - spots.map(\.lat).min()!) * metresPerDegree, 1500, accuracy: 20)
        // Closer together than a tile is wide (about 248 m here), so none is skipped.
        let lats = Set(spots.map { ($0.lat * 1e6).rounded() }).sorted()
        XCTAssertLessThan(zip(lats, lats.dropFirst()).map { ($1 - $0) / 1e6 * metresPerDegree }.max()!, 225)
    }

    #if !canImport(FoundationNetworking)
    /// Reaches USGS, so it only runs when asked: ERIS_LIVE_USGS=1 swift test --filter UsgsElevationTests
    /// Prints what a real area measures; the website's check prints the same numbers.
    func testALiveMeasurement() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["ERIS_LIVE_USGS"] == "1", "needs the network")
        let (lon, lat) = (-121.433, 35.866)
        let area: SiteAreas.Area = [[[lon - 0.0016, lat + 0.0026], [lon + 0.0016, lat + 0.0026], [lon + 0.0018, lat - 0.0022],
                                     [lon - 0.0018, lat - 0.0022], [lon - 0.0016, lat + 0.0026]]]
        let elevation = UsgsElevation { row, col in
            let size = UsgsElevation.tileSizeM, half = size / 512
            let west = UsgsElevation.originX + Double(col) * size - half, north = UsgsElevation.originY - Double(row) * size + half
            let box = "\(west),\(north - size - 2 * half),\(west + size + 2 * half),\(north)"
            let address = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=\(box)"
                + "&bboxSR=3857&imageSR=3857&size=257,257&format=lerc&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image"
            // USGS repeats a 502 for the same address, as the server allows for.
            for attempt in 0..<4 {
                let data = try await URLSession.shared.data(from: URL(string: address + "&attempt=\(attempt)")!).0
                if data.starts(with: Array("CntZImage ".utf8)) { return data }
            }
            throw URLError(.badServerResponse)
        }
        let result = try await SiteMeasureResult.measure(area: area, terrain: elevation, now: nil, before: nil)
        print("LIVE", result.suggestions.sorted { $0.key < $1.key })
        XCTAssertFalse(result.suggestions.isEmpty)
    }
    #endif
}

/// ERIS with one tile, and how many times it was asked.
private final class TileServer: HTTPTransport, @unchecked Sendable {
    let lock = NSLock()
    var down = false
    private(set) var asked = [String]()

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body): (Int, Data) = lock.locked {
            asked.append(request.url!.path)
            if down { return (503, Data(#"{"detail":"down"}"#.utf8)) }
            guard request.url!.path.hasPrefix("/api/elevation-tiles/50710/") else { return (404, Data(#"{"detail":"none"}"#.utf8)) }
            return (200, Data(base64Encoded: realTile)!)
        }
        return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }
}

final class KeptElevationTilesTests: XCTestCase {
    private let server = TileServer()
    private var store: OfflineStore!
    private var api: APIClient!

    override func setUp() {
        store = OfflineStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("eris-tiles-\(UUID().uuidString)"))
        api = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"), transport: server)
    }

    private var spot: SiteTerrain.Spot { SiteTerrain.Spot(lon: -122.08, lat: 37.67) }

    func testATileIsKeptOnceReadAndMeasuresWithNoSignal() async throws {
        let kept = KeptElevationTiles(api: api, store: store).elevation
        let online = try await kept.heights(at: [spot])
        XCTAssertEqual(server.asked, ["/api/elevation-tiles/50710/21088"])

        server.down = true
        let offline = try await kept.heights(at: [spot])
        XCTAssertEqual(offline, online, "the same height with no signal")
        XCTAssertEqual(server.asked.count, 1, "what is kept is not asked for again")
    }

    func testNoConnectionAndNoCopyIsAnErrorSoThePackageIsTried() async {
        server.down = true
        do {
            _ = try await KeptElevationTiles(api: api, store: store).elevation.heights(at: [spot])
            XCTFail("should throw")
        } catch {
            XCTAssertTrue((error as? APIError)?.isUnreachable == true)
        }
    }

    func testPlacesOutsideCaliforniaHaveNoData() async throws {
        let heights = try await KeptElevationTiles(api: api, store: store).elevation.heights(at: [SiteTerrain.Spot(lon: -100, lat: 40)])
        XCTAssertEqual(heights, [nil])
    }

    func testAnAnswerThatIsNotATileIsNotKept() async {
        final class Broken: HTTPTransport, @unchecked Sendable {
            func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
                (Data("not a tile".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!)
            }
        }
        let broken = APIClient(baseURL: URL(string: "https://eris.test/api")!, store: MemorySessionStore(token: "t"), transport: Broken())
        _ = try? await KeptElevationTiles(api: broken, store: store).elevation.heights(at: [spot])
        XCTAssertNil(store.copy(named: "usgs-elevation-50710-21088"))
    }

    func testAFormKeepsTheGroundAroundItsSiteAndUnderItsAreas() async throws {
        var form = GisaForm()
        form["latitude"] = "37.67"
        form["longitude"] = "-122.08"
        await KeptElevationTiles(api: api, store: store).keep(form: form)
        let tiles = Set(server.asked)
        XCTAssertGreaterThanOrEqual(tiles.count, 36, "a tile is about 240 m across, and this reaches 750 m each way")
        XCTAssertLessThanOrEqual(tiles.count, 81)
        XCTAssertTrue(tiles.contains("/api/elevation-tiles/50710/21088"))
    }

    func testAnEsriTileKeptByAnEarlierBuildCanBeRemoved() {
        store.keep(Data([1]), as: "esri-elevation-16-1-2")
        store.keep(Data([2]), as: "usgs-elevation-1-2")
        store.removeCopies(startingWith: "esri-elevation-")
        XCTAssertNil(store.copy(named: "esri-elevation-16-1-2"))
        XCTAssertNotNil(store.copy(named: "usgs-elevation-1-2"))
    }
}
