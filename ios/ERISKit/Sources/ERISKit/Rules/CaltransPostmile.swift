import Foundation

/// District / County / Route / Post mile for a point, from Caltrans's public
/// SHN Postmiles (tenth-mile) layer. Ported from queryPostmileLayer in
/// mobile/src/utils/arcgisEnrichment.ts and the normalizers in precision.ts.
public struct RoadLocation: Equatable, Sendable {
    public let district: String
    public let county: String
    public let route: String
    public let postMile: String
    /// Distance from the point to the postmile marker used.
    public let distanceMeters: Double
}

public enum CaltransPostmile {
    public static let defaultLayer = URL(string:
        "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/SHN_Postmiles_Tenth/FeatureServer/0")!

    /// The query for postmile markers within `radiusMeters` of the point.
    public static func queryURL(latitude: Double, longitude: Double, radiusMeters: Int = 3000,
                                layer: URL = defaultLayer) -> URL {
        var components = URLComponents(url: layer.appendingPathComponent("query"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "f", value: "json"),
            URLQueryItem(name: "where", value: "1=1"),
            URLQueryItem(name: "geometry", value: "\(longitude),\(latitude)"),
            URLQueryItem(name: "geometryType", value: "esriGeometryPoint"),
            URLQueryItem(name: "inSR", value: "4326"),
            URLQueryItem(name: "spatialRel", value: "esriSpatialRelIntersects"),
            URLQueryItem(name: "distance", value: String(radiusMeters)),
            URLQueryItem(name: "units", value: "esriSRUnit_Meter"),
            URLQueryItem(name: "outFields", value: "District,County,Route,PMPrefix,PM,PMSuffix"),
            URLQueryItem(name: "returnGeometry", value: "true"),
            URLQueryItem(name: "outSR", value: "4326"),
            URLQueryItem(name: "resultRecordCount", value: "60"),
        ]
        return components.url!
    }

    /// The nearest marker in a layer query response, or nil.
    public static func nearest(in response: Data, latitude: Double, longitude: Double) -> RoadLocation? {
        guard let object = try? JSONSerialization.jsonObject(with: response) as? [String: Any],
              let features = object["features"] as? [[String: Any]] else { return nil }
        var best: RoadLocation?
        for feature in features {
            guard let attributes = feature["attributes"] as? [String: Any],
                  let geometry = feature["geometry"] as? [String: Any],
                  let x = number(geometry["x"]), let y = number(geometry["y"]),
                  let district = twoDigitDistrict(attributes["District"]),
                  let county = (attributes["County"] as? String)?.trimmingCharacters(in: .whitespaces).uppercased(),
                  !county.isEmpty,
                  let route = normalizedRoute(attributes["Route"]),
                  let postMile = normalizedPostMile(attributes["PM"])
            else { continue }
            let prefix = ((attributes["PMPrefix"] as? String) ?? "").trimmingCharacters(in: .whitespaces).uppercased()
            let suffix = ((attributes["PMSuffix"] as? String) ?? "").trimmingCharacters(in: .whitespaces).uppercased()
            let distance = distanceMeters(latitude, longitude, y, x)
            if best == nil || distance < best!.distanceMeters {
                best = RoadLocation(district: district, county: county, route: route,
                                    postMile: prefix + postMile + suffix, distanceMeters: distance)
            }
        }
        return best
    }

    /// "4" -> "04". Ported from toTwoDigitDistrict.
    public static func twoDigitDistrict(_ value: Any?) -> String? {
        guard let value else { return nil }
        let digits = String(describing: value).filter(\.isNumber)
        guard !digits.isEmpty, let number = Int(digits.prefix(2)) else { return nil }
        return String(format: "%02d", number)
    }

    /// "80" -> "080", "I-5" -> "005". Ported from normalizeRouteValue.
    public static func normalizedRoute(_ value: Any?) -> String? {
        guard let value else { return nil }
        let raw = String(describing: value).trimmingCharacters(in: .whitespaces)
        if raw.isEmpty { return nil }
        let digits = raw.filter(\.isNumber)
        if digits.isEmpty { return raw }
        let first = String(digits.prefix(3))
        return String(repeating: "0", count: max(0, 3 - first.count)) + first
    }

    /// 12.345 -> "12.35" (two decimals). Ported from normalizePostMileValue.
    public static func normalizedPostMile(_ value: Any?) -> String? {
        guard let value, let number = number(value) else { return nil }
        return String(format: "%.2f", (number * 100).rounded() / 100)
    }

    static func number(_ value: Any?) -> Double? {
        switch value {
        case let value as Double: return value.isFinite ? value : nil
        case let value as Int: return Double(value)
        case let value as NSNumber: return value.doubleValue
        case let value as String: return Double(value.trimmingCharacters(in: .whitespaces))
        default: return nil
        }
    }

    static func distanceMeters(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
        let metersPerDegree = 111_320.0
        let dy = (lat2 - lat1) * metersPerDegree
        let dx = (lon2 - lon1) * metersPerDegree * cos(lat1 * .pi / 180)
        return (dx * dx + dy * dy).squareRoot()
    }
}
