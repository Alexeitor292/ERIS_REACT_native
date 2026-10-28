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
