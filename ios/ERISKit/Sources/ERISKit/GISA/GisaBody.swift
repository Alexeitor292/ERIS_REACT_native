import Foundation

/// An incident type choice. Ten mirror a form tick box (`key`); the rest
/// exist only in the submission's incident type list.
public struct GisaIncidentTypeOption: Equatable, Identifiable, Sendable {
    public let key: String?
    public let code: String
    public let label: String
    public var id: String { code }
}

/// Step 2 (GISA Body) rules, from the Distribution, Highway Status and
/// Incident Type blocks of the Expo GISA editor.
extension GisaEditor {
    /// The editor's fixed incident type list (`INCIDENT_TYPE_OPTIONS`).
    public static let incidentTypeOptions: [GisaIncidentTypeOption] =
        GisaForm.incidentTypeCodes.map { pair in
            GisaIncidentTypeOption(key: pair.key, code: pair.code, label: [
                "ROCK_FALL": "Rock Fall", "TOPPLE": "Topple", "SLIDE": "Slide", "SPREAD": "Spread", "FLOW": "Flow",
                "COMPOUND": "Compound", "EROSION": "Erosion", "SURFICIAL_SLOUGHING": "Surficial Sloughing",
                "SCOURED_TOE": "Scoured Toe", "WASHOUT": "Washout",
            ][pair.code] ?? pair.code)
        } + [
            GisaIncidentTypeOption(key: nil, code: "SINK_HOLE", label: "Sink Hole"),
            GisaIncidentTypeOption(key: nil, code: "DEPRESSION", label: "Depression"),
            GisaIncidentTypeOption(key: nil, code: "HEAVING", label: "Heaving"),
        ]

    public func isIncidentTypeOn(_ option: GisaIncidentTypeOption) -> Bool {
        listedIncidentTypes.contains(option.code) || (option.key.map { form[$0] == "YES" } ?? false)
    }

    /// Turns an incident type on or off, in the list and on its tick box.
    public mutating func toggleIncidentType(_ option: GisaIncidentTypeOption) {
        let selecting = !isIncidentTypeOn(option)
        listedIncidentTypes.removeAll { $0 == option.code }
        if selecting { listedIncidentTypes.append(option.code) }
        if let key = option.key { set(key, selecting ? "YES" : "NO") }
    }

    /// Distribution is one choice; choosing it again clears it.
    public mutating func toggleDistribution(_ code: String) {
        set("distribution_code", form["distribution_code"] == code ? "" : code)
    }

    /// The highway status choices appear once there is a cause, a status, a
    /// lane count or an Open Highway Traffic action.
    public var showsHighwayStatusOptions: Bool {
        !form["highway_status_cause"].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !form["highway_status_code"].isEmpty || !form["lanes_closed_count"].isEmpty
            || !form["open_highway_traffic_lanes_count"].isEmpty
            || (actions.immediate + actions.followUp).contains("OPEN_HIGHWAY_TRAFFIC")
    }

    /// One status at a time; a lane count belongs only to Lane(s) Closed.
    public mutating func toggleHighwayStatus(_ code: String) {
        let next = form["highway_status_code"] == code ? "" : code
        set("highway_status_code", next)
        if next != "LANES_CLOSED" { set("lanes_closed_count", "") }
    }

    public var asksLanesClosedCount: Bool { form["highway_status_code"] == "LANES_CLOSED" }

    /// The lane counts offered for Lane(s) Closed.
    public static let lanesClosedCounts = ["1", "2", "3", "4"]
}

/// Step 2 Material rules: slope soil and rock, pavement type and landslide
/// debris, from the Material block of the Expo GISA editor.
extension GisaEditor {
    public static let soilShareKeys = ["est_sand_pct", "est_gravel_pct", "est_boulder_pct"]
    public static let debrisShareKeys = ["est_debris_clay_silt_pct", "est_debris_sand_pct", "est_debris_gravel_pct",
                                         "est_debris_boulder_pct"]
    public static let rockSubtypes = [("material_bedding", "Bedding"), ("material_joints", "Joint"),
                                      ("material_fractures", "Fracture")]

    /// A percentage as its slider shows it: 0–100 in steps of 5; blank or
    /// unreadable text shows as 0 (`SteppedPercentInput`).
    public static func steppedPercent(_ text: String) -> Int {
        let value = JS.number(text) ?? 0
        return Self.stepped(min(100, max(0, value)))
    }

    /// Nearest multiple of 5 within 0–100, rounding halves up as Math.round does.
    static func stepped(_ value: Double) -> Int {
        max(0, min(100, Int((value / 5 + 0.5).rounded(.down)) * 5))
    }

    /// Sets a share from its slider, stored in steps of 5.
    public mutating func setPercent(_ key: String, _ value: Double) {
        set(key, String(Self.stepped(value)))
    }

    /// Clay and silt share one slider: their sum, or "" when neither is set.
    public var claySiltPercent: String {
        let clay = form["est_clay_pct"].trimmingCharacters(in: .whitespacesAndNewlines)
        let silt = form["est_silt_pct"].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clay.isEmpty || !silt.isEmpty else { return "" }
        guard let clayValue = clay.isEmpty ? 0 : JS.number(clay), let siltValue = silt.isEmpty ? 0 : JS.number(silt),
              clayValue.isFinite, siltValue.isFinite else { return "" }
        return String(Self.stepped(clayValue + siltValue))
    }

    /// The shared slider stores its value as clay, with silt 0.
    public mutating func setClaySiltPercent(_ value: Double) {
        set("est_clay_pct", String(Self.stepped(value)))
        set("est_silt_pct", "0")
    }

    /// Soil or rock on or off; turning one off clears its detail.
    public mutating func toggleMaterial(_ key: String) {
        let selecting = form[key] != "YES"
        set(key, selecting ? "YES" : "NO")
        guard !selecting else { return }
        if key == "material_soil" {
            for share in ["est_soil_pct", "est_clay_pct", "est_silt_pct"] + Self.soilShareKeys { set(share, "") }
        } else if key == "material_rock" {
            set("est_rock_pct", "")
            for (subtype, _) in Self.rockSubtypes { set(subtype, "NO") }
        }
    }

    /// Bedding, joints and fractures can be marked only while rock is present.
    public mutating func toggleRockSubtype(_ key: String) {
        guard form["material_rock"] == "YES" else { return }
        set(key, form[key] == "YES" ? "NO" : "YES")
    }

    /// Concrete or asphalt; choosing it again clears it.
    public mutating func togglePavementType(_ type: String) {
        set("material_pavement_type", form["material_pavement_type"] == type ? "" : type)
    }

    /// The soil shares' total as submit checks it (clay, silt, sand, gravel,
    /// boulder), or nil when a share is not a number.
    public var soilShareTotal: Double? {
        var total = 0.0
        for key in ["est_clay_pct", "est_silt_pct"] + Self.soilShareKeys {
            guard let value = GisaValidation.percent(form[key]) else { return nil }
            total += value
        }
        return total
    }

    /// The landslide debris shares' total, or nil when one is not a number.
    public var debrisShareTotal: Double? {
        var total = 0.0
        for key in Self.debrisShareKeys {
            guard let value = GisaValidation.percent(form[key]) else { return nil }
            total += value
        }
        return total
    }
}
