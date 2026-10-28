import Foundation

/// How one GISA form field loads from the server and is sent back.
public enum GisaFieldKind: Equatable, Sendable {
    /// Free text: trimmed, null when blank.
    case text
    case route
    case postMile
    /// Six decimals; must be a number.
    case coordinate
    /// Must be a whole number.
    case integer
    /// Must be a number.
    case decimal
    /// A number from 0 to 100.
    case percent
    /// YES, NO or not set; sent as true, false or null.
    case tri
    /// YES or NO, sent as a boolean.
    case yesNo
    /// An incident type tick box: YES when the flag is set or its code is listed.
    case incidentType(code: String)
    /// One of a fixed set of values, else blank.
    case choice([String])
    /// JSON kept as text in the form; `serverKey` is the column it comes from and goes to.
    case json(serverKey: String, pretty: Bool)
}

public struct GisaField: Sendable {
    public let key: String
    public let kind: GisaFieldKind
    /// How a numeric error names the field ("Crack length must be numeric").
    public let label: String

    init(_ key: String, _ kind: GisaFieldKind, _ label: String = "") {
        self.key = key
        self.kind = kind
        self.label = label
    }
}

/// A value the server would refuse, found before saving.
public struct GisaFieldError: Error, Equatable, Sendable {
    public let key: String
    public let message: String
}

/// The GISA form as the editor holds it: every field as text, exactly as in
/// mobile/app/(tabs)/submissions/[id].tsx (`FormState`). Values are converted
/// only when loading from and saving to the server, by the field table below.
public struct GisaForm: Equatable, Sendable {
    public private(set) var values: [String: String]

    public subscript(key: String) -> String {
        get { values[key] ?? "" }
        set { values[key] = newValue }
    }

    /// Every field blank.
    public init() {
        values = Dictionary(uniqueKeysWithValues: Self.fields.map { ($0.key, "") })
    }

    // MARK: - Fields

    public static let incidentTypeCodes: [(key: String, code: String)] = [
        ("failure_rock_fall", "ROCK_FALL"), ("failure_topple", "TOPPLE"), ("failure_slide", "SLIDE"),
        ("failure_spread", "SPREAD"), ("failure_flow", "FLOW"), ("failure_compound", "COMPOUND"),
        ("failure_erosion", "EROSION"), ("failure_surficial_failure", "SURFICIAL_SLOUGHING"),
        ("failure_scoured_toe", "SCOURED_TOE"), ("failure_washout", "WASHOUT"),
    ]

    public static let fields: [GisaField] = {
        var out: [GisaField] = [
            GisaField("report_date", .text), GisaField("district", .text), GisaField("county", .text),
            GisaField("route", .route), GisaField("post_mile", .postMile), GisaField("ea", .text),
            GisaField("project_id", .text), GisaField("date_incident_reported", .text),
            GisaField("district_contact", .text),
            GisaField("latitude", .coordinate, "Latitude"), GisaField("longitude", .coordinate, "Longitude"),
            GisaField("distribution_code", .text), GisaField("highway_status_cause", .text),
            GisaField("highway_status_code", .text),
            GisaField("lanes_closed_count", .integer, "Lanes closed count"),
            GisaField("open_highway_traffic_lanes_count", .integer, "Open highway traffic lanes count"),
            // Each crack is its own record (Cracks.swift); this is the yes/no answer.
            GisaField("pavement_ground_cracks", .tri),
            GisaField("settlement_in", .decimal, "Settlement"), GisaField("bulge_in", .decimal, "Bulge"),
            GisaField("indented_by_rocks", .tri),
        ]
        out += incidentTypeCodes.map { GisaField($0.key, .incidentType(code: $0.code)) }
        out.append(GisaField("incident_type_description", .text))
        out += ["advancing", "retrogressive", "enlarging", "widening", "moving", "confined"]
            .map { GisaField("distribution_\($0)", .yesNo) }
        out += ["rock", "soil", "bedding", "joints", "fractures"].map { GisaField("material_\($0)", .yesNo) }
        out.append(GisaField("material_pavement_type", .choice(["CONCRETE", "ASPHALT"])))
        out += [
            GisaField("est_soil_pct", .decimal, "Estimated soil %"),
            GisaField("est_rock_pct", .decimal, "Estimated rock formation %"),
            GisaField("est_clay_pct", .decimal, "Estimated clay %"),
            GisaField("est_silt_pct", .decimal, "Estimated silt %"),
            GisaField("est_sand_pct", .decimal, "Estimated sand %"),
            GisaField("est_gravel_pct", .decimal, "Estimated gravel/cobbles %"),
            GisaField("est_boulder_pct", .decimal, "Estimated boulder %"),
            GisaField("est_debris_clay_silt_pct", .decimal, "Estimated landslide debris clay/silt %"),
            GisaField("est_debris_sand_pct", .decimal, "Estimated landslide debris sand %"),
            GisaField("est_debris_gravel_pct", .decimal, "Estimated landslide debris gravel/cobbles %"),
            GisaField("est_debris_boulder_pct", .decimal, "Estimated landslide debris boulder %"),
        ]
        out += ["dry", "moist", "wet", "flowing", "seep", "spring"].map { GisaField("water_\($0)", .yesNo) }
        out += [
            GisaField("vegetation_trees", .percent, "Trees Coverage %"),
            GisaField("vegetation_bushes_shrubs", .percent, "Bushes/Shrubs Coverage %"),
            GisaField("vegetation_groundcover", .percent, "Groundcover Coverage %"),
        ]
        out += ["clogged_inlet", "compromised_drains", "surface_runoff", "torrent_surge_flood"]
            .map { GisaField("drainage_\($0)", .yesNo) }
        for thing in ["utilities", "properties", "structure"] {
            out += [GisaField("impact_impacted_adj_\(thing)", .yesNo), GisaField("impact_maybe_adj_\(thing)", .yesNo),
                    GisaField("impact_adj_\(thing)", .text)]
        }
        out += [
            GisaField("measure_slope_height_ft", .decimal, "Slope height"),
            GisaField("measure_original_slope_deg", .decimal, "Original slope"),
            GisaField("measure_landslide_width_ft", .decimal, "Landslide width"),
            GisaField("measure_landslide_length_ft", .decimal, "Landslide length"),
            GisaField("measure_main_scarp_height_ft", .decimal, "Main scarp height"),
            GisaField("measure_landslide_slope_deg", .decimal, "Landslide slope"),
            GisaField("measure_roadway_length_ft", .decimal, "Roadway length"),
            GisaField("measure_roadway_width_ft", .decimal, "Roadway width"),
        ]
        out += ["record_of_event", "maintenance_history", "geotechnical_assessment", "recommendations", "sketchpad",
                "observations"].map { GisaField("\($0)_notes", .text) }
        out += [
            GisaField("geometry_json", .json(serverKey: "geometry_json", pretty: true)),
            GisaField("pavement_ground_annotation_layout",
                      .json(serverKey: "pavement_ground_annotation_layout_json", pretty: false)),
        ]
        return out
    }()

    // MARK: - Loading

    /// The form for a saved GISA record (`gisa` from `GET /submissions/{id}`).
    /// `incidentTypes` are the submission's listed codes; `createdAt` gives the
    /// report date when none was saved.
    public init(server gisa: [String: JSONValue]?, incidentTypes: [String], createdAt: String?) {
        self.init()
        let g = gisa ?? [:]
        let listed = Set(incidentTypes)
        for field in Self.fields {
            let value = g[field.key]
            switch field.kind {
            case .text:
                self[field.key] = JS.string(value)
            case .route:
                self[field.key] = GisaPrecision.routeInput(JS.string(value))
            case .postMile:
                self[field.key] = GisaPrecision.postMileInput(JS.string(value))
            case .coordinate:
                self[field.key] = GisaPrecision.formatCoordinate(JS.string(value))
            case .integer, .decimal, .percent:
                self[field.key] = JS.string(value)
            case .tri, .yesNo:
                self[field.key] = Self.yesNo(value)
            case .incidentType(let code):
                self[field.key] = Self.yesNo(value) == "YES" || listed.contains(code) ? "YES" : "NO"
            case .choice(let allowed):
                let text = JS.string(value)
                self[field.key] = allowed.contains(text) ? text : ""
            case .json(let serverKey, let pretty):
                self[field.key] = Self.jsonText(g[serverKey], pretty: pretty)
            }
        }
        // The report date defaults to the day the submission was created.
        if g["report_date"] == nil || g["report_date"] == .null {
            self["report_date"] = Self.ymd(fromTimestamp: createdAt)
        }
        // County as its code ("Alameda" -> "ALA"); an unknown county is dropped.
        let county = CaltransCounties.code(JS.string(g["county"]))
        self["county"] = county ?? ""
        // District as two digits, else the county's district.
        let district = JS.string(g["district"])
        if Self.isTruthy(g["district"]) {
            self["district"] = district.count >= 2 ? district : String(repeating: "0", count: 2 - district.count) + district
        } else {
            self["district"] = CaltransCounties.district(forCounty: county) ?? ""
        }
        self = enforcingBusinessRules()
    }

    /// true, 1 or "1" -> YES; false, 0 or "0" -> NO; anything else -> "".
    static func yesNo(_ value: JSONValue?) -> String {
        switch value {
        case .bool(true)?, .number(1)?, .string("1")?: return "YES"
        case .bool(false)?, .number(0)?, .string("0")?: return "NO"
        default: return ""
        }
    }

    static func isTruthy(_ value: JSONValue?) -> Bool {
        switch value {
        case .none, .null?, .bool(false)?, .number(0)?, .string("")?: return false
        default: return true
        }
    }

    static func jsonText(_ value: JSONValue?, pretty: Bool) -> String {
        guard isTruthy(value), let value else { return "" }
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
                                          : [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    /// "2026-10-27T15:00:00" -> "2026-10-27": the date as the server wrote it.
    static func ymd(fromTimestamp value: String?) -> String {
        guard let value, value.count >= 10 else { return "" }
        let head = String(value.prefix(10))
        let parts = head.split(separator: "-")
        guard parts.count == 3, parts[0].count == 4, parts.allSatisfy({ $0.allSatisfy(\.isNumber) }) else {
            return ServerDate.parse(value).map(Self.localYmd) ?? ""
        }
        return head
    }

    static func localYmd(_ date: Date) -> String {
        let parts = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    // MARK: - Business rules

    /// The rules the form always obeys (`enforceFormBusinessRules`): tick boxes
    /// are YES or NO, rock and soil detail is cleared when the material is not
    /// present, and drainage and base water content are single choices.
    public func enforcingBusinessRules() -> GisaForm {
        var next = self
        for (key, _) in Self.incidentTypeCodes { next[key] = next[key] == "YES" ? "YES" : "NO" }
        for key in ["material_rock", "material_soil", "material_bedding", "material_joints", "material_fractures"] {
            next[key] = next[key] == "YES" ? "YES" : "NO"
        }
        if next["material_rock"] != "YES" {
            for key in ["material_bedding", "material_joints", "material_fractures"] { next[key] = "NO" }
            next["est_rock_pct"] = ""
        }
        if next["material_soil"] != "YES" {
            for key in ["est_soil_pct", "est_clay_pct", "est_silt_pct", "est_sand_pct", "est_gravel_pct", "est_boulder_pct"] {
                next[key] = ""
            }
        }
        for key in ["pavement_ground_cracks", "indented_by_rocks"] where next[key] != "YES" && next[key] != "NO" {
            next[key] = ""
        }
        next.keepOnlyFirstYes(of: ["drainage_clogged_inlet", "drainage_compromised_drains", "drainage_surface_runoff",
                                   "drainage_torrent_surge_flood"])
        next.keepOnlyFirstYes(of: ["water_dry", "water_moist", "water_wet", "water_flowing"])
        if next["water_flowing"] == "YES" {
            let sub = next["water_seep"] == "YES" ? "water_seep" : next["water_spring"] == "YES" ? "water_spring" : nil
            next["water_seep"] = sub == "water_seep" ? "YES" : "NO"
            next["water_spring"] = sub == "water_spring" ? "YES" : "NO"
        } else {
            next["water_seep"] = "NO"
            next["water_spring"] = "NO"
        }
        return next
    }

    private mutating func keepOnlyFirstYes(of keys: [String]) {
        let chosen = keys.first { self[$0] == "YES" }
        for key in keys { self[key] = key == chosen ? "YES" : "NO" }
    }

    /// The incident type codes ticked on the form.
    public var tickedIncidentTypes: [String] {
        Self.incidentTypeCodes.filter { self[$0.key] == "YES" }.map(\.code)
    }

    /// What `PUT …/gisa/incident-types` receives: the form's ticked types, then
    /// any other listed type (one with no tick box on the form), without repeats.
    public func incidentTypeItems(listed: [String]) -> [String] {
        let formCodes = Set(Self.incidentTypeCodes.map(\.code))
        var seen = Set<String>()
        return (tickedIncidentTypes + listed.filter { !formCodes.contains($0) }).filter { seen.insert($0).inserted }
    }

    // MARK: - Saving

    /// The `PATCH /submissions/{id}/gisa` body, after the business rules. Throws
    /// the first field the server would refuse.
    public func patchBody() throws -> [String: JSONValue] {
        var body: [String: JSONValue] = [:]
        for field in Self.fields {
            let text = self[field.key]
            let blank = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            switch field.kind {
            case .text, .choice:
                body[field.key] = blank ? .null : .string(text.trimmingCharacters(in: .whitespacesAndNewlines))
            case .route:
                body[field.key] = GisaPrecision.routeValue(text).map(JSONValue.string) ?? .null
            case .postMile:
                body[field.key] = GisaPrecision.postMileValue(text).map(JSONValue.string) ?? .null
            case .coordinate:
                body[field.key] = try Self.number(text, field).map { .number(JS.round($0, decimals: 6)) } ?? .null
            case .integer:
                guard !blank else { body[field.key] = .null; continue }
                guard let value = JS.number(text), value.rounded() == value, value.isFinite else {
                    throw GisaFieldError(key: field.key, message: "\(field.label) must be a whole number")
                }
                body[field.key] = .number(value)
            case .decimal:
                body[field.key] = try Self.number(text, field).map(JSONValue.number) ?? .null
            case .percent:
                guard let value = try Self.number(text, field) else { body[field.key] = .null; continue }
                guard (0...100).contains(value) else {
                    throw GisaFieldError(key: field.key, message: "\(field.label) must be between 0 and 100")
                }
                body[field.key] = .number(value)
            case .tri, .yesNo, .incidentType:
                body[field.key] = text == "YES" ? .bool(true) : text == "NO" ? .bool(false) : .null
            case .json(let serverKey, _):
                body[serverKey] = try Self.json(text, field)
            }
        }
        return body
    }

    private static func number(_ text: String, _ field: GisaField) throws -> Double? {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard let value = JS.number(text) else {
            throw GisaFieldError(key: field.key, message: "\(field.label) must be numeric")
        }
        return value
    }

    private static func json(_ text: String, _ field: GisaField) throws -> JSONValue {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .null }
        if let value = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) { return value }
        if field.key == "geometry_json" {
            throw GisaFieldError(key: field.key, message: "Geometry JSON is invalid.")
        }
        // An unreadable pavement layout is replaced by the default one.
        return PavementLayout.defaultJSON
    }
}

/// The pavement diagram's marker layout; the full model arrives with the
/// Pavement / Ground Status section.
enum PavementLayout {
    static let defaultJSON: JSONValue = .object([
        "crack": marker(0.08, 0.12), "settlement": marker(0.58, 0.18),
        "bulge": marker(0.2, 0.58), "rocks": marker(0.62, 0.62),
    ])

    private static func marker(_ x: Double, _ y: Double) -> JSONValue {
        .object(["x": .number(x), "y": .number(y), "placed": .bool(false), "rangeEnd": .null, "vertices": .array([])])
    }
}
