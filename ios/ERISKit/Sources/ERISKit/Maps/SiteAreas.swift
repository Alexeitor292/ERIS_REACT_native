import Foundation

/// Site areas drawn on the technical form's location map: each a GeoJSON
/// polygon (rings of [lon, lat], WGS84); a form's areas are stored in
/// `geometry_json` as one Polygon or a MultiPolygon, as the web writes them.
/// Ported from web/src/components/siteAreasModel.ts.
public enum SiteAreas {
    public typealias Position = [Double]
    public typealias Ring = [Position]
    /// A polygon: its outer ring, then any holes.
    public typealias Area = [Ring]

    static let earthRadius = 6_378_137.0
    static let sqMPerAcre = 4_046.8564224
    static let sqFtPerSqM = 10.763910417

    /// Area enclosed by one ring on the sphere, in square metres (always positive).
    public static func ringArea(_ ring: Ring) -> Double {
        let n = ring.count
        guard n >= 3 else { return 0 }
        var total = 0.0
        for i in 0..<n {
            let a = ring[i], b = ring[(i + 1) % n]
            guard a.count >= 2, b.count >= 2 else { continue }
            total += (b[0] - a[0]) * .pi / 180 * (2 + sin(a[1] * .pi / 180) + sin(b[1] * .pi / 180))
        }
        return abs(total * earthRadius * earthRadius / 2)
    }

    /// A polygon's area: its outer ring less its holes.
    public static func area(_ rings: Area) -> Double {
        guard let outer = rings.first else { return 0 }
        return max(0, ringArea(outer) - rings.dropFirst().map(ringArea).reduce(0, +))
    }

    /// The polygons in a stored geometry; lines and points are not areas.
    public static func areas(fromGeoJSON value: JSONValue?) -> [Area] {
        guard case .object(let geometry)? = value else { return [] }
        let type = JS.string(geometry["type"]).lowercased()
        switch type {
        case "polygon":
            let area = rings(geometry["coordinates"])
            return area.isEmpty ? [] : [area]
        case "multipolygon":
            guard case .array(let polygons)? = geometry["coordinates"] else { return [] }
            return polygons.map(rings).filter { !$0.isEmpty }
        case "geometrycollection":
            guard case .array(let parts)? = geometry["geometries"] else { return [] }
            return parts.flatMap { areas(fromGeoJSON: $0) }
        default:
            return []
        }
    }

    /// The areas in `geometry_json` as the form stores it (text).
    public static func areas(fromText text: String) -> [Area] {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let value = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return [] }
        return areas(fromGeoJSON: value)
    }

    /// How a set of areas is stored: nothing, one Polygon, or a MultiPolygon.
    public static func geoJSON(_ areas: [Area]) -> JSONValue? {
        let kept = areas.filter { ($0.first?.count ?? 0) >= 4 }
        guard !kept.isEmpty else { return nil }
        func encode(_ area: Area) -> JSONValue { .array(area.map { .array($0.map { .array($0.map(JSONValue.number)) }) }) }
        if kept.count == 1 { return .object(["type": .string("Polygon"), "coordinates": encode(kept[0])]) }
        return .object(["type": .string("MultiPolygon"), "coordinates": .array(kept.map(encode))])
    }

    /// The text `geometry_json` holds for these areas ("" for none).
    public static func text(_ areas: [Area]) -> String {
        guard let value = geoJSON(areas) else { return "" }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }

    /// "5,020 m² · 1.24 ac" for large areas, "650 m² · 6,997 ft²" for small ones.
    public static func format(_ sqm: Double) -> String {
        let metric = "\(grouped(sqm.rounded())) m²"
        if sqm >= sqMPerAcre / 4 {
            let acres = (sqm / sqMPerAcre * 100).rounded() / 100
            return "\(metric) · \(JS.numberText(acres)) ac"
        }
        return "\(metric) · \(grouped((sqm * sqFtPerSqM).rounded())) ft²"
    }

    /// "2 areas · 5,020 m² · 1.24 ac", or "No areas drawn".
    public static func summary(_ areas: [Area]) -> String {
        guard !areas.isEmpty else { return "No areas drawn" }
        let total = areas.map(area).reduce(0, +)
        return "\(areas.count) \(areas.count == 1 ? "area" : "areas") · \(format(total))"
    }

    private static func rings(_ value: JSONValue?) -> Area {
        guard case .array(let rings)? = value else { return [] }
        return rings.compactMap { ring -> Ring? in
            guard case .array(let positions) = ring else { return nil }
            return positions.compactMap { position -> Position? in
                guard case .array(let numbers) = position else { return nil }
                let values = numbers.compactMap { value -> Double? in if case .number(let n) = value { return n } else { return nil } }
                return values.count >= 2 ? values : nil
            }
        }.filter { !$0.isEmpty }
    }

    private static func grouped(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? String(Int(value))
    }
}
