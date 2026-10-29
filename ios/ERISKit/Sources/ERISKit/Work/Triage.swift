import Foundation

/// The coordinator's triage of a field report (`POST /incidents/{id}/triage`),
/// as data: what may be chosen, what each choice still needs, and the exact
/// request it sends. Ported from web/src/features/incidents/triageDecisionModel.ts.
/// Only "Assessment required" asks for an Incident Group; the server refuses a
/// group with any other decision.
public enum Triage {
    public enum Disposition: String, CaseIterable, Identifiable, Sendable {
        case assessmentRequired = "ASSESSMENT_REQUIRED"
        case noAssessmentRequired = "NO_ASSESSMENT_REQUIRED"
        case needsReporterInformation = "NEEDS_REPORTER_INFORMATION"
        case duplicateOrLinked = "DUPLICATE_OR_LINKED"

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .assessmentRequired: return "Assessment required"
            case .noAssessmentRequired: return "No assessment required"
            case .needsReporterInformation: return "Needs more from the reporter"
            case .duplicateOrLinked: return "Duplicate of another report"
            }
        }

        public var explanation: String {
            switch self {
            case .assessmentRequired:
                return "Accept the report into ERIS and open a GeoTech assessment. You also say which Incident Group it belongs to."
            case .noAssessmentRequired:
                return "Close the report. It does not enter ERIS and no geotechnical work follows."
            case .needsReporterInformation:
                return "Send it back with what to correct. It stays a field report and comes back to you once they update it."
            case .duplicateOrLinked:
                return "Close it and link it to the report it repeats. It does not enter ERIS."
            }
        }

        public var needsEventGroup: Bool { self == .assessmentRequired }
    }

    public enum GroupChoice: Equatable, Sendable {
        case existing(Int)
        case new(title: String, description: String)
    }

    public struct Draft: Equatable, Sendable {
        public let incidentId: Int
        /// Nil until the coordinator picks one; nothing is picked for them.
        public var disposition: Disposition?
        public var notes = ""
        /// Assessment required only.
        public var group: GroupChoice?
        /// Needs reporter information only.
        public var revisionFields: [String] = []
        /// Duplicate only.
        public var duplicateOf: Int?

        public init(incidentId: Int) {
            self.incidentId = incidentId
        }

        /// Why the decision cannot be recorded yet, or nil when it can.
        public var blocker: String? {
            switch disposition {
            case nil: return "Choose what happens to this report."
            case .assessmentRequired?: return group == nil ? "Choose its Incident Group, or start a new one." : nil
            case .needsReporterInformation?:
                return revisionFields.isEmpty && notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "Say what the reporter should correct." : nil
            case .duplicateOrLinked?: return duplicateOf == nil ? "Choose the report it repeats." : nil
            case .noAssessmentRequired?: return nil
            }
        }

        /// The request for a complete draft, only the fields its decision uses; nil until complete.
        public var body: [String: JSONValue]? {
            guard let disposition, blocker == nil else { return nil }
            var body: [String: JSONValue] = ["disposition": .string(disposition.rawValue)]
            let notes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
            if !notes.isEmpty { body["notes"] = .string(notes) }
            switch disposition {
            case .assessmentRequired:
                switch group {
                case .existing(let id)?:
                    body["event_group"] = .object(["mode": .string("EXISTING"), "event_group_id": .number(Double(id))])
                case .new(let title, let description)?:
                    var group: [String: JSONValue] = ["mode": .string("CREATE_NEW")]
                    let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    let description = description.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !title.isEmpty { group["title"] = .string(title) }
                    if !description.isEmpty { group["description"] = .string(description) }
                    body["event_group"] = .object(group)
                case nil: break
                }
            case .needsReporterInformation where !revisionFields.isEmpty:
                body["revision_fields"] = .array(revisionFields.map(JSONValue.string))
            case .duplicateOrLinked:
                if let duplicateOf { body["target_incident_id"] = .number(Double(duplicateOf)) }
            default: break
            }
            return body
        }

        /// The confirm button says what it does.
        public var confirmLabel: String {
            switch disposition {
            case .assessmentRequired?: return "Accept and open assessment"
            case .noAssessmentRequired?: return "Close — no assessment"
            case .needsReporterInformation?: return "Send back to the reporter"
            case .duplicateOrLinked?: return "Close as duplicate"
            case nil: return "Record decision"
            }
        }

        /// What the coordinator reads once the decision is saved.
        public func outcome(assessmentId: Int?) -> String {
            if let assessmentId {
                return "Report #\(incidentId) accepted. Assessment #\(assessmentId) is open and waiting for the office chief to route it."
            }
            switch disposition {
            case .noAssessmentRequired?: return "Report #\(incidentId) closed — no assessment needed."
            case .needsReporterInformation?: return "Report #\(incidentId) sent back to the reporter."
            case .duplicateOrLinked?: return "Report #\(incidentId) closed as a duplicate of report #\(duplicateOf ?? 0)."
            default: return "Decision recorded for report #\(incidentId)."
            }
        }
    }

    /// Fields the reporter can be asked to correct (the server's
    /// REVISION_FIELDS_ALLOWED), in the order they filled them in.
    public static let revisionFields: [(key: String, label: String)] = [
        ("description", "Description"), ("first_observed_at", "When it was first seen"),
        ("first_occurred_at", "When it occurred"), ("district", "District"), ("county", "County"), ("route", "Route"),
        ("post_mile", "Post mile"), ("latitude", "Latitude"), ("longitude", "Longitude"),
    ]

    // MARK: Duplicates

    public struct Candidate: Equatable, Identifiable, Sendable {
        public let incident: Incident
        public let distanceM: Double
        public var id: Int { incident.id }
    }

    public static let duplicateRadiusM = 8047.0  // 5 miles

    /// Other reports near this one, nearest first: the only plausible originals.
    public static func duplicateCandidates(of pin: Incident, among reports: [Incident], radiusM: Double = duplicateRadiusM,
                                           limit: Int = 8) -> [Candidate] {
        guard let lat = pin.latitude, let lon = pin.longitude else { return [] }
        return reports.compactMap { report -> Candidate? in
            guard report.id != pin.id, let rlat = report.latitude, let rlon = report.longitude else { return nil }
            let distance = haversineMetres(lat, lon, rlat, rlon)
            return distance <= radiusM ? Candidate(incident: report, distanceM: distance) : nil
        }
        .sorted { $0.distanceM == $1.distanceM ? $0.incident.id > $1.incident.id : $0.distanceM < $1.distanceM }
        .prefix(limit).map { $0 }
    }

    /// How far a candidate is, in words.
    public static func distanceLabel(_ metres: Double) -> String {
        guard metres.isFinite else { return "" }
        if metres < 10 { return "At the same spot" }
        if metres < 1000 { return "\(Int(metres.rounded())) m away" }
        return String(format: "%.1f mi away", metres / 1609.344)
    }

    static func haversineMetres(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
        let rad = Double.pi / 180
        let dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad
        let h = pow(sin(dLat / 2), 2) + cos(lat1 * rad) * cos(lat2 * rad) * pow(sin(dLon / 2), 2)
        return 2 * 6371008.8 * asin(min(1, h.squareRoot()))
    }
}

/// An open Incident Group near a report, for triage.
public struct NearbyEventGroup: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let title: String?
    public let incidentCount: Int?
    public let nearestDistanceM: Double?

    /// "0.4 mi away", "250 ft away", as the web's group picker says.
    public var distance: String? {
        guard let metres = nearestDistanceM else { return nil }
        let miles = metres / 1609.344
        if miles < 0.1 { return "\(Int((metres * 3.28084).rounded())) ft away" }
        return String(format: miles < 10 ? "%.1f mi away" : "%.0f mi away", miles)
    }
}

extension IncidentsAPI {
    /// Field reports in the districts this person covers, awaiting their triage.
    public func triageQueue() async throws -> [Incident] {
        let items = try await api.get("/incidents", query: [URLQueryItem(name: "queue", value: "triage"),
                                                            URLQueryItem(name: "limit", value: "1000")],
                                      as: IncidentList.self).items
        return items.filter { $0.currentStage == "COORDINATOR_REVIEW" && $0.status != "RESOLVED" }
    }

    /// Open Incident Groups near a report, nearest first.
    public func nearbyEventGroups(_ id: Int, radiusMiles: Double = 25) async throws -> [NearbyEventGroup] {
        struct Answer: Decodable { let items: [NearbyEventGroup] }
        return try await api.get("/incidents/\(id)/nearby-event-groups",
                                 query: [URLQueryItem(name: "radius_m", value: String(Int((radiusMiles * 1609.344).rounded()))),
                                         URLQueryItem(name: "limit", value: "50")],
                                 as: Answer.self).items
    }

    /// Records the triage decision; the assessment it opened, if any.
    public func triage(_ draft: Triage.Draft) async throws -> Int? {
        guard let body = draft.body else { throw APIError.http(400, draft.blocker) }
        struct Answer: Decodable {
            struct Opened: Decodable { let id: Int }
            let assessment: Opened?
        }
        let answer = try await api.request("POST", "/incidents/\(draft.incidentId)/triage",
                                           body: try JSONEncoder().encode(body), as: Answer.self)
        return answer.assessment?.id
    }
}

/// A photo, video or document filed with a report (`GET /incidents/{id}/attachments`),
/// with a presigned link to it, valid about 15 minutes.
public struct IncidentEvidence: Decodable, Equatable, Identifiable, Sendable {
    public let attachmentId: Int
    public let kind: String?
    public let fileName: String?
    public let mimeType: String?
    public let capturedAt: String?
    public let downloadUrl: String?

    public var id: Int { attachmentId }
    public var isPhoto: Bool { (mimeType ?? "").lowercased().hasPrefix("image/") || kind == "PHOTO" }

    enum CodingKeys: String, CodingKey {
        case kind
        case attachmentId = "attachment_id", fileName = "file_name", mimeType = "mime_type", capturedAt = "captured_at"
        case downloadUrl = "download_url"
    }
}

extension IncidentsAPI {
    public func evidence(_ id: Int) async throws -> [IncidentEvidence] {
        struct Answer: Decodable { let items: [IncidentEvidence] }
        return try await api.get("/incidents/\(id)/attachments", preservingKeys: true, as: Answer.self).items
    }
}
