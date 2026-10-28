import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Step 2 Measurements, from the Expo GISA editor's Measurements block.
extension GisaEditor {
    /// The GISA-001 measurements, labelled as on the form's diagram.
    public static let measurementFields = [
        ("measure_slope_height_ft", "Slope Height, ft (H)"),
        ("measure_original_slope_deg", "Original Slope, deg (α)"),
        ("measure_landslide_width_ft", "Landslide Width, ft (Wd)"),
        ("measure_landslide_length_ft", "Landslide Length, ft (Ld)"),
        ("measure_main_scarp_height_ft", "Main Scarp Height, ft (Hs)"),
        ("measure_landslide_slope_deg", "Landslide Slope, deg (β)"),
        ("measure_roadway_length_ft", "Length of Roadway Encroached, ft (Lr)"),
        ("measure_roadway_width_ft", "Width of Roadway Encroached, ft (Wr)"),
    ]
}

/// The road inventory segment matched to the form's location (HICOMP), as
/// `gisa.road_inventory_context` carries it.
public struct RoadInventoryContext: Equatable, Sendable {
    public let datasetVersionId: Int?
    public let segmentId: Int?
    public let matchMethod: String?
    public let snapshot: [String: JSONValue]

    public init?(gisa: [String: JSONValue]?) {
        guard case .object(let context)? = gisa?["road_inventory_context"] else { return nil }
        func int(_ key: String) -> Int? { if case .number(let n)? = context[key] { return Int(n) } else { return nil } }
        datasetVersionId = int("dataset_version_id")
        segmentId = int("segment_id")
        matchMethod = JS.string(context["match_method"]).nilIfEmpty
        if case .object(let snapshot)? = context["snapshot"] { self.snapshot = snapshot } else { snapshot = [:] }
    }

    private func text(_ key: String) -> String? {
        guard let value = snapshot[key], value != .null else { return nil }
        return JS.string(value)
    }

    /// The summary rows the Expo card shows, each only when known.
    public var rows: [(label: String, value: String)] {
        var out: [(String, String)] = []
        if let county = text("county_code") { out.append(("County", county)) }
        if let route = text("route_name") { out.append(("Route", route)) }
        if text("begin_pm") != nil || text("end_pm") != nil {
            out.append(("Postmile range", "\(text("begin_pm") ?? "?") – \(text("end_pm") ?? "?") mi"))
        }
        if let terrain = text("terrain_code") ?? text("THY_TERRAIN_CODE") {
            out.append(("Terrain", RoadInventoryContext.terrainLabel(terrain)))
        }
        if text("left_lanes") != nil || text("right_lanes") != nil {
            out.append(("Lanes", "\(text("left_lanes").map { "\($0) LT" } ?? "? LT") / \(text("right_lanes").map { "\($0) RT" } ?? "? RT")"))
        }
        out.append(("Match method", matchMethod ?? "—"))
        return out
    }

    /// "Mountainous (M)". Ported from terrainLabel in roadInventoryGlossary.ts.
    public static func terrainLabel(_ code: String?) -> String {
        guard let code, !code.isEmpty else { return "—" }
        let upper = code.uppercased().trimmingCharacters(in: .whitespaces)
        let names = ["F": "Flat", "R": "Rolling", "M": "Mountainous", "H": "Hilly"]
        return names[upper].map { "\($0) (\(upper))" } ?? code
    }
}

/// The ground across the road at the location, sampled from USGS elevation
/// (`gisa.elevation_profile`, refreshed by `POST …/gisa/elevation-profile`).
public struct ElevationProfile: Decodable, Equatable, Sendable {
    public struct Point: Decodable, Equatable, Sendable {
        public let offsetM: Double
        public let elevationFt: Double?

        enum CodingKeys: String, CodingKey { case offsetM = "offset_m", elevationFt = "elevation_ft" }
    }

    public struct Metadata: Decodable, Equatable, Sendable {
        public let roadBearingDegUsed: Double?
        public let roadBearingSource: String?
        public let classificationReason: String?
        public let classificationNote: String?

        enum CodingKeys: String, CodingKey {
            case roadBearingDegUsed = "road_bearing_deg_used", roadBearingSource = "road_bearing_source"
            case classificationReason = "classification_reason", classificationNote = "classification_note"
        }
    }

    public struct Profile: Decodable, Equatable, Sendable {
        public let points: [Point]?
        public let metadata: Metadata?
    }

    public let source: String?
    public let checkedAt: String?
    public let classification: String?
    public let classificationReason: String?
    public let confidence: Double?
    public let profile: Profile?
    public let error: String?

    enum CodingKeys: String, CodingKey {
        case source, classification, confidence, profile, error
        case checkedAt = "checked_at", classificationReason = "classification_reason"
    }

    /// The profile saved on the form, if any.
    public init?(gisa: [String: JSONValue]?) {
        guard let value = gisa?["elevation_profile"], value != .null,
              let data = try? JSONEncoder().encode(value),
              let decoded = try? JSONDecoder().decode(ElevationProfile.self, from: data) else { return nil }
        self = decoded
    }

    /// "48° · auto-detected from map", in plain words.
    public var orientationNote: String {
        guard let bearing = profile?.metadata?.roadBearingDegUsed else {
            return "not detected yet — tap Refresh to auto-detect"
        }
        let source: String
        switch profile?.metadata?.roadBearingSource {
        case "arcgis_postmile_geometry": source = "auto-detected from map"
        case "road_inventory_snapshot": source = "from road inventory"
        case "request": source = "manual override"
        default: source = "auto-detected"
        }
        return "\(Int((bearing + 0.5).rounded(.down)))° · \(source)"
    }

    /// Why the terrain could not be classified, or nil.
    public var reasonNote: String? {
        if let note = profile?.metadata?.classificationNote { return note }
        switch classificationReason ?? profile?.metadata?.classificationReason {
        case "ROAD_BEARING_UNAVAILABLE": return "Road bearing could not be resolved, so only center elevation is available."
        case "INSUFFICIENT_VALID_SAMPLES": return "Not enough valid USGS samples on both sides to classify."
        case "AMBIGUOUS_TERRAIN": return "Terrain is mixed/ambiguous — not a single shape."
        default: return nil
        }
    }

    /// "82%", or nil.
    public var confidenceText: String? {
        confidence.map { String(format: "%.0f%%", $0 * 100) }
    }

    /// The sampled points with an elevation, in offset order.
    public var chartPoints: [Point] {
        (profile?.points ?? []).filter { $0.elevationFt != nil }.sorted { $0.offsetM < $1.offsetM }
    }

    /// A road bearing typed to override detection: blank is nil, otherwise 0 ≤ b < 360.
    public static func bearing(_ text: String) -> Result<Double?, InputProblem> {
        let raw = text.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty else { return .success(nil) }
        guard let value = Double(raw), value >= 0, value < 360 else {
            return .failure(InputProblem(message: "Bearing must be 0–359°"))
        }
        return .success(value)
    }
}

extension SubmissionsAPI {
    struct ElevationEnvelope: Decodable {
        let elevationProfile: ElevationProfile
        enum CodingKeys: String, CodingKey { case elevationProfile = "elevation_profile" }
    }

    /// Samples the ground across the road again; a bearing overrides detection.
    public func refreshElevationProfile(_ id: Int, roadBearing: Double?) async throws -> ElevationProfile {
        let body: [String: JSONValue] = ["force": .bool(true), "road_bearing_deg": roadBearing.map(JSONValue.number) ?? .null]
        return try await api.request("POST", "/submissions/\(id)/gisa/elevation-profile", body: try JSONEncoder().encode(body),
                                     preservingKeys: true, as: ElevationEnvelope.self).elevationProfile
    }
}
