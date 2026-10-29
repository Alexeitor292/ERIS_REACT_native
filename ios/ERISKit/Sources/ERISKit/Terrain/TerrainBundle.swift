import Foundation

/// Ported from mobile/src/arcgis/eristerrainBundle.ts. The offline terrain
/// bundle ("eristerrain"): a STORED (uncompressed) ZIP the worker builds, holding
/// manifest.json, elevation-grid.bin (float32 little-endian heights), an optional
/// hillshade.png and overlays.json, and any packaged context layers. Checked and
/// unpacked here so the renderer only ever opens a sound package.
public enum TerrainBundle {
    /// One entry of the archive's central directory.
    public struct ZipEntry: Equatable, Sendable {
        public let name: String
        public let method: Int
        public let crc32: UInt32
        public let compSize: Int
        public let uncompSize: Int
        public let localOffset: Int
    }

    /// Why a bundle was refused.
    public struct BundleError: Error, Equatable, Sendable, CustomStringConvertible, LocalizedError {
        public let message: String
        public init(_ message: String) { self.message = message }
        public var description: String { message }
        public var errorDescription: String? { message }
    }

    /// The result of checking metadata: `reason` says what is wrong when not `ok`.
    public struct Validation: Equatable, Sendable {
        public let ok: Bool
        public let reason: String?

        static let valid = Validation(ok: true, reason: nil)
        static func invalid(_ reason: String) -> Validation { Validation(ok: false, reason: reason) }
    }

    /// A lon/lat rectangle, as manifests write it.
    public struct Bounds: Codable, Equatable, Sendable {
        public var minLat: Double
        public var minLon: Double
        public var maxLat: Double
        public var maxLon: Double

        enum CodingKeys: String, CodingKey {
            case minLat = "min_lat", minLon = "min_lon", maxLat = "max_lat", maxLon = "max_lon"
        }

        public init(minLat: Double, minLon: Double, maxLat: Double, maxLon: Double) {
            self.minLat = minLat
            self.minLon = minLon
            self.maxLat = maxLat
            self.maxLon = maxLon
        }

        /// Nil unless all four edges are numbers.
        init?(json: JSONValue?) {
            guard let o = TerrainJS.object(json), let minLat = TerrainJS.double(o["min_lat"]),
                  let minLon = TerrainJS.double(o["min_lon"]), let maxLat = TerrainJS.double(o["max_lat"]),
                  let maxLon = TerrainJS.double(o["max_lon"]) else { return nil }
            self.init(minLat: minLat, minLon: minLon, maxLat: maxLat, maxLon: maxLon)
        }
    }

    /// Grid (col, row) to lon/lat: the origin is the north-west corner, columns
    /// step east and rows step south.
    public struct LocalTransform: Codable, Equatable, Sendable {
        public var originLon: Double
        public var originLat: Double
        public var lonPerCol: Double
        public var latPerRow: Double

        enum CodingKeys: String, CodingKey {
            case originLon = "origin_lon", originLat = "origin_lat", lonPerCol = "lon_per_col", latPerRow = "lat_per_row"
        }

        public init(originLon: Double, originLat: Double, lonPerCol: Double, latPerRow: Double) {
            self.originLon = originLon
            self.originLat = originLat
            self.lonPerCol = lonPerCol
            self.latPerRow = latPerRow
        }

        init?(json: JSONValue?) {
            guard let o = TerrainJS.object(json), let originLon = TerrainJS.double(o["origin_lon"]),
                  let originLat = TerrainJS.double(o["origin_lat"]), let lonPerCol = TerrainJS.double(o["lon_per_col"]),
                  let latPerRow = TerrainJS.double(o["lat_per_row"]) else { return nil }
            self.init(originLon: originLon, originLat: originLat, lonPerCol: lonPerCol, latPerRow: latPerRow)
        }
    }

    /// The manifest's `terrain` block: the height grid's shape, units and placement.
    public struct TerrainMeta: Codable, Equatable, Sendable {
        public var file: String
        public var rows: Int
        public var columns: Int
        public var encoding: String
        public var byteOrder: String
        public var noDataValue: Double
        public var minElevationM: Double
        public var maxElevationM: Double
        public var verticalUnits: String
        public var bounds: Bounds
        public var localTransform: LocalTransform
        public var sha256: String?

        enum CodingKeys: String, CodingKey {
            case file, rows, columns, encoding, bounds, sha256
            case byteOrder = "byte_order", noDataValue = "no_data_value", minElevationM = "min_elevation_m"
            case maxElevationM = "max_elevation_m", verticalUnits = "vertical_units", localTransform = "local_transform"
        }

        public init(file: String, rows: Int, columns: Int, encoding: String, byteOrder: String, noDataValue: Double,
                    minElevationM: Double, maxElevationM: Double, verticalUnits: String, bounds: Bounds,
                    localTransform: LocalTransform, sha256: String?) {
            self.file = file
            self.rows = rows
            self.columns = columns
            self.encoding = encoding
            self.byteOrder = byteOrder
            self.noDataValue = noDataValue
            self.minElevationM = minElevationM
            self.maxElevationM = maxElevationM
            self.verticalUnits = verticalUnits
            self.bounds = bounds
            self.localTransform = localTransform
            self.sha256 = sha256
        }

        /// Nil unless the block passes `validateTerrainMeta`.
        init?(json: JSONValue?) {
            guard TerrainBundle.validateTerrainMeta(json).ok, let o = TerrainJS.object(json),
                  let bounds = Bounds(json: o["bounds"]), let transform = LocalTransform(json: o["local_transform"])
            else { return nil }
            self.init(file: TerrainJS.string(o["file"]) ?? "",
                      rows: Int(TerrainJS.number(o["rows"])), columns: Int(TerrainJS.number(o["columns"])),
                      encoding: TerrainJS.string(o["encoding"]) ?? "", byteOrder: TerrainJS.string(o["byte_order"]) ?? "",
                      noDataValue: TerrainJS.double(o["no_data_value"]) ?? 0,
                      minElevationM: TerrainJS.double(o["min_elevation_m"]) ?? 0,
                      maxElevationM: TerrainJS.double(o["max_elevation_m"]) ?? 0,
                      verticalUnits: TerrainJS.string(o["vertical_units"]) ?? "",
                      bounds: bounds, localTransform: transform, sha256: TerrainJS.string(o["sha256"]))
        }
    }

    /// Where a context layer came from, for attribution.
    public struct LayerSource: Equatable, Sendable {
        public let provider: String?
        public let dataset: String?
        public let retrievedAt: String?
        public let attribution: String?
        public let resolution: String?
        public let service: String?

        init?(json: JSONValue?) {
            guard let o = TerrainJS.object(json) else { return nil }
            provider = TerrainJS.string(o["provider"])
            dataset = TerrainJS.string(o["dataset"])
            retrievedAt = TerrainJS.string(o["retrieved_at"])
            attribution = TerrainJS.string(o["attribution"])
            resolution = TerrainJS.string(o["resolution"])
            service = TerrainJS.string(o["service"])
        }
    }

    /// One packaged aerial-imagery tile, `imagery/{row}/{col}.jpg`. `raw` keeps
    /// every key as written, including ones this app does not read.
    public struct ImageryTile: Equatable, Sendable {
        public let row: Int?
        public let column: Int?
        public let file: String?
        public let bounds: Bounds?
        public let sha256: String?
        public let bytes: Int?
        public let raw: [String: JSONValue]

        public init(json: JSONValue) {
            let o = TerrainJS.object(json) ?? [:]
            row = TerrainJS.int(o["row"])
            column = TerrainJS.int(o["column"])
            file = TerrainJS.string(o["file"])
            bounds = Bounds(json: o["bounds"])
            sha256 = TerrainJS.string(o["sha256"])
            bytes = TerrainJS.int(o["bytes"])
            raw = o
        }
    }

    /// One optional context layer (roads, imagery, overview, road cross-section).
    /// Fields of the wrong JSON type read as nil, as the app's `typeof` checks do.
    public struct ContextLayer: Equatable, Sendable {
        public let available: Bool?
        public let file: String?
        public let sha256: String?
        public let bytes: Int?
        public let reason: String?
        public let width: Int?
        public let height: Int?
        /// Roads: how many features are packaged.
        public let featureCount: Int?
        /// Roads: the distinct feature kinds (road_bearing, road_inventory, road_centerline).
        public let roadKinds: [String]?
        public let source: LayerSource?
        /// Imagery: "tiled" for the multi-tile format; legacy single images have `file`.
        public let format: String?
        public let tileSizePx: Int?
        public let columns: Int?
        public let rows: Int?
        public let tileCount: Int?
        public let targetMetersPerPixel: Double?
        public let effectiveMetersPerPixel: Double?
        public let bounds: Bounds?
        public let tiles: [ImageryTile]?
        /// Road cross-section usability flags (newer packages).
        public let layoutSource: String?
        public let layoutSourceLabel: String?
        public let snapAvailable: Bool?
        public let orientationAvailable: Bool?
        public let fullyUsable: Bool?
        /// Roads: the external query finished (whether or not it found anything).
        public let queryCompleted: Bool?
        public let raw: [String: JSONValue]

        public init(json: JSONValue) {
            let o = TerrainJS.object(json) ?? [:]
            available = TerrainJS.bool(o["available"])
            file = TerrainJS.string(o["file"])
            sha256 = TerrainJS.string(o["sha256"])
            bytes = TerrainJS.int(o["bytes"])
            reason = TerrainJS.string(o["reason"])
            width = TerrainJS.int(o["width"])
            height = TerrainJS.int(o["height"])
            featureCount = TerrainJS.int(o["feature_count"])
            if case .array(let kinds)? = o["road_kinds"] { roadKinds = kinds.compactMap(TerrainJS.string) } else { roadKinds = nil }
            source = LayerSource(json: o["source"])
            format = TerrainJS.string(o["format"])
            tileSizePx = TerrainJS.int(o["tile_size_px"])
            columns = TerrainJS.int(o["columns"])
            rows = TerrainJS.int(o["rows"])
            tileCount = TerrainJS.int(o["tile_count"])
            targetMetersPerPixel = TerrainJS.double(o["target_meters_per_pixel"])
            effectiveMetersPerPixel = TerrainJS.double(o["effective_meters_per_pixel"])
            bounds = Bounds(json: o["bounds"])
            if case .array(let items)? = o["tiles"] { tiles = items.map(ImageryTile.init(json:)) } else { tiles = nil }
            layoutSource = TerrainJS.string(o["layout_source"])
            layoutSourceLabel = TerrainJS.string(o["layout_source_label"])
            snapAvailable = TerrainJS.bool(o["snap_available"])
            orientationAvailable = TerrainJS.bool(o["orientation_available"])
            fullyUsable = TerrainJS.bool(o["fully_usable"])
            queryCompleted = TerrainJS.bool(o["query_completed"])
            raw = o
        }
    }

    /// The elevation source a package was built from.
    public struct Elevation: Equatable, Sendable {
        public let source: String?
        public let dataset: String?
        public let version: String?
        public let resolution: String?
    }

    /// The named context layers a bundle may carry, in the order they are checked.
    public enum LayerName: String, CaseIterable, Sendable {
        case roads, imagery, overview
        case roadCrossSection = "road_cross_section"
    }

    /// How a package carries aerial imagery.
    public enum ImageryMode: String, Sendable {
        /// High-definition JPEG tiles.
        case tiled
        /// One legacy imagery.png.
        case single
    }

    /// manifest.json. `terrain` is set only when the terrain block is valid;
    /// `json` keeps the manifest exactly as written.
    public struct Manifest: Decodable, Equatable, Sendable {
        public let format: String?
        public let formatVersion: Double?
        public let terrain: TerrainMeta?
        public let elevation: Elevation?
        public let contextLayers: [String: ContextLayer]?
        /// The `files` block's file names (string values only).
        public let files: [String: String]?
        public let json: JSONValue

        public init(json: JSONValue) {
            let o = TerrainJS.object(json) ?? [:]
            format = TerrainJS.string(o["format"])
            formatVersion = TerrainJS.double(o["format_version"])
            terrain = TerrainMeta(json: o["terrain"])
            if let e = TerrainJS.object(o["elevation"]) {
                elevation = Elevation(source: TerrainJS.string(e["source"]), dataset: TerrainJS.string(e["dataset"]),
                                      version: TerrainJS.string(e["version"]), resolution: TerrainJS.string(e["resolution"]))
            } else {
                elevation = nil
            }
            contextLayers = TerrainJS.object(o["context_layers"]).map { layers in
                layers.compactMapValues { TerrainJS.object($0) == nil ? nil : ContextLayer(json: $0) }
            }
            files = TerrainJS.object(o["files"]).map { $0.compactMapValues(TerrainJS.string) }
            self.json = json
        }

        public init(from decoder: Decoder) throws {
            self.init(json: try JSONValue(from: decoder))
        }

        public func layer(_ name: LayerName) -> ContextLayer? { contextLayers?[name.rawValue] }
    }

    /// road_cross_section.json: the roadway layout (widths in feet), route and
    /// post miles, and upstation direction, so the Cross Section tool works
    /// offline. Elevation comes from the terrain grid, not from here.
    public struct RoadCrossSectionContext: Decodable, Equatable, Sendable {
        public struct Centerline: Decodable, Equatable, Sendable {
            public let type: String
            public let coordinates: JSONValue?
        }

        public let attributes: [String: JSONValue]
        public let routeName: String?
        public let countyCode: String?
        public let beginPm: Double?
        public let endPm: Double?
        public let upstationBearingDeg: Double?
        public let postmileIncreasesUpstation: Bool?
        /// ROAD_INVENTORY, FORM_FIELDS or DEFAULT.
        public let source: String
        public let centerline: Centerline?

        enum CodingKeys: String, CodingKey {
            case attributes, source, centerline
            case routeName = "route_name", countyCode = "county_code", beginPm = "begin_pm", endPm = "end_pm"
            case upstationBearingDeg = "upstation_bearing_deg", postmileIncreasesUpstation = "postmile_increases_upstation"
        }
    }

    /// Whether the offline Cross Section tool can be used, and why not. Fully
    /// usable only with a roadway layout and a way to snap (road geometry) or
    /// orient (upstation bearing).
    public struct RoadCrossSectionUsability: Equatable, Sendable {
        public let layoutAvailable: Bool
        public let layoutSource: String?
        public let layoutSourceLabel: String?
        public let snapAvailable: Bool
        public let orientationAvailable: Bool
        public let fullyUsable: Bool
        /// no_road_snap_geometry, no_upstation_bearing, default_layout_only, or nil.
        public let reason: String?
    }

    /// The unpacked, checked bundle: the manifest, its terrain block, and each file's bytes by name.
    public struct Extracted: Equatable, Sendable {
        public let manifest: Manifest
        public let terrain: TerrainMeta
        public let files: [String: [UInt8]]
    }

    // MARK: - ZIP

    static let sigEOCD: UInt32 = 0x0605_4b50
    static let sigCEN: UInt32 = 0x0201_4b50
    static let sigLOC: UInt32 = 0x0403_4b50
    /// What JavaScript's DataView says when a read runs off the end.
    static let outOfBounds = "Offset is outside the bounds of the DataView"

    static func u16(_ bytes: [UInt8], _ at: Int) throws -> Int {
        guard at >= 0, at + 2 <= bytes.count else { throw BundleError(outOfBounds) }
        return Int(bytes[at]) | Int(bytes[at + 1]) << 8
    }

    static func u32(_ bytes: [UInt8], _ at: Int) throws -> UInt32 {
        guard at >= 0, at + 4 <= bytes.count else { throw BundleError(outOfBounds) }
        let b0 = UInt32(bytes[at]), b1 = UInt32(bytes[at + 1]) << 8
        let b2 = UInt32(bytes[at + 2]) << 16, b3 = UInt32(bytes[at + 3]) << 24
        return b0 | b1 | b2 | b3
    }

    private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xedb8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    /// CRC-32 (IEEE), as ZIP headers record it.
    public static func crc32(_ bytes: [UInt8]) -> UInt32 {
        var c: UInt32 = 0xffff_ffff
        for b in bytes { c = crcTable[Int((c ^ UInt32(b)) & 0xff)] ^ (c >> 8) }
        return c ^ 0xffff_ffff
    }

    /// True for entry names that could escape the extraction folder: absolute,
    /// drive-letter, `..` or empty path parts, or longer than 255.
    public static func isUnsafeEntryName(_ name: String) -> Bool {
        if name.isEmpty || name.utf16.count > 255 { return true }
        if name.hasPrefix("/") || name.hasPrefix("\\") { return true }
        let scalars = Array(name.unicodeScalars.prefix(2))
        if scalars.count == 2, scalars[1] == ":", scalars[0].isASCII,
           ("a"..."z").contains(scalars[0]) || ("A"..."Z").contains(scalars[0]) { return true }
        let parts = name.split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }
        return parts.contains { $0 == ".." || $0.isEmpty }
    }

    /// The central directory's entries.
    public static func parseZipEntries(_ bytes: [UInt8]) throws -> [ZipEntry] {
        var eocd = -1
        let minScan = max(0, bytes.count - 22 - 65536)
        var i = bytes.count - 22
        while i >= minScan {
            if try u32(bytes, i) == sigEOCD {
                eocd = i
                break
            }
            i -= 1
        }
        guard eocd >= 0 else { throw BundleError("not a valid package archive (no EOCD)") }
        let total = try u16(bytes, eocd + 10)
        var off = Int(try u32(bytes, eocd + 16))
        var entries: [ZipEntry] = []
        for _ in 0..<total {
            guard off + 46 <= bytes.count, try u32(bytes, off) == sigCEN else { throw BundleError("corrupt central directory") }
            let method = try u16(bytes, off + 10)
            let crc = try u32(bytes, off + 16)
            let compSize = Int(try u32(bytes, off + 20))
            let uncompSize = Int(try u32(bytes, off + 24))
            let nameLen = try u16(bytes, off + 28)
            let extraLen = try u16(bytes, off + 30)
            let cmtLen = try u16(bytes, off + 32)
            let localOffset = Int(try u32(bytes, off + 42))
            let nameEnd = min(off + 46 + nameLen, bytes.count)
            let name = String(decoding: bytes[(off + 46)..<nameEnd], as: UTF8.self)
            entries.append(ZipEntry(name: name, method: method, crc32: crc, compSize: compSize,
                                    uncompSize: uncompSize, localOffset: localOffset))
            off += 46 + nameLen + extraLen + cmtLen
        }
        return entries
    }

    /// A STORED (method 0) entry's bytes.
    public static func readStoredEntry(_ bytes: [UInt8], _ entry: ZipEntry) throws -> [UInt8] {
        if entry.method != 0 { throw BundleError("unsupported compression method \(entry.method) (expected STORED)") }
        if try u32(bytes, entry.localOffset) != sigLOC { throw BundleError("corrupt local file header") }
        let nameLen = try u16(bytes, entry.localOffset + 26)
        let extraLen = try u16(bytes, entry.localOffset + 28)
        let start = entry.localOffset + 30 + nameLen + extraLen
        let end = start + entry.uncompSize
        if end > bytes.count { throw BundleError("entry extends past archive") }
        return Array(bytes[start..<end])
    }

    // MARK: - Context layers

    /// True when an imagery layer is the tiled (multi-tile JPEG) format.
    public static func imageryIsTiled(_ layer: ContextLayer?) -> Bool {
        guard let layer else { return false }
        return layer.available == true && layer.format == "tiled" && !(layer.tiles ?? []).isEmpty
    }

    /// How the package carries imagery, or nil when it has none.
    public static func imageryMode(_ manifest: Manifest?) -> ImageryMode? {
        guard let layer = manifest?.layer(.imagery), layer.available == true else { return nil }
        if imageryIsTiled(layer) { return .tiled }
        return TerrainJS.nonEmpty(layer.file) != nil ? .single : nil
    }

    /// The declared imagery tiles of a tiled package; empty otherwise.
    public static func imageryTiles(_ manifest: Manifest?) -> [ImageryTile] {
        let layer = manifest?.layer(.imagery)
        return imageryIsTiled(layer) ? (layer?.tiles ?? []) : []
    }

    /// Whether the Cross Section tool is usable. Newer packages say so outright;
    /// for older ones it is usable only when road geometry (to snap to) is packaged.
    public static func roadCrossSectionUsability(_ manifest: Manifest?) -> RoadCrossSectionUsability {
        let layer = manifest?.layer(.roadCrossSection)
        let roads = manifest?.layer(.roads)
        let layoutAvailable = layer?.available == true
        if let layer, layer.fullyUsable != nil {
            return RoadCrossSectionUsability(
                layoutAvailable: layoutAvailable, layoutSource: layer.layoutSource, layoutSourceLabel: layer.layoutSourceLabel,
                snapAvailable: layer.snapAvailable == true, orientationAvailable: layer.orientationAvailable == true,
                fullyUsable: layer.fullyUsable == true, reason: layer.reason)
        }
        let snapAvailable = roads?.available == true
        return RoadCrossSectionUsability(
            layoutAvailable: layoutAvailable, layoutSource: layoutAvailable ? "UNKNOWN" : nil, layoutSourceLabel: nil,
            snapAvailable: snapAvailable, orientationAvailable: false, fullyUsable: layoutAvailable && snapAvailable,
            reason: layoutAvailable && !snapAvailable ? "no_road_snap_geometry" : nil)
    }

    /// The reason token for packaged roads being unavailable, or nil when they are
    /// available. "disabled" means road context was turned off at build time.
    public static func roadsUnavailableReason(_ manifest: Manifest?) -> String? {
        let roads = manifest?.layer(.roads)
        if roads?.available == true { return nil }
        return roads?.reason ?? "no_road_context"
    }

    /// True when the road query finished and simply found no qualifying
    /// centerlines here, as opposed to a provider failure.
    public static func roadsQueryCompletedEmpty(_ manifest: Manifest?) -> Bool {
        guard let roads = manifest?.layer(.roads), roads.available != true else { return false }
        return roads.queryCompleted == true && roads.reason == "no_centerline_features_in_area"
    }

    /// Plain words for why road selection is unavailable, never internal names
    /// or raw worker text; nil when roads are available.
    public static func roadsUnavailableMessage(_ manifest: Manifest?) -> String? {
        if manifest?.layer(.roads)?.available == true { return nil }
        switch roadsUnavailableReason(manifest) {
        case "no_centerline_features_in_area":
            return "No mapped highways in this area"
        case "disabled":
            return "Road context is turned off for this package"
        case "provider_none", "provider_not_configured", "no_centerline_source_configured":
            return "No road data source is configured"
        case "source_error":
            return "Road data was unavailable when this package was built"
        case "incomplete_source":
            return "Road data was incomplete and was not included"
        case "too_large":
            return "Road data exceeded the package size limit"
        case "no_road_inventory_geometry", "no_road_bearing", "no_road_data", "no_road_context":
            return "No road context is available for this package"
        default:
            return "Road context is unavailable"
        }
    }

    /// Whether the road cross-section context is packaged.
    public static func roadCrossSectionAvailable(_ manifest: Manifest?) -> Bool {
        contextLayerAvailable(manifest, .roadCrossSection)
    }

    /// Whether a context layer is packaged and declared available. A missing
    /// layer is unavailable, never corrupt.
    public static func contextLayerAvailable(_ manifest: Manifest?, _ name: LayerName) -> Bool {
        guard let layer = manifest?.layer(name), layer.available == true else { return false }
        if name == .imagery && imageryIsTiled(layer) { return true }
        return TerrainJS.nonEmpty(layer.file) != nil
    }

    /// Why a layer is unavailable, or nil when it is available.
    public static func contextLayerReason(_ manifest: Manifest?, _ name: LayerName) -> String? {
        if contextLayerAvailable(manifest, name) { return nil }
        return TerrainJS.nonEmpty(manifest?.layer(name)?.reason) ?? "unavailable"
    }

    static func layerSourceLabel(_ layer: ContextLayer?) -> String? {
        guard let s = layer?.source else { return nil }
        return TerrainJS.nonEmpty(s.attribution) ?? TerrainJS.nonEmpty(s.dataset) ?? TerrainJS.nonEmpty(s.provider)
    }

    /// What a package's surface and overlays are, for the status pill and the
    /// package details: tells hillshade relief apart from real aerial imagery.
    public static func summarizeContextLayers(_ manifest: Manifest?) -> OfflineScene.ContextLayersSummary {
        let layers = manifest?.contextLayers ?? [:]
        var attribution: [String] = []
        for name in LayerName.allCases {
            if let a = TerrainJS.nonEmpty(layers[name.rawValue]?.source?.attribution), !attribution.contains(a) {
                attribution.append(a)
            }
        }
        let mode = imageryMode(manifest)
        let imagery = layers[LayerName.imagery.rawValue]
        let roads = layers[LayerName.roads.rawValue]
        return OfflineScene.ContextLayersSummary(
            hillshade: TerrainJS.nonEmpty(manifest?.files?["hillshade"]) != nil,
            roads: contextLayerAvailable(manifest, .roads),
            imagery: contextLayerAvailable(manifest, .imagery),
            overview: contextLayerAvailable(manifest, .overview),
            roadsReason: contextLayerReason(manifest, .roads),
            imageryReason: contextLayerReason(manifest, .imagery),
            elevationSource: manifest?.elevation?.source,
            imagerySource: layerSourceLabel(imagery),
            roadSource: layerSourceLabel(roads),
            roadContext: OfflineScene.describeRoadContext(roads),
            roadFeatureCount: roads?.featureCount,
            attribution: attribution,
            imageryMode: mode,
            imageryTileCount: mode == .tiled ? (imagery?.tileCount ?? imageryTiles(manifest).count) : nil,
            imageryEffectiveMpp: mode == .tiled ? imagery?.effectiveMetersPerPixel : nil)
    }

    // MARK: - Validation

    static func isHex64(_ text: String) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x41...0x46).contains($0) || (0x61...0x66).contains($0) }
    }

    /// Checks the terrain block: grid size, float32 little-endian metres, finite
    /// values, a SHA-256, bounds, and a transform that agrees with them.
    public static func validateTerrainMeta(_ t: JSONValue?) -> Validation {
        let m: [String: JSONValue]
        switch t {
        case .object(let o)?: m = o
        case .array?: m = [:]
        default: return .invalid("missing terrain metadata")
        }
        let rows = TerrainJS.number(m["rows"])
        let cols = TerrainJS.number(m["columns"])
        if !TerrainJS.isInteger(rows) || !TerrainJS.isInteger(cols) || rows < 2 || cols < 2 || rows > 4096 || cols > 4096 {
            return .invalid("invalid terrain dimensions")
        }
        if m["encoding"] != .string("float32") { return .invalid("unsupported terrain encoding") }
        if m["byte_order"] != .string("little") { return .invalid("terrain byte_order must be little") }
        if m["vertical_units"] != .string("meters") { return .invalid("terrain vertical_units must be meters") }
        if TerrainJS.finite(m["no_data_value"]) == nil { return .invalid("invalid no_data_value") }
        guard let minE = TerrainJS.finite(m["min_elevation_m"]), let maxE = TerrainJS.finite(m["max_elevation_m"]), !(minE > maxE)
        else { return .invalid("invalid min/max elevation") }
        guard let sha = TerrainJS.string(m["sha256"]), isHex64(sha) else {
            return .invalid("missing or malformed terrain sha256")
        }
        let b = TerrainJS.object(m["bounds"]) ?? [:]
        guard let minLat = TerrainJS.finite(b["min_lat"]), let minLon = TerrainJS.finite(b["min_lon"]),
              let maxLat = TerrainJS.finite(b["max_lat"]), let maxLon = TerrainJS.finite(b["max_lon"]),
              !(minLat >= maxLat), !(minLon >= maxLon)
        else { return .invalid("invalid terrain bounds") }
        let lt = TerrainJS.object(m["local_transform"]) ?? [:]
        guard let originLon = TerrainJS.finite(lt["origin_lon"]), let originLat = TerrainJS.finite(lt["origin_lat"]),
              let lonPerCol = TerrainJS.finite(lt["lon_per_col"]), let latPerRow = TerrainJS.finite(lt["lat_per_row"])
        else { return .invalid("invalid local_transform") }
        if !(lonPerCol > 0) { return .invalid("local_transform lon_per_col must be positive") }
        if !(latPerRow < 0) { return .invalid("local_transform lat_per_row must be negative") }
        // Row 0 is the north edge (origin = NW corner); columns step east, rows step south.
        let expLonPerCol = (maxLon - minLon) / (cols - 1)
        let expLatPerRow = -(maxLat - minLat) / (rows - 1)
        func tol(_ v: Double) -> Double { abs(v) * 1e-3 + 1e-9 }
        if abs(originLon - minLon) > tol(maxLon - minLon) || abs(originLat - maxLat) > tol(maxLat - minLat)
            || abs(lonPerCol - expLonPerCol) > tol(expLonPerCol) || abs(latPerRow - expLatPerRow) > tol(expLatPerRow) {
            return .invalid("local_transform inconsistent with bounds/dimensions")
        }
        return .valid
    }

    /// Checks the manifest: an eristerrain bundle, format version 2 or later,
    /// USGS 3DEP elevation, and a sound terrain block.
    public static func validateBundleManifest(_ m: JSONValue?) -> Validation {
        let man: [String: JSONValue]
        switch m {
        case .object(let o)?: man = o
        case .array?: man = [:]
        default: return .invalid("missing manifest")
        }
        if man["format"] != .string("eristerrain") { return .invalid("not an eristerrain bundle") }
        let version: JSONValue = (man["format_version"] == nil || man["format_version"] == .null) ? .number(0) : man["format_version"]!
        if TerrainJS.number(version) < 2 { return .invalid("unsupported manifest format_version") }
        if TerrainJS.object(man["elevation"])?["source"] != .string("USGS_3DEP") {
            return .invalid("elevation source is not USGS_3DEP")
        }
        return validateTerrainMeta(man["terrain"])
    }

    // MARK: - Extraction

    /// Unpacks and checks a bundle: refuses unsafe names, checks each entry's
    /// CRC-32, the manifest and terrain block, the grid's byte length, and every
    /// context asset the manifest declares available. Throws on any failure.
    public static func extractAndValidateBundle(_ bytes: [UInt8]) throws -> Extracted {
        let entries = try parseZipEntries(bytes)
        for entry in entries where isUnsafeEntryName(entry.name) {
            throw BundleError("unsafe archive entry: \(entry.name)")
        }
        var byName: [String: ZipEntry] = [:]
        for entry in entries { byName[entry.name] = entry }

        guard let manEntry = byName["manifest.json"] else { throw BundleError("missing manifest.json") }
        let manBytes = try readStoredEntry(bytes, manEntry)
        if crc32(manBytes) != manEntry.crc32 { throw BundleError("manifest checksum mismatch") }
        let json: JSONValue
        do {
            json = try JSONDecoder().decode(JSONValue.self, from: Data(manBytes))
        } catch {
            throw BundleError("malformed manifest.json")
        }
        let validation = validateBundleManifest(json)
        if !validation.ok { throw BundleError(validation.reason ?? "invalid manifest") }
        let manifest = Manifest(json: json)
        guard let terrain = manifest.terrain else { throw BundleError("invalid manifest") }

        let gridName = terrain.file.isEmpty ? "elevation-grid.bin" : terrain.file
        guard let gridEntry = byName[gridName] else { throw BundleError("missing terrain grid \(gridName)") }
        let gridBytes = try readStoredEntry(bytes, gridEntry)
        if gridBytes.count != terrain.rows * terrain.columns * 4 {
            throw BundleError("terrain grid byte length does not match dimensions")
        }
        if crc32(gridBytes) != gridEntry.crc32 { throw BundleError("terrain grid checksum mismatch") }

        var files: [String: [UInt8]] = [:]
        files["manifest.json"] = manBytes
        files[gridName] = gridBytes
        // Optional entries must still pass CRC if present: a corrupt one fails the bundle.
        for name in ["hillshade.png", "overlays.json"] {
            if let entry = byName[name] {
                let data = try readStoredEntry(bytes, entry)
                if crc32(data) != entry.crc32 { throw BundleError("\(name) checksum mismatch") }
                files[name] = data
            }
        }

        // Every layer declared available must be present, pass CRC and match its
        // declared size; an absent layer is just unavailable.
        func extractAsset(_ fileName: String?, _ label: String) throws {
            guard let fileName, !fileName.isEmpty else { throw BundleError("\(label) available but has no file") }
            if isUnsafeEntryName(fileName) { throw BundleError("unsafe archive entry: \(fileName)") }
            guard let entry = byName[fileName] else { throw BundleError("missing context asset \(fileName)") }
            let data = try readStoredEntry(bytes, entry)
            if crc32(data) != entry.crc32 { throw BundleError("context asset \(fileName) checksum mismatch") }
            files[fileName] = data
        }
        let layers = manifest.contextLayers ?? [:]
        for name in LayerName.allCases {
            guard let layer = layers[name.rawValue], layer.available == true else { continue }
            if name == .imagery && imageryIsTiled(layer) {
                let tiles = layer.tiles ?? []
                let cols = TerrainJS.number(layer.raw["columns"])
                let rows = TerrainJS.number(layer.raw["rows"])
                if TerrainJS.isInteger(cols) && TerrainJS.isInteger(rows) && cols * rows != Double(tiles.count) {
                    throw BundleError("imagery tile count does not match columns*rows")
                }
                for tile in tiles {
                    let label = "imagery tile (\(TerrainJS.template(tile.raw["row"])),\(TerrainJS.template(tile.raw["column"])))"
                    try extractAsset(tile.file, label)
                    if case .number(let declared)? = tile.raw["bytes"], let file = tile.file,
                       Double(files[file]?.count ?? 0) != declared {
                        throw BundleError("imagery tile \(file) size mismatch")
                    }
                }
                continue
            }
            try extractAsset(layer.file, "context layer \(name.rawValue)")
            if case .number(let declared)? = layer.raw["bytes"], let file = layer.file,
               Double(files[file]?.count ?? 0) != declared {
                throw BundleError("context asset \(file) size mismatch")
            }
        }
        return Extracted(manifest: manifest, terrain: terrain, files: files)
    }

    /// `extractAndValidateBundle` for the package as read from disk.
    public static func extractAndValidateBundle(_ data: Data) throws -> Extracted {
        try extractAndValidateBundle([UInt8](data))
    }

    // MARK: - Height grid

    /// The float32 little-endian height grid, row by row (no-data values kept).
    public static func decodeHeightGrid(_ data: [UInt8], rows: Int, cols: Int) throws -> [Float] {
        if data.count != rows * cols * 4 { throw BundleError("height grid size mismatch") }
        var out = [Float](repeating: 0, count: rows * cols)
        for i in 0..<out.count {
            let at = i * 4
            let b0 = UInt32(data[at]), b1 = UInt32(data[at + 1]) << 8
            let b2 = UInt32(data[at + 2]) << 16, b3 = UInt32(data[at + 3]) << 24
            out[i] = Float(bitPattern: b0 | b1 | b2 | b3)
        }
        return out
    }

    /// Grid (col, row) to lon/lat through the manifest's local transform.
    public static func gridCellToLonLat(_ t: TerrainMeta, col: Double, row: Double) -> (lon: Double, lat: Double) {
        let lt = t.localTransform
        return (lt.originLon + col * lt.lonPerCol, lt.originLat + row * lt.latPerRow)
    }

    /// The grid cell nearest a lon/lat (Math.round of the fractional cell).
    public static func lonLatToGridCell(_ t: TerrainMeta, lon: Double, lat: Double) -> (col: Double, row: Double) {
        let lt = t.localTransform
        return (TerrainJS.mathRound((lon - lt.originLon) / lt.lonPerCol), TerrainJS.mathRound((lat - lt.originLat) / lt.latPerRow))
    }
}

/// The JavaScript semantics the terrain ports rely on: `Number(value)`,
/// `typeof` checks on parsed JSON, truthiness, `Math.round` and `toFixed`.
enum TerrainJS {
    static func object(_ value: JSONValue?) -> [String: JSONValue]? {
        if case .object(let o)? = value { return o }
        return nil
    }

    static func string(_ value: JSONValue?) -> String? {
        if case .string(let s)? = value { return s }
        return nil
    }

    static func bool(_ value: JSONValue?) -> Bool? {
        if case .bool(let b)? = value { return b }
        return nil
    }

    /// Any number (`typeof value === "number"`).
    static func double(_ value: JSONValue?) -> Double? {
        if case .number(let n)? = value { return n }
        return nil
    }

    /// A finite number (`Number.isFinite`).
    static func finite(_ value: JSONValue?) -> Double? {
        guard let n = double(value), n.isFinite else { return nil }
        return n
    }

    /// A whole number that fits an Int.
    static func int(_ value: JSONValue?) -> Int? {
        guard let n = double(value), isInteger(n), abs(n) <= 9_007_199_254_740_991 else { return nil }
        return Int(n)
    }

    static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }
        return text
    }

    /// `Number(value)`: NaN where JavaScript gives NaN.
    static func number(_ value: JSONValue?) -> Double {
        switch value {
        case .none: return .nan
        case .null?: return 0
        case .bool(let b)?: return b ? 1 : 0
        case .number(let n)?: return n
        case .string(let s)?:
            if s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return 0 }
            return JS.number(s) ?? .nan
        case .array(let items)?:
            if items.isEmpty { return 0 }
            if items.count == 1 { return number(.string(JS.string(items[0]))) }
            return .nan
        case .object?: return .nan
        }
    }

    /// `Number.isInteger`.
    static func isInteger(_ n: Double) -> Bool { n.isFinite && n.rounded(.towardZero) == n }

    /// `!!value` for a parsed JSON value.
    static func truthy(_ value: JSONValue?) -> Bool {
        switch value {
        case .none, .null?: return false
        case .bool(let b)?: return b
        case .number(let n)?: return n != 0 && !n.isNaN
        case .string(let s)?: return !s.isEmpty
        case .array?, .object?: return true
        }
    }

    /// `${value}` in a template string.
    static func template(_ value: JSONValue?) -> String {
        switch value {
        case .none: return "undefined"
        case .null?: return "null"
        default: return JS.string(value)
        }
    }

    /// `Math.round`: the nearest integer, halves rounding up.
    static func mathRound(_ x: Double) -> Double {
        guard x.isFinite else { return x }
        let down = x.rounded(.down)
        return x - down >= 0.5 ? down + 1 : down
    }

    /// `Number.prototype.toFixed`: halves round away from zero on the exact
    /// binary value (printf would round them to even).
    static func toFixed(_ x: Double, _ digits: Int) -> String {
        if x.isNaN { return "NaN" }
        if abs(x) >= 1e21 || x.isInfinite { return x.isInfinite ? (x < 0 ? "-Infinity" : "Infinity") : JS.numberText(x) }
        let negative = x < 0
        let exact = String(format: "%.120f", abs(x))
        let parts = exact.split(separator: ".", omittingEmptySubsequences: false)
        var whole = Array(parts[0])
        let fraction = parts.count > 1 ? Array(parts[1]) : []
        var kept = whole + Array(fraction.prefix(digits))
        while kept.count < whole.count + digits { kept.append("0") }
        if digits < fraction.count, let next = fraction[digits].wholeNumberValue, next >= 5 {
            var i = kept.count - 1
            while i >= 0 {
                if kept[i] == "9" {
                    kept[i] = "0"
                    i -= 1
                } else {
                    kept[i] = Character(String(kept[i].wholeNumberValue! + 1))
                    break
                }
            }
            if i < 0 {
                kept.insert("1", at: 0)
                whole.insert("1", at: 0)
            }
        }
        let intPart = String(kept[0..<whole.count])
        let fracPart = String(kept[whole.count...])
        return (negative ? "-" : "") + (digits > 0 ? "\(intPart).\(fracPart)" : intPart)
    }
}
