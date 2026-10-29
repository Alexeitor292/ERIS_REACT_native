import Foundation

/// What else has happened at a form's site (`GET /submissions/{id}/site-history`,
/// backend routes/site_history.py): every earlier report nearby, newest first,
/// each with what maintenance reported, decided, did and wrote. Labels are
/// ported from the web app's memoContentModel.ts.
public struct SiteHistory: Decodable, Equatable, Sendable {
    public enum Relation: String, Decodable, Sendable {
        case sameType = "SAME_TYPE", differentType = "DIFFERENT_TYPE", unclassified = "UNCLASSIFIED"

        public var label: String {
            switch self {
            case .sameType: return "Recurrence"
            case .differentType: return "Different type"
            case .unclassified: return "Not classified yet"
            }
        }
    }

    public struct Ref: Decodable, Equatable, Sendable {
        public let code: String
        public let label: String
    }

    public struct Anchor: Decodable, Equatable, Sendable {
        public let radiusM: Double

        enum CodingKeys: String, CodingKey { case radiusM = "radius_m" }
    }

    /// What maintenance reported, decided, did and wrote about one incident.
    public struct Maintenance: Decodable, Equatable, Sendable {
        public struct Report: Decodable, Equatable, Sendable {
            public let description: String?
            public let reportedBy: String?
            public let reportedAt: String?
            enum CodingKeys: String, CodingKey { case description, reportedBy = "reported_by", reportedAt = "reported_at" }
        }

        public struct Triage: Decodable, Equatable, Sendable {
            public let disposition: String?
            public let notes: String?
            public let decidedBy: String?
            public let decidedAt: String?
            enum CodingKeys: String, CodingKey { case disposition, notes, decidedBy = "decided_by", decidedAt = "decided_at" }
        }

        public struct Note: Decodable, Equatable, Sendable {
            public let text: String?
            public let by: String?
            public let at: String?
        }

        /// A later report closed as a duplicate of this incident.
        public struct AlsoReported: Decodable, Equatable, Sendable {
            public let incidentId: Int
            public let observedAt: String?
            public let reportedBy: String?
            public let description: String?
            public let coordinatorNotes: String?
            public let decidedBy: String?
            public let decidedAt: String?
            enum CodingKeys: String, CodingKey {
                case description
                case incidentId = "incident_id", observedAt = "observed_at", reportedBy = "reported_by"
                case coordinatorNotes = "coordinator_notes", decidedBy = "decided_by", decidedAt = "decided_at"
            }
        }

        public let report: Report
        public let triage: Triage?
        public let immediateActions: [Ref]
        public let followUpActions: [Ref]
        public let notes: [Note]
        public let alsoReported: [AlsoReported]

        enum CodingKeys: String, CodingKey {
            case report, triage, notes
            case immediateActions = "immediate_actions", followUpActions = "follow_up_actions", alsoReported = "also_reported"
        }

        /// Whether maintenance did or wrote anything beyond the report itself.
        public var hasRecord: Bool {
            (triage?.notes?.isEmpty == false) || !immediateActions.isEmpty || !followUpActions.isEmpty || !notes.isEmpty
                || !alsoReported.isEmpty
        }
    }

    public struct Incident: Decodable, Equatable, Identifiable, Sendable {
        public struct Assessment: Decodable, Equatable, Sendable { public let state: String }
        public struct Group: Decodable, Equatable, Sendable {
            public let id: Int
            public let title: String?
        }

        public let incidentId: Int
        public let title: String?
        public let observedAt: String?
        public let distanceM: Double?
        public let sameLocation: Bool
        /// False for reports that never entered the incident record.
        public let inRecord: Bool
        public let types: [Ref]
        public let relation: Relation
        public let stage: String?
        /// Outside the record only: how triage left it.
        public let outcome: String?
        public let eventGroup: Group?
        public let assessment: Assessment?
        public let maintenance: Maintenance

        public var id: Int { incidentId }

        enum CodingKeys: String, CodingKey {
            case title, types, relation, stage, outcome, assessment, maintenance
            case incidentId = "incident_id", observedAt = "observed_at", distanceM = "distance_m"
            case sameLocation = "same_location", inRecord = "in_record", eventGroup = "event_group"
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            incidentId = try c.decode(Int.self, forKey: .incidentId)
            title = try c.decodeIfPresent(String.self, forKey: .title)
            observedAt = try c.decodeIfPresent(String.self, forKey: .observedAt)
            distanceM = try c.decodeIfPresent(Double.self, forKey: .distanceM)
            sameLocation = try c.decodeIfPresent(Bool.self, forKey: .sameLocation) ?? false
            inRecord = try c.decodeIfPresent(Bool.self, forKey: .inRecord) ?? true
            types = try c.decodeIfPresent([Ref].self, forKey: .types) ?? []
            relation = (try? c.decode(Relation.self, forKey: .relation)) ?? .unclassified
            stage = try c.decodeIfPresent(String.self, forKey: .stage)
            outcome = try c.decodeIfPresent(String.self, forKey: .outcome)
            eventGroup = try c.decodeIfPresent(Group.self, forKey: .eventGroup)
            assessment = try c.decodeIfPresent(Assessment.self, forKey: .assessment)
            maintenance = try c.decode(Maintenance.self, forKey: .maintenance)
        }

        /// "Incident #12 · Slip at PM 4" in the record; "Report #12 …" outside it.
        public var heading: String {
            "\(inRecord ? "Incident" : "Report") #\(incidentId)\(title.map { " · \($0)" } ?? "")"
        }

        /// Where it stands: its assessment or resolution, or that it is not in the record.
        public var standing: String {
            inRecord ? SiteHistory.standing(stage: stage, assessmentState: assessment?.state) : "Not in the incident record"
        }
    }

    public let anchor: Anchor?
    public let incidents: [Incident]

    public struct Summary: Equatable, Sendable {
        public let total, recurrences, differentType, unclassified, outsideRecord: Int
    }

    /// Recurrences count only incidents in the record; reports that never entered it are counted apart.
    public static func summarize(_ items: [(relation: Relation, inRecord: Bool)]) -> Summary {
        let inRecord = items.filter(\.inRecord)
        return Summary(total: items.count, recurrences: inRecord.filter { $0.relation == .sameType }.count,
                       differentType: inRecord.filter { $0.relation == .differentType }.count,
                       unclassified: inRecord.filter { $0.relation == .unclassified }.count,
                       outsideRecord: items.count - inRecord.count)
    }

    public var summary: Summary { Self.summarize(incidents.map { ($0.relation, $0.inRecord) }) }

    /// "No earlier incidents", "3 earlier incidents here".
    public var headline: String {
        let total = incidents.count
        return total == 0 ? "No earlier incidents" : "\(total) earlier \(total == 1 ? "incident" : "incidents") here"
    }

    /// "2 recurrences · 1 not in the incident record", or nil when there is nothing to add.
    public var counts: String? {
        let s = summary
        let parts = [s.recurrences > 0 ? "\(s.recurrences) \(s.recurrences == 1 ? "recurrence" : "recurrences")" : nil,
                     s.differentType > 0 ? "\(s.differentType) of a different type" : nil,
                     s.outsideRecord > 0 ? "\(s.outsideRecord) not in the incident record" : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// "Within 150 m of this site", or how to get a history at all.
    public var scope: String {
        guard let anchor else { return "Record the site's location on the form to see what else has happened here." }
        return "Within \(JS.numberText(anchor.radiusM)) m of this site"
    }

    /// "Same location", "12 m away", "1.5 km away".
    public static func distance(_ meters: Double?, sameLocation: Bool) -> String {
        if sameLocation { return "Same location" }
        guard let meters else { return "Nearby" }
        if meters < 1 { return "Same spot" }
        return meters < 1000 ? "\(JS.numberText((meters + 0.5).rounded(.down))) m away"
            : String(format: "%.1f km away", meters / 1000)
    }

    /// Where an earlier incident stands, in words.
    public static func standing(stage: String?, assessmentState: String?) -> String {
        if stage == "RESOLVED" { return "Resolved" }
        let states = [
            "PENDING_OFFICE_DELEGATION": "Awaiting office routing", "PENDING_ENGINEER_ASSIGNMENT": "Awaiting assignment",
            "DRAFT": "Assessment in progress", "SUBMITTED": "Assessment in review", "REVISION_REQUESTED": "Revision requested",
            "APPROVED": "Assessment approved", "FINALIZED": "Assessment finalized",
        ]
        return assessmentState.flatMap { states[$0] } ?? "In the record"
    }

    /// How triage left a report.
    public static func outcome(_ code: String?) -> String? {
        guard let code else { return nil }
        let labels = [
            "ASSESSMENT_REQUIRED": "Sent for assessment", "NO_ASSESSMENT_REQUIRED": "No assessment needed",
            "DUPLICATE_OR_LINKED": "Duplicate of another report", "NEEDS_REPORTER_INFORMATION": "Sent back to the reporter",
            "PENDING_TRIAGE": "Awaiting triage",
        ]
        return labels[code] ?? code
    }
}

extension SubmissionsAPI {
    public func siteHistory(_ id: Int) async throws -> SiteHistory {
        try await api.get("/submissions/\(id)/site-history", preservingKeys: true, as: SiteHistory.self)
    }
}
