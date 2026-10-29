import XCTest
@testable import ERISKit

/// Ported from mobile/src/arcgis/eristerrainBundle.test.ts.
final class TerrainBundleTests: XCTestCase {
    typealias TB = TerrainBundle

    // MARK: - A minimal STORED-zip writer (matches the worker's ZIP_STORED output)

    private func f32le(_ values: [Float]) -> [UInt8] {
        var out: [UInt8] = []
        for value in values { out += le32(value.bitPattern) }
        return out
    }

    private func le32(_ v: UInt32) -> [UInt8] {
        [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)]
    }

    private func put16(_ bytes: inout [UInt8], _ at: Int, _ v: Int) {
        bytes[at] = UInt8(v & 0xff)
        bytes[at + 1] = UInt8((v >> 8) & 0xff)
    }

    private func put32(_ bytes: inout [UInt8], _ at: Int, _ v: UInt32) {
        bytes.replaceSubrange(at..<(at + 4), with: le32(v))
    }

    private func makeStoredZip(_ files: [(String, [UInt8])]) -> [UInt8] {
        var locals: [UInt8] = []
        var centrals: [UInt8] = []
        var offset = 0
        for (name, data) in files {
            let nb = Array(name.utf8)
            let crc = TB.crc32(data)
            var lh = [UInt8](repeating: 0, count: 30 + nb.count)
            put32(&lh, 0, 0x0403_4b50)
            put16(&lh, 4, 20)
            put16(&lh, 8, 0) // STORED
            put32(&lh, 14, crc)
            put32(&lh, 18, UInt32(data.count))
            put32(&lh, 22, UInt32(data.count))
            put16(&lh, 26, nb.count)
            lh.replaceSubrange(30..<(30 + nb.count), with: nb)
            locals += lh + data

            var cd = [UInt8](repeating: 0, count: 46 + nb.count)
            put32(&cd, 0, 0x0201_4b50)
            put16(&cd, 4, 20)
            put16(&cd, 6, 20)
            put32(&cd, 16, crc)
            put32(&cd, 20, UInt32(data.count))
            put32(&cd, 24, UInt32(data.count))
            put16(&cd, 28, nb.count)
            put32(&cd, 42, UInt32(offset))
            cd.replaceSubrange(46..<(46 + nb.count), with: nb)
            centrals += cd
            offset += lh.count + data.count
        }
        var eocd = [UInt8](repeating: 0, count: 22)
        put32(&eocd, 0, 0x0605_4b50)
        put16(&eocd, 8, files.count)
        put16(&eocd, 10, files.count)
        put32(&eocd, 12, UInt32(centrals.count))
        put32(&eocd, 16, UInt32(offset))
        return locals + centrals + eocd
    }

    // MARK: - JSON helpers

    private func json(_ text: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private func enc(_ value: JSONValue) -> [UInt8] { Array(try! JSONEncoder().encode(value)) }

    private func enc(_ text: String) -> [UInt8] { Array(text.utf8) }

    /// `value` with the key (or array index) at `path` replaced; nil removes it.
    private func setting(_ value: JSONValue, _ path: [String], _ new: JSONValue?) -> JSONValue {
        guard let key = path.first else { return new ?? .null }
        let rest = Array(path.dropFirst())
        switch value {
        case .object(var o):
            o[key] = rest.isEmpty ? new : setting(o[key] ?? .object([:]), rest, new)
            return .object(o)
        case .array(var items):
            let i = Int(key)!
            items[i] = rest.isEmpty ? (new ?? .null) : setting(items[i], rest, new)
            return .array(items)
        default:
            return value
        }
    }

    private func assertThrows(_ pattern: String, file: StaticString = #filePath, line: UInt = #line, _ body: () throws -> Void) {
        do {
            try body()
            XCTFail("expected an error matching \(pattern)", file: file, line: line)
        } catch {
            let message = (error as? TB.BundleError)?.message ?? "\(error)"
            XCTAssertNotNil(message.range(of: pattern, options: .regularExpression), "\(message) does not match \(pattern)",
                            file: file, line: line)
        }
    }

    // MARK: - Fixtures

    private let sha64 = String(repeating: "a", count: 64) // grid SHA-256 is verified natively after extraction
    private let boundsJSON = #"{"min_lat":38.48,"min_lon":-121.52,"max_lat":38.52,"max_lon":-121.48}"#

    private var terrainJSON: JSONValue {
        json(#"{"file":"elevation-grid.bin","rows":3,"columns":3,"encoding":"float32","byte_order":"little","no_data_value":-9999,"min_elevation_m":1,"max_elevation_m":9,"vertical_units":"meters","bounds":\#(boundsJSON),"local_transform":{"origin_lon":-121.52,"origin_lat":38.52,"lon_per_col":0.02,"lat_per_row":-0.02},"sha256":"\#(sha64)"}"#)
    }

    private var terrain: TB.TerrainMeta {
        TB.TerrainMeta(file: "elevation-grid.bin", rows: 3, columns: 3, encoding: "float32", byteOrder: "little",
                       noDataValue: -9999, minElevationM: 1, maxElevationM: 9, verticalUnits: "meters",
                       bounds: TB.Bounds(minLat: 38.48, minLon: -121.52, maxLat: 38.52, maxLon: -121.48),
                       localTransform: TB.LocalTransform(originLon: -121.52, originLat: 38.52, lonPerCol: 0.02, latPerRow: -0.02),
                       sha256: sha64)
    }

    private func goodManifest() -> JSONValue {
        let base = json(#"{"format":"eristerrain","format_version":2,"elevation":{"source":"USGS_3DEP","dataset":"USGS 3DEP","version":"2026-06-27","resolution":"10 m/px"},"overlays":{"incident":{"lat":38.5,"lon":-121.5}}}"#)
        return setting(base, ["terrain"], terrainJSON)
    }

    private func goodBundle() -> [UInt8] {
        let grid = f32le([1, 2, 3, 4, 5, 6, 7, 8, 9])
        let overlays = enc(json(#"{"incident":{"lat":38.5,"lon":-121.5}}"#))
        return makeStoredZip([("manifest.json", enc(goodManifest())), ("elevation-grid.bin", grid), ("overlays.json", overlays)])
    }

    // MARK: - Tests

    func testValidEristerrainBundleExtractsDecodesTheHeightGrid() throws {
        let extracted = try TB.extractAndValidateBundle(goodBundle())
        XCTAssertEqual(extracted.manifest.format, "eristerrain")
        let gridBytes = try XCTUnwrap(extracted.files["elevation-grid.bin"])
        let grid = try TB.decodeHeightGrid(gridBytes, rows: 3, cols: 3)
        XCTAssertEqual(grid, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    }

    func testPathTraversalUnsafeEntryNamesAreRejected() {
        XCTAssertTrue(TB.isUnsafeEntryName("../evil"))
        XCTAssertTrue(TB.isUnsafeEntryName("/etc/passwd"))
        XCTAssertTrue(TB.isUnsafeEntryName("C:\\x"))
        XCTAssertTrue(TB.isUnsafeEntryName("a/../b"))
        XCTAssertFalse(TB.isUnsafeEntryName("manifest.json"))
        // A bundle containing a traversal entry must be rejected on extract.
        let evil = makeStoredZip([("manifest.json", enc(goodManifest())), ("../escape.bin", f32le([1]))])
        assertThrows("unsafe archive entry") { _ = try TB.extractAndValidateBundle(evil) }
    }

    func testInvalidManifestWrongFormatSourceIsRejected() {
        XCTAssertFalse(TB.validateBundleManifest(json(#"{"format":"mspk"}"#)).ok)
        XCTAssertFalse(TB.validateBundleManifest(json(#"{"format":"eristerrain","format_version":1}"#)).ok)
        let srtm = setting(json(#"{"format":"eristerrain","format_version":2,"elevation":{"source":"SRTM"}}"#), ["terrain"], terrainJSON)
        XCTAssertFalse(TB.validateBundleManifest(srtm).ok)
        XCTAssertTrue(TB.validateBundleManifest(goodManifest()).ok)
    }

    /// A manifest whose terrain has one field changed must be rejected for the expected reason.
    private func expectTerrainRejected(_ path: [String], _ value: JSONValue?, _ reasonPattern: String,
                                       file: StaticString = #filePath, line: UInt = #line) {
        let m = setting(goodManifest(), ["terrain"] + path, value)
        let r = TB.validateBundleManifest(m)
        XCTAssertFalse(r.ok, file: file, line: line)
        XCTAssertNotNil((r.reason ?? "").range(of: reasonPattern, options: .regularExpression), "\(r.reason ?? "")",
                        file: file, line: line)
    }

    private func expectTerrainRejected(_ patch: [String: JSONValue], _ reasonPattern: String,
                                       file: StaticString = #filePath, line: UInt = #line) {
        var m = goodManifest()
        for (key, value) in patch { m = setting(m, ["terrain", key], value) }
        let r = TB.validateBundleManifest(m)
        XCTAssertFalse(r.ok, file: file, line: line)
        XCTAssertNotNil((r.reason ?? "").range(of: reasonPattern, options: .regularExpression), "\(r.reason ?? "")",
                        file: file, line: line)
    }

    func testTerrainByteOrderMustBeLittle() {
        expectTerrainRejected(["byte_order"], .string("big"), "byte_order")
    }

    func testTerrainVerticalUnitsMustBeMeters() {
        expectTerrainRejected(["vertical_units"], .string("feet"), "vertical_units")
    }

    func testTerrainSha256MustBePresentAnd64HexChars() {
        expectTerrainRejected(["sha256"], nil, "sha256")
        expectTerrainRejected(["sha256"], .string("abc"), "sha256")
        expectTerrainRejected(["sha256"], .string(String(repeating: "z", count: 64)), "sha256") // non-hex
    }

    func testNonFiniteBoundsElevationsAreRejected() {
        expectTerrainRejected(["bounds", "max_lat"], .number(.nan), "bounds")
        expectTerrainRejected(["min_elevation_m": .number(9), "max_elevation_m": .number(1)], #"min\/max elevation"#)
        expectTerrainRejected(["no_data_value"], .number(.infinity), "no_data_value")
    }

    func testLocalTransformSignConsistencyWithBoundsDimensionsIsEnforced() {
        // lon_per_col must be positive, lat_per_row must be negative.
        expectTerrainRejected(["local_transform"], json(#"{"origin_lon":-121.52,"origin_lat":38.52,"lon_per_col":-0.02,"lat_per_row":-0.02}"#),
                              "lon_per_col must be positive")
        expectTerrainRejected(["local_transform"], json(#"{"origin_lon":-121.52,"origin_lat":38.52,"lon_per_col":0.02,"lat_per_row":0.02}"#),
                              "lat_per_row must be negative")
        // A transform that does not match the declared bounds + grid dimensions.
        expectTerrainRejected(["local_transform"], json(#"{"origin_lon":-121.52,"origin_lat":38.52,"lon_per_col":0.04,"lat_per_row":-0.02}"#),
                              "inconsistent with bounds")
        // Wrong origin (must be the NW corner = min_lon / max_lat).
        expectTerrainRejected(["local_transform"], json(#"{"origin_lon":-120.0,"origin_lat":38.52,"lon_per_col":0.02,"lat_per_row":-0.02}"#),
                              "inconsistent with bounds")
    }

    /// Flips a STORED entry's first data byte (header CRC unchanged, so the CRC no longer matches).
    private func corruptEntryData(_ bundle: inout [UInt8], _ name: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let entry = try? TB.parseZipEntries(bundle).first(where: { $0.name == name }) else {
            return XCTFail("entry \(name) not found", file: file, line: line)
        }
        let nameLen = try! TB.u16(bundle, entry.localOffset + 26)
        let extraLen = try! TB.u16(bundle, entry.localOffset + 28)
        let dataStart = entry.localOffset + 30 + nameLen + extraLen
        bundle[dataStart] ^= 0xff
    }

    func testACorruptedOPTIONALHillshadePngRejectsTheBundleNotSilentlyIgnored() {
        let grid = f32le([1, 2, 3, 4, 5, 6, 7, 8, 9])
        let hillshade: [UInt8] = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4] // fake PNG bytes
        var bundle = makeStoredZip([("manifest.json", enc(goodManifest())), ("elevation-grid.bin", grid), ("hillshade.png", hillshade)])
        corruptEntryData(&bundle, "hillshade.png")
        assertThrows(#"hillshade\.png checksum mismatch"#) { _ = try TB.extractAndValidateBundle(bundle) }
    }

    func testACorruptedOPTIONALOverlaysJsonRejectsTheBundleNotSilentlyIgnored() {
        var bundle = goodBundle()
        corruptEntryData(&bundle, "overlays.json")
        assertThrows(#"overlays\.json checksum mismatch"#) { _ = try TB.extractAndValidateBundle(bundle) }
    }

    func testMissingHeightGridIsRejected() {
        let noGrid = makeStoredZip([("manifest.json", enc(goodManifest()))])
        assertThrows("missing terrain grid") { _ = try TB.extractAndValidateBundle(noGrid) }
    }

    func testHeightGridSizeMismatchIsRejected() {
        // Declare 4x4 (with a transform consistent with 4x4) but provide only 3x3 bytes,
        // isolating the byte-length check from the transform-consistency check.
        let lonStep: Double = 0.04 / 3
        let latStep: Double = -0.04 / 3
        var m = goodManifest()
        m = setting(m, ["terrain", "rows"], .number(4))
        m = setting(m, ["terrain", "columns"], .number(4))
        m = setting(m, ["terrain", "local_transform"], .object([
            "origin_lon": .number(-121.52), "origin_lat": .number(38.52), "lon_per_col": .number(lonStep), "lat_per_row": .number(latStep),
        ]))
        let bundle = makeStoredZip([("manifest.json", enc(m)), ("elevation-grid.bin", f32le([1, 2, 3, 4, 5, 6, 7, 8, 9]))])
        assertThrows("byte length") { _ = try TB.extractAndValidateBundle(bundle) }
    }

    func testCorruptedGridBytesFailCRC32Verification() throws {
        var bundle = goodBundle()
        // Find and corrupt a grid data byte: parse, locate the grid local data start.
        let entries = try TB.parseZipEntries(bundle)
        let grid = try XCTUnwrap(entries.first { $0.name == "elevation-grid.bin" })
        let nameLen = try TB.u16(bundle, grid.localOffset + 26)
        let extraLen = try TB.u16(bundle, grid.localOffset + 28)
        let dataStart = grid.localOffset + 30 + nameLen + extraLen
        bundle[dataStart] ^= 0xff // flip a byte; CRC in headers is unchanged
        assertThrows("checksum mismatch") { _ = try TB.extractAndValidateBundle(bundle) }
    }

    func testLocalCoordinateMappingIncidentLonLatGridCellAndBack() {
        // Center of the 3x3 grid maps to the middle cell (1,1).
        let cell = TB.lonLatToGridCell(terrain, lon: -121.5, lat: 38.5)
        XCTAssertEqual(cell.col, 1)
        XCTAssertEqual(cell.row, 1)
        let center = TB.gridCellToLonLat(terrain, col: 1, row: 1)
        XCTAssertTrue(abs(center.lon - -121.5) < 1e-9 && abs(center.lat - 38.5) < 1e-9)
        // Top-left cell maps to (min_lon, max_lat).
        let corner = TB.gridCellToLonLat(terrain, col: 0, row: 0)
        XCTAssertEqual(corner.lon, -121.52)
        XCTAssertEqual(corner.lat, 38.52)
    }

    func testNotAZipInputIsRejected() {
        assertThrows("not a valid package archive") { _ = try TB.extractAndValidateBundle([1, 2, 3, 4] as [UInt8]) }
    }

    // MARK: - Context layers (roads / imagery / overview)

    private var roadsBytes: [UInt8] { enc(#"{"type":"FeatureCollection","features":[]}"#) }

    private func manifestWithRoads(_ overrides: [String: JSONValue] = [:]) -> JSONValue {
        var roads: [String: JSONValue] = [
            "available": .bool(true), "file": .string("roads.geojson"), "sha256": .string(String(repeating: "b", count: 64)),
            "bytes": .number(Double(roadsBytes.count)), "feature_count": .number(1), "road_kinds": .array([.string("road_bearing")]),
        ]
        for (key, value) in overrides { roads[key] = value }
        var m = setting(goodManifest(), ["context_layers"], .object([
            "roads": .object(roads),
            "imagery": json(#"{"available":false,"reason":"not_configured"}"#),
            "overview": json(#"{"available":false,"reason":"disabled"}"#),
        ]))
        m = setting(m, ["files"], json(#"{"manifest":"manifest.json","terrain":"elevation-grid.bin","roads":"roads.geojson","hillshade":"hillshade.png"}"#))
        return m
    }

    private func bundleWith(_ manifest: JSONValue, _ entries: [(String, [UInt8])]) -> [UInt8] {
        makeStoredZip([("manifest.json", enc(manifest)), ("elevation-grid.bin", f32le([1, 2, 3, 4, 5, 6, 7, 8, 9]))] + entries)
    }

    func testLegacyBundleWithoutContextLayersStillOpensUnavailableNotCorrupt() throws {
        let manifest = try TB.extractAndValidateBundle(goodBundle()).manifest
        XCTAssertFalse(TB.contextLayerAvailable(manifest, .roads))
        XCTAssertFalse(TB.contextLayerAvailable(manifest, .imagery))
        let s = TB.summarizeContextLayers(manifest)
        XCTAssertFalse(s.roads)
        XCTAssertFalse(s.imagery)
    }

    func testDeclaredAvailableRoadsAssetIsValidatedExtracted() throws {
        let bundle = bundleWith(manifestWithRoads(), [("roads.geojson", roadsBytes)])
        let extracted = try TB.extractAndValidateBundle(bundle)
        XCTAssertNotNil(extracted.files["roads.geojson"])
        XCTAssertTrue(TB.contextLayerAvailable(extracted.manifest, .roads))
        XCTAssertFalse(TB.contextLayerAvailable(extracted.manifest, .imagery))
        XCTAssertEqual(TB.contextLayerReason(extracted.manifest, .imagery), "not_configured")
    }

    func testDeclaredAvailableContextAssetThatIsMISSINGFailsClosed() {
        let bundle = bundleWith(manifestWithRoads(), []) // roads declared but not packaged
        assertThrows(#"missing context asset roads\.geojson"#) { _ = try TB.extractAndValidateBundle(bundle) }
    }

    func testDeclaredAvailableContextAssetWithACORRUPTBodyFailsClosed() throws {
        var bundle = bundleWith(manifestWithRoads(), [("roads.geojson", roadsBytes)])
        let entries = try TB.parseZipEntries(bundle)
        let e = try XCTUnwrap(entries.first { $0.name == "roads.geojson" })
        let nameLen = try TB.u16(bundle, e.localOffset + 26)
        let extraLen = try TB.u16(bundle, e.localOffset + 28)
        bundle[e.localOffset + 30 + nameLen + extraLen] ^= 0xff
        assertThrows(#"roads\.geojson checksum mismatch"#) { _ = try TB.extractAndValidateBundle(bundle) }
    }

    func testDeclaredAvailableContextAssetWithWrongByteCountFailsClosed() {
        let bundle = bundleWith(manifestWithRoads(["bytes": .number(Double(roadsBytes.count + 5))]), [("roads.geojson", roadsBytes)])
        assertThrows(#"roads\.geojson size mismatch"#) { _ = try TB.extractAndValidateBundle(bundle) }
    }

    func testAvailableFalseLayerIsIgnoredEvenIfAStrayFileExists() throws {
        let m = setting(manifestWithRoads(), ["context_layers", "roads"], json(#"{"available":false,"reason":"no_data"}"#))
        let bundle = bundleWith(m, [("roads.geojson", roadsBytes)]) // present but not declared available
        let manifest = try TB.extractAndValidateBundle(bundle).manifest
        XCTAssertFalse(TB.contextLayerAvailable(manifest, .roads))
        XCTAssertEqual(TB.contextLayerReason(manifest, .roads), "no_data")
    }

    func testSummarizeContextLayersReflectsHillshadeRoadsImagery() {
        var m = setting(manifestWithRoads(), ["context_layers", "imagery"], json(#"{"available":true,"file":"imagery.png","sha256":"\#(String(repeating: "c", count: 64))","bytes":3,"source":{"provider":"usgs_naip","attribution":"USDA NAIP via USGS"}}"#))
        m = setting(m, ["files", "imagery"], .string("imagery.png"))
        let s = TB.summarizeContextLayers(TB.Manifest(json: m))
        XCTAssertTrue(s.hillshade) // files.hillshade present
        XCTAssertTrue(s.roads)
        XCTAssertTrue(s.imagery)
        XCTAssertEqual(s.imagerySource, "USDA NAIP via USGS")
        XCTAssertTrue((s.attribution ?? []).contains("USDA NAIP via USGS"))
        // Truthful road context from the packaged feature kinds + count.
        XCTAssertEqual(s.roadContext, "Road bearing context")
        XCTAssertEqual(s.roadFeatureCount, 1)
    }

    func testSummarizeContextLayersRoadContextInventoryVsFeatureServiceVsNone() {
        let inv = manifestWithRoads(["road_kinds": .array([.string("road_bearing"), .string("road_inventory")]), "feature_count": .number(3)])
        XCTAssertEqual(TB.summarizeContextLayers(TB.Manifest(json: inv)).roadContext, "Road inventory geometry")
        let net = manifestWithRoads(["road_kinds": .array([.string("road_centerline")]), "feature_count": .number(42)])
        let ns = TB.summarizeContextLayers(TB.Manifest(json: net))
        XCTAssertEqual(ns.roadContext, "Feature service road network")
        XCTAssertEqual(ns.roadFeatureCount, 42)
        // No roads packaged.
        let legacy = TB.summarizeContextLayers(TB.Manifest(json: goodManifest()))
        XCTAssertEqual(legacy.roadContext, "No road context packaged")
    }

    // MARK: - Tiled aerial imagery

    private let tile0: [UInt8] = [0xff, 0xd8, 0xff, 1, 2, 3, 4, 5] // JPEG magic + body
    private let tile1: [UInt8] = [0xff, 0xd8, 0xff, 9, 8, 7, 6, 5, 4]
    private let tileBoundsL = TB.Bounds(minLat: 38.48, minLon: -121.52, maxLat: 38.52, maxLon: -121.5)
    private let tileBoundsR = TB.Bounds(minLat: 38.48, minLon: -121.5, maxLat: 38.52, maxLon: -121.48)

    private func tileBoundsJSON(_ b: TB.Bounds) -> JSONValue {
        .object(["min_lat": .number(b.minLat), "min_lon": .number(b.minLon), "max_lat": .number(b.maxLat), "max_lon": .number(b.maxLon)])
    }

    private func manifestWithTiledImagery(_ overrides: [String: JSONValue] = [:]) -> JSONValue {
        let tiles: JSONValue = .array([
            .object(["row": .number(0), "column": .number(0), "file": .string("imagery/0/0.jpg"), "bounds": tileBoundsJSON(tileBoundsL),
                     "sha256": .string(String(repeating: "d", count: 64)), "bytes": .number(Double(tile0.count))]),
            .object(["row": .number(0), "column": .number(1), "file": .string("imagery/0/1.jpg"), "bounds": tileBoundsJSON(tileBoundsR),
                     "sha256": .string(String(repeating: "e", count: 64)), "bytes": .number(Double(tile1.count))]),
        ])
        var imagery: [String: JSONValue] = [
            "available": .bool(true), "format": .string("tiled"), "tile_size_px": .number(1024), "columns": .number(2),
            "rows": .number(1), "tile_count": .number(2), "target_meters_per_pixel": .number(0.6),
            "effective_meters_per_pixel": .number(0.58), "bytes": .number(Double(tile0.count + tile1.count)),
            "bounds": json(boundsJSON), "source": json(#"{"provider":"usgs_naip","attribution":"USDA NAIP via USGS"}"#),
            "tiles": tiles,
        ]
        for (key, value) in overrides { imagery[key] = value }
        var m = setting(goodManifest(), ["context_layers"], .object([
            "roads": json(#"{"available":false,"reason":"disabled"}"#),
            "overview": json(#"{"available":false,"reason":"disabled"}"#),
            "imagery": .object(imagery),
        ]))
        m = setting(m, ["files"], json(#"{"manifest":"manifest.json","terrain":"elevation-grid.bin","hillshade":"hillshade.png"}"#))
        return m
    }

    private func tiledBundle(_ manifest: JSONValue, _ tiles: [(String, [UInt8])]? = nil) -> [UInt8] {
        bundleWith(manifest, tiles ?? [("imagery/0/0.jpg", tile0), ("imagery/0/1.jpg", tile1)])
    }

    func testTiledImageryManifestParsesIsAvailableAndEveryTileIsExtracted() throws {
        let extracted = try TB.extractAndValidateBundle(tiledBundle(manifestWithTiledImagery()))
        let manifest = extracted.manifest
        XCTAssertTrue(TB.contextLayerAvailable(manifest, .imagery))
        XCTAssertEqual(TB.imageryMode(manifest), .tiled)
        XCTAssertTrue(TB.imageryIsTiled(manifest.layer(.imagery)))
        let tiles = TB.imageryTiles(manifest)
        XCTAssertEqual(tiles.count, 2)
        XCTAssertTrue(extracted.files["imagery/0/0.jpg"] != nil && extracted.files["imagery/0/1.jpg"] != nil)
        // Tile file paths + bounds preserved for the renderer's per-tile terrain patches.
        XCTAssertEqual(tiles[0].file, "imagery/0/0.jpg")
        XCTAssertEqual(tiles[1].bounds, tileBoundsR)
    }

    func testTiledImagerySummaryReportsModeTileCountEffectiveResolutionSource() {
        let s = TB.summarizeContextLayers(TB.Manifest(json: manifestWithTiledImagery()))
        XCTAssertTrue(s.imagery)
        XCTAssertEqual(s.imageryMode, .tiled)
        XCTAssertEqual(s.imageryTileCount, 2)
        XCTAssertEqual(s.imageryEffectiveMpp, 0.58)
        XCTAssertEqual(s.imagerySource, "USDA NAIP via USGS")
    }

    func testLegacySingleImageImageryIsStillRecognisedBackwardCompatible() {
        var m = setting(goodManifest(), ["context_layers"], json(#"{"imagery":{"available":true,"file":"imagery.png","sha256":"\#(String(repeating: "c", count: 64))","bytes":3,"source":{"provider":"usgs_naip"}}}"#))
        m = setting(m, ["files"], json(#"{"imagery":"imagery.png"}"#))
        let manifest = TB.Manifest(json: m)
        XCTAssertEqual(TB.imageryMode(manifest), .single)
        XCTAssertFalse(TB.imageryIsTiled(manifest.layer(.imagery)))
        XCTAssertTrue(TB.contextLayerAvailable(manifest, .imagery))
        XCTAssertEqual(TB.summarizeContextLayers(manifest).imageryMode, .single)
    }

    func testTiledImageryAManifestDeclaredTileThatIsMISSINGFailsClosed() {
        // Declare 2 tiles but package only the first one.
        let bundle = tiledBundle(manifestWithTiledImagery(), [("imagery/0/0.jpg", tile0)])
        assertThrows(#"missing context asset imagery\/0\/1\.jpg"#) { _ = try TB.extractAndValidateBundle(bundle) }
    }

    func testTiledImageryACORRUPTTileBodyFailsClosed() {
        var bundle = tiledBundle(manifestWithTiledImagery())
        corruptEntryData(&bundle, "imagery/0/1.jpg")
        assertThrows(#"imagery\/0\/1\.jpg checksum mismatch"#) { _ = try TB.extractAndValidateBundle(bundle) }
    }

    func testTiledImageryATileWithTheWrongByteCountFailsClosed() {
        let m = setting(manifestWithTiledImagery(), ["context_layers", "imagery", "tiles", "0", "bytes"], .number(Double(tile0.count + 3)))
        assertThrows(#"imagery\/0\/0\.jpg size mismatch"#) { _ = try TB.extractAndValidateBundle(tiledBundle(m)) }
    }

    func testTiledImageryTileCountNotMatchingColumnsRowsFailsClosed() {
        let m = manifestWithTiledImagery(["columns": .number(3), "rows": .number(1)]) // says 3 tiles, only 2 declared
        assertThrows("tile count does not match") { _ = try TB.extractAndValidateBundle(tiledBundle(m)) }
    }

    // MARK: - Exact-extent export contract (backend-side registration proof)
    //
    // The backend proves each tile's exported extent matches the requested bounds and
    // records that proof in the manifest. The reader needs no change: it places tiles by
    // their declared `bounds`, and the new keys are additive.

    private let extentVerification: [String: JSONValue] = [
        "width_px": .number(1024), "height_px": .number(1024), "extent_verified": .bool(true), "extent_max_delta_deg": .number(0),
        "extent_tolerance_deg": .number(1e-9), "requested_width_px": .number(1024), "requested_height_px": .number(1024),
        "returned_width_px": .number(1024), "returned_height_px": .number(1024), "dimensions_verified": .bool(true),
    ]

    private func manifestWithVerifiedTiledImagery() -> JSONValue {
        var m = manifestWithTiledImagery([
            "export_contract": .string("exact_extent_arcgis_export_v2"),
            "diagnostics": json(#"{"export_contract":"exact_extent_arcgis_export_v2","adjust_aspect_ratio":false,"extents_verified":true,"extents_verified_count":2,"extent_mismatch_count":0,"dimensions_verified_count":2,"extent_tolerance_deg":1e-9}"#),
        ])
        for i in 0..<2 {
            for (key, value) in extentVerification {
                m = setting(m, ["context_layers", "imagery", "tiles", String(i), key], value)
            }
        }
        return m
    }

    func testExactExtentPackageAdditiveVerificationMetadataIsAcceptedUnchanged() throws {
        let extracted = try TB.extractAndValidateBundle(tiledBundle(manifestWithVerifiedTiledImagery()))
        let manifest = extracted.manifest
        XCTAssertTrue(TB.contextLayerAvailable(manifest, .imagery))
        XCTAssertEqual(TB.imageryMode(manifest), .tiled)
        let tiles = TB.imageryTiles(manifest)
        XCTAssertEqual(tiles.count, 2)
        XCTAssertTrue(extracted.files["imagery/0/0.jpg"] != nil && extracted.files["imagery/0/1.jpg"] != nil)
        // The reader must not require, validate or choke on the new keys...
        XCTAssertEqual(tiles[0].raw["extent_verified"], .bool(true))
        // ...and the summary is unaffected by them.
        let s = TB.summarizeContextLayers(TB.Manifest(json: manifestWithVerifiedTiledImagery()))
        XCTAssertEqual(s.imageryMode, .tiled)
        XCTAssertEqual(s.imageryTileCount, 2)
    }

    func testExactExtentPackagePlacementStillComesFromEachTileSDECLAREDBounds() throws {
        // The renderer maps a tile image onto the rectangle named here, so those bounds
        // must survive parsing exactly.
        let manifest = try TB.extractAndValidateBundle(tiledBundle(manifestWithVerifiedTiledImagery())).manifest
        let tiles = TB.imageryTiles(manifest)
        XCTAssertEqual(tiles[0].bounds, tileBoundsL)
        XCTAssertEqual(tiles[1].bounds, tileBoundsR)
        // Adjacent tiles share the EXACT edge value: no overlap for the mosaic to duplicate.
        XCTAssertEqual(tiles[0].bounds?.maxLon, tiles[1].bounds?.minLon)
    }

    func testExactExtentPackageTheExistingFailClosedChecksStillApply() {
        // Verification metadata must not weaken integrity checking.
        var bundle = tiledBundle(manifestWithVerifiedTiledImagery())
        corruptEntryData(&bundle, "imagery/0/1.jpg")
        assertThrows(#"imagery\/0\/1\.jpg checksum mismatch"#) { _ = try TB.extractAndValidateBundle(bundle) }
        let missing = tiledBundle(manifestWithVerifiedTiledImagery(), [("imagery/0/0.jpg", tile0)])
        assertThrows(#"missing context asset imagery\/0\/1\.jpg"#) { _ = try TB.extractAndValidateBundle(missing) }
    }

    func testLegacyTiledPackagesWithoutTheContractKeepWorkingNoForcedReDownloadPath() throws {
        // A package built before the contract carries none of the new keys; it must still
        // parse and remain usable rather than being rejected as malformed.
        let manifest = try TB.extractAndValidateBundle(tiledBundle(manifestWithTiledImagery())).manifest
        XCTAssertNil(manifest.layer(.imagery)?.raw["export_contract"])
        XCTAssertEqual(TB.imageryMode(manifest), .tiled)
        XCTAssertEqual(TB.imageryTiles(manifest).count, 2)
    }

    // MARK: - Road cross-section context (road_cross_section.json)

    private var rxs: [UInt8] {
        enc(json(#"{"attributes":{"lt_lane_count":1,"rt_lane_count":1,"median_category":"NONE","total_width_ft":32,"source":"ROAD_INVENTORY"},"route_name":"SR-17","county_code":"SCL","begin_pm":5,"end_pm":6,"upstation_bearing_deg":42,"postmile_increases_upstation":true,"source":"ROAD_INVENTORY"}"#))
    }

    private func manifestWithRoadXsec(_ overrides: [String: JSONValue] = [:]) -> JSONValue {
        var layer: [String: JSONValue] = [
            "available": .bool(true), "file": .string("road_cross_section.json"), "sha256": .string(String(repeating: "f", count: 64)),
            "bytes": .number(Double(rxs.count)), "source": json(#"{"provider":"eris_road_inventory","attribution":"ERIS Road Inventory"}"#),
        ]
        for (key, value) in overrides { layer[key] = value }
        var m = setting(goodManifest(), ["context_layers"], .object([
            "roads": json(#"{"available":false,"reason":"no_data"}"#),
            "imagery": json(#"{"available":false,"reason":"not_configured"}"#),
            "overview": json(#"{"available":false,"reason":"disabled"}"#),
            "road_cross_section": .object(layer),
        ]))
        m = setting(m, ["files"], json(#"{"manifest":"manifest.json","terrain":"elevation-grid.bin","road_cross_section":"road_cross_section.json"}"#))
        return m
    }

    func testRoadCrossSectionContextIsValidatedExtractedReportedAvailable() throws {
        let extracted = try TB.extractAndValidateBundle(bundleWith(manifestWithRoadXsec(), [("road_cross_section.json", rxs)]))
        XCTAssertTrue(TB.roadCrossSectionAvailable(extracted.manifest))
        let data = try XCTUnwrap(extracted.files["road_cross_section.json"])
        let parsed = try JSONDecoder().decode(TB.RoadCrossSectionContext.self, from: Data(data))
        XCTAssertEqual(parsed.attributes["source"], .string("ROAD_INVENTORY"))
        XCTAssertEqual(parsed.routeName, "SR-17")
    }

    func testLegacyPackageWithoutRoadCrossSectionStillOpensUnavailableNotCorrupt() throws {
        let manifest = try TB.extractAndValidateBundle(goodBundle()).manifest
        XCTAssertFalse(TB.roadCrossSectionAvailable(manifest))
        XCTAssertEqual(TB.contextLayerReason(manifest, .roadCrossSection), "unavailable")
    }

    func testDeclaredAvailableRoadCrossSectionThatIsMISSINGFailsClosed() {
        assertThrows(#"missing context asset road_cross_section\.json"#) {
            _ = try TB.extractAndValidateBundle(bundleWith(manifestWithRoadXsec(), []))
        }
    }

    func testDeclaredAvailableRoadCrossSectionWithWrongByteCountFailsClosed() {
        let bundle = bundleWith(manifestWithRoadXsec(["bytes": .number(Double(rxs.count + 9))]), [("road_cross_section.json", rxs)])
        assertThrows(#"road_cross_section\.json size mismatch"#) { _ = try TB.extractAndValidateBundle(bundle) }
    }

    // MARK: - Road cross-section usability (truthful UI gating)

    func testRoadCrossSectionUsabilityExplicitFlagsNotFullyUsableWhenNoSnapBearing() {
        let m = TB.Manifest(json: json(#"""
        {"context_layers": {
          "roads": {"available": false, "reason": "no_road_bearing"},
          "road_cross_section": {"available": true, "file": "road_cross_section.json", "sha256": "\#(String(repeating: "f", count: 64))", "bytes": 1,
            "layout_available": true, "layout_source": "DEFAULT", "layout_source_label": "Default roadway assumptions",
            "snap_available": false, "orientation_available": false, "fully_usable": false, "reason": "no_road_snap_geometry"}
        }}
        """#))
        let u = TB.roadCrossSectionUsability(m)
        XCTAssertTrue(u.layoutAvailable)
        XCTAssertFalse(u.snapAvailable)
        XCTAssertFalse(u.orientationAvailable)
        XCTAssertFalse(u.fullyUsable) // UI must NOT claim usable
        XCTAssertEqual(u.reason, "no_road_snap_geometry")
        XCTAssertEqual(u.layoutSourceLabel, "Default roadway assumptions") // never "Road Inventory" for DEFAULT
    }

    func testRoadCrossSectionUsabilityExplicitFlagsFullyUsableWithSnapBearing() {
        let m = TB.Manifest(json: json(#"""
        {"context_layers": {
          "roads": {"available": true, "file": "roads.geojson", "sha256": "\#(String(repeating: "b", count: 64))", "road_kinds": ["road_bearing"]},
          "road_cross_section": {"available": true, "file": "road_cross_section.json", "sha256": "\#(String(repeating: "f", count: 64))", "bytes": 1,
            "layout_available": true, "layout_source": "ROAD_INVENTORY", "snap_available": true, "orientation_available": true,
            "fully_usable": true, "reason": null}
        }}
        """#))
        XCTAssertTrue(TB.roadCrossSectionUsability(m).fullyUsable)
    }

    func testRoadCrossSectionUsabilityLegacyPackageNoFlagsFallsBackConservatively() {
        // Legacy: road_cross_section available but no flags; roads unavailable -> not fully usable.
        let legacy = TB.Manifest(json: json(#"""
        {"context_layers": {
          "roads": {"available": false, "reason": "no_data"},
          "road_cross_section": {"available": true, "file": "road_cross_section.json", "sha256": "\#(String(repeating: "f", count: 64))"}
        }}
        """#))
        let u = TB.roadCrossSectionUsability(legacy)
        XCTAssertFalse(u.fullyUsable)
        XCTAssertEqual(u.reason, "no_road_snap_geometry")
        // Legacy with roads available -> usable via snap.
        let legacyRoads = TB.Manifest(json: json(#"""
        {"context_layers": {
          "roads": {"available": true, "file": "roads.geojson", "sha256": "\#(String(repeating: "b", count: 64))"},
          "road_cross_section": {"available": true, "file": "road_cross_section.json", "sha256": "\#(String(repeating: "f", count: 64))"}
        }}
        """#))
        XCTAssertTrue(TB.roadCrossSectionUsability(legacyRoads).fullyUsable)
    }

    func testRoadsUnavailableReasonSurfacesThePreciseTokenNeverGenericWhenPackaged() {
        func manifest(_ text: String) -> TB.Manifest { TB.Manifest(json: json(text)) }
        XCTAssertEqual(TB.roadsUnavailableReason(manifest(#"{"context_layers":{"roads":{"available":false,"reason":"no_road_bearing"}}}"#)), "no_road_bearing")
        XCTAssertEqual(TB.roadsUnavailableReason(manifest(#"{"context_layers":{"roads":{"available":false,"reason":"disabled"}}}"#)), "disabled")
        XCTAssertNil(TB.roadsUnavailableReason(manifest(#"{"context_layers":{"roads":{"available":true,"file":"roads.geojson","sha256":"\#(String(repeating: "b", count: 64))"}}}"#)))
        XCTAssertEqual(TB.roadsUnavailableReason(manifest(#"{"context_layers":{}}"#)), "no_road_context")
    }

    // MARK: - DEFECT A: completed-but-empty external road query

    func testDEFECTAACompletedEmptyRoadsLayerDisablesSelectionButIsNOTAnError() {
        let m = TB.Manifest(json: json(#"""
        {"context_layers": {
          "roads": {"available": false, "reason": "no_centerline_features_in_area", "query_completed": true,
                    "provider": "caltrans_crs", "filter_version": "caltrans_crs.v2:F_System[1,2]", "functional_classes": [1, 2]},
          "road_cross_section": {"available": true, "file": "road_cross_section.json", "sha256": "\#(String(repeating: "f", count: 64))"}
        }}
        """#))
        // Road selection / cross-section snapping is disabled (roads not available).
        XCTAssertFalse(TB.contextLayerAvailable(m, .roads))
        XCTAssertFalse(TB.roadCrossSectionUsability(m).snapAvailable)
        XCTAssertFalse(TB.roadCrossSectionUsability(m).fullyUsable)
        // ...but the state is correctly recognised as a completed empty query, not a failure.
        XCTAssertTrue(TB.roadsQueryCompletedEmpty(m))
        XCTAssertEqual(TB.roadsUnavailableReason(m), "no_centerline_features_in_area")
    }

    func testDEFECTAASourceFailureIsNOTReportedAsACompletedEmptyQuery() {
        let m = TB.Manifest(json: json(#"{"context_layers":{"roads":{"available":false,"reason":"source_error"}}}"#))
        XCTAssertFalse(TB.roadsQueryCompletedEmpty(m))
        let empty = TB.Manifest(json: json(#"{"context_layers":{"roads":{"available":false,"reason":"no_centerline_features_in_area"}}}"#))
        // Without the explicit query_completed flag, do not assume completion.
        XCTAssertFalse(TB.roadsQueryCompletedEmpty(empty))
    }

    func testDEFECTATheHumanMessageIsSanitizedAndUsefulNoInternalsLeak() {
        let cases: [(String, Bool, String)] = [
            ("no_centerline_features_in_area", true, "No mapped highways in this area"),
            ("source_error", false, "Road data was unavailable when this package was built"),
            ("incomplete_source", false, "Road data was incomplete and was not included"),
            ("provider_not_configured", false, "No road data source is configured"),
            ("disabled", false, "Road context is turned off for this package"),
            ("too_large", false, "Road data exceeded the package size limit"),
        ]
        for (reason, done, expected) in cases {
            let m = TB.Manifest(json: .object(["context_layers": .object(["roads": .object([
                "available": .bool(false), "reason": .string(reason), "query_completed": .bool(done),
            ])])]))
            let msg = TB.roadsUnavailableMessage(m)
            XCTAssertEqual(msg, expected, "reason \(reason)")
            // Never leak env-var names, enum/class names, Python internals, URLs, or raw tokens.
            for bad in ["OFFLINE_SCENE", "Error", "Exception", "Traceback", "http", "F_System", "_", "caltrans_crs"] {
                XCTAssertFalse(msg!.contains(bad), "message for \(reason) leaked \(bad): \(msg!)")
            }
        }
        // Available roads => no message.
        let available = TB.Manifest(json: json(#"{"context_layers":{"roads":{"available":true,"file":"roads.geojson","sha256":"\#(String(repeating: "b", count: 64))"}}}"#))
        XCTAssertNil(TB.roadsUnavailableMessage(available))
    }
}
