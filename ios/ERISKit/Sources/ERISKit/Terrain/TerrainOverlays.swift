import Foundation

/// Ported from mobile/src/arcgis/terrainOverlays.ts. Puts the incident's
/// geometry on the 3D terrain: reads GeoJSON or Esri JSON into flat lon/lat
/// shapes (converting Web Mercator when clearly projected, never inventing a
/// coordinate), maps lon/lat to the grid and the mesh, and drops vertices
/// outside the package.
public enum TerrainOverlays {
    public struct LonLat: Equatable, Sendable {
        public var lon: Double
        public var lat: Double

        public init(_ lon: Double, _ lat: Double) {
            self.lon = lon
            self.lat = lat
        }
    }

    public enum OverlayKind: String, Sendable {
        case point, line, polygon
    }

    public struct OverlayPrimitive: Equatable, Sendable {
        public let kind: OverlayKind
        public let coords: [LonLat]

        public init(kind: OverlayKind, coords: [LonLat]) {
            self.kind = kind
            self.coords = coords
        }
    }

    /// A point in the mesh's local plane: X east, Z south.
    public struct MeshXZ: Equatable, Sendable {
        public let x: Double
        public let z: Double
    }

    static let webMercatorMax = 20_037_508.34

    static func webMercatorToLonLat(_ x: Double, _ y: Double) -> LonLat {
        let lon = (x / webMercatorMax) * 180
        var lat = (y / webMercatorMax) * 180
        lat = (180 / Double.pi) * (2 * atan(exp((lat * Double.pi) / 180)) - Double.pi / 2)
        return LonLat(lon, lat)
    }

    /// An `[x, y, ...]` coordinate as lon/lat, converted from Web Mercator when
    /// |x| > 180 or |y| > 90. Nil unless it is a finite numeric pair.
    public static func toLonLat(_ c: JSONValue?) -> LonLat? {
        guard case .array(let items)? = c, items.count >= 2 else { return nil }
        let x = TerrainJS.number(items[0])
        let y = TerrainJS.number(items[1])
        guard x.isFinite, y.isFinite else { return nil }
        if abs(x) > 180 || abs(y) > 90 { return webMercatorToLonLat(x, y) }
        return LonLat(x, y)
    }

    static func toLonLatList(_ value: JSONValue?) -> [LonLat] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap(toLonLat)
    }

    static func array(_ value: JSONValue?) -> [JSONValue]? {
        if case .array(let items)? = value { return items }
        return nil
    }

    /// GeoJSON (geometries, Feature, FeatureCollection, GeometryCollection) or
    /// Esri JSON (x/y, points, paths, rings) as flat points, lines and polygon
    /// rings. Shapes it does not know give nothing.
    public static func normalizeOverlayGeometry(_ geom: JSONValue?) -> [OverlayPrimitive] {
        let g: [String: JSONValue]
        switch geom {
        case .object(let o)?: g = o
        case .array?: g = [:]
        default: return []
        }
        let type = TerrainJS.string(g["type"])
        var out: [OverlayPrimitive] = []

        if type == "FeatureCollection" {
            for feature in array(g["features"]) ?? [] { out += normalizeOverlayGeometry(feature) }
            return out
        }
        if type == "Feature" { return normalizeOverlayGeometry(g["geometry"]) }
        if type == "GeometryCollection" {
            for geometry in array(g["geometries"]) ?? [] { out += normalizeOverlayGeometry(geometry) }
            return out
        }
        if let type, !type.isEmpty {
            let coords = g["coordinates"]
            let list = array(coords) ?? []
            switch type {
            case "Point":
                if let p = toLonLat(coords) { out.append(OverlayPrimitive(kind: .point, coords: [p])) }
            case "MultiPoint":
                for c in list {
                    if let p = toLonLat(c) { out.append(OverlayPrimitive(kind: .point, coords: [p])) }
                }
            case "LineString":
                let line = toLonLatList(coords)
                if !line.isEmpty { out.append(OverlayPrimitive(kind: .line, coords: line)) }
            case "MultiLineString":
                for part in list {
                    let line = toLonLatList(part)
                    if !line.isEmpty { out.append(OverlayPrimitive(kind: .line, coords: line)) }
                }
            case "Polygon":
                for ring in list {
                    let r = toLonLatList(ring)
                    if !r.isEmpty { out.append(OverlayPrimitive(kind: .polygon, coords: r)) }
                }
            case "MultiPolygon":
                for polygon in list {
                    for ring in array(polygon) ?? [] {
                        let r = toLonLatList(ring)
                        if !r.isEmpty { out.append(OverlayPrimitive(kind: .polygon, coords: r)) }
                    }
                }
            default:
                break
            }
            return out
        }

        // Esri JSON geometry.
        if let x = TerrainJS.double(g["x"]), let y = TerrainJS.double(g["y"]) {
            if let p = toLonLat(.array([.number(x), .number(y)])) { out.append(OverlayPrimitive(kind: .point, coords: [p])) }
        } else if let points = array(g["points"]) {
            for c in points {
                if let p = toLonLat(c) { out.append(OverlayPrimitive(kind: .point, coords: [p])) }
            }
        } else if let paths = array(g["paths"]) {
            for path in paths {
                let line = toLonLatList(path)
                if !line.isEmpty { out.append(OverlayPrimitive(kind: .line, coords: line)) }
            }
        } else if let rings = array(g["rings"]) {
            for ring in rings {
                let r = toLonLatList(ring)
                if !r.isEmpty { out.append(OverlayPrimitive(kind: .polygon, coords: r)) }
            }
        }
        return out
    }

    /// Lon/lat to the fractional grid (col, row) through the local transform.
    public static func lonLatToColRow(_ t: TerrainBundle.TerrainMeta, lon: Double, lat: Double) -> (col: Double, row: Double) {
        let lt = t.localTransform
        return ((lon - lt.originLon) / lt.lonPerCol, (lat - lt.originLat) / lt.latPerRow)
    }

    /// Grid (col, row) to the mesh's local XZ; the mesh spans ±worldSize on each axis.
    public static func colRowToMeshXZ(rows: Int, cols: Int, col: Double, row: Double, worldSize: Double) -> MeshXZ {
        let x = (col / Double(cols - 1) - 0.5) * (2 * worldSize)
        let z = (row / Double(rows - 1) - 0.5) * (2 * worldSize)
        return MeshXZ(x: x, z: z)
    }

    /// Lon/lat to the mesh's local XZ.
    public static func lonLatToMeshXZ(_ t: TerrainBundle.TerrainMeta, lon: Double, lat: Double, worldSize: Double) -> MeshXZ {
        let cell = lonLatToColRow(t, lon: lon, lat: lat)
        return colRowToMeshXZ(rows: t.rows, cols: t.columns, col: cell.col, row: cell.row, worldSize: worldSize)
    }

    /// Whether a lon/lat is on the packaged grid (edges included).
    public static func isLonLatInBounds(_ t: TerrainBundle.TerrainMeta, lon: Double, lat: Double, eps: Double = 1e-9) -> Bool {
        let cell = lonLatToColRow(t, lon: lon, lat: lat)
        return cell.col >= -eps && cell.col <= Double(t.columns - 1) + eps && cell.row >= -eps && cell.row <= Double(t.rows - 1) + eps
    }

    /// The vertices on the packaged grid; nothing is interpolated.
    public static func clipToBounds(_ t: TerrainBundle.TerrainMeta, _ coords: [LonLat]) -> [LonLat] {
        coords.filter { isLonLatInBounds(t, lon: $0.lon, lat: $0.lat) }
    }

    /// The closed rectangle around a sample extent.
    public static func sampleExtentRing(minLat: Double, minLon: Double, maxLat: Double, maxLon: Double) -> [LonLat] {
        [LonLat(minLon, minLat), LonLat(maxLon, minLat), LonLat(maxLon, maxLat), LonLat(minLon, maxLat), LonLat(minLon, minLat)]
    }
}
