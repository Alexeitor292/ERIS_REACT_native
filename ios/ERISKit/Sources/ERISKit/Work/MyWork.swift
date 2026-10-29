import Foundation

/// My Work: the one queue of everything waiting on the signed-in person, as
/// the web's MyWorkPage builds it.
///
///  - Maintenance Coordinator: field reports awaiting triage.
///  - Anyone with district maintenance duties: reports at their step of the
///    district's maintenance workflow (and, on request, the others they can read).
///  - Office Chief: assessments to route, and Senior Specialist-route reviews.
///  - Branch Chief: assessments to assign, and to approve or return.
///  - Staff or Senior Specialist: their own assessments in Draft or Revision requested.
///  - Admin: every submitted assessment and every maintenance report; an
///    administrator can show geotechnical or maintenance work alone.
///  - Branch and Office Chiefs: shares of technical forms to approve or that they were told about.
public enum MyWork {
    /// Which side of the work an item is on.
    public enum Filter: String, CaseIterable, Identifiable, Sendable {
        case both, geotech, maintenance
        public var id: String { rawValue }
        public var label: String {
            switch self {
            case .both: return "Both"
            case .geotech: return "Geotechnical"
            case .maintenance: return "Maintenance"
            }
        }
    }

    public enum Item: Equatable, Identifiable, Sendable {
        case triage(Incident)
        case maintenance(MaintenanceReport)
        case share(ShareReview)
        case assessment(Assessment)

        public var id: String {
            switch self {
            case .triage(let incident): return "t\(incident.id)"
            case .maintenance(let report): return "m\(report.id)"
            case .share(let review): return "s\(review.reviewId)"
            case .assessment(let assessment): return "a\(assessment.id)"
            }
        }

        /// Triage and maintenance reports are maintenance work; assessments and shares geotechnical.
        public var isMaintenance: Bool {
            switch self {
            case .triage, .maintenance: return true
            case .share, .assessment: return false
            }
        }
    }

    /// Everything that could be listed, as loaded.
    public struct Loaded: Equatable, Sendable {
        public var triage: [Incident] = []
        public var reports: [MaintenanceReport] = []
        public var shares: [ShareReview] = []
        public var assessments: [Assessment] = []
        /// When the oldest list shown was kept on this iPhone, if any was.
        public var keptAt: Date?

        public init(triage: [Incident] = [], reports: [MaintenanceReport] = [], shares: [ShareReview] = [],
                    assessments: [Assessment] = []) {
            self.triage = triage
            self.reports = reports
            self.shares = shares
            self.assessments = assessments
        }

        /// Maintenance reports this person can read that are not waiting on them.
        public var otherReports: Int { reports.filter { !$0.myTurn }.count }
    }

    /// Whether this person has a queue at all.
    public static func hasQueue(roles: [String], maintenanceDuties: Bool) -> Bool {
        maintenanceDuties || RoleModel.canTriage(roles) || RoleModel.canDelegateBranch(roles) || RoleModel.canAssignEngineer(roles)
            || RoleModel.isAssessmentAuthor(roles)
    }

    /// The assessment lists to fetch for these roles, and which of each to keep.
    public static func assessmentLists(roles: [String]) -> [(queue: AssessmentQueue?, state: String?, keep: @Sendable (Assessment) -> Bool)] {
        var out: [(AssessmentQueue?, String?, @Sendable (Assessment) -> Bool)] = []
        let all: @Sendable (Assessment) -> Bool = { _ in true }
        if RoleModel.canDelegateBranch(roles) { out += [(.officeChief, nil, all), (.officeChiefReview, nil, all)] }
        if RoleModel.canAssignEngineer(roles) { out += [(.branchChief, nil, all), (.branchChiefReview, nil, all)] }
        if RoleModel.isAssessmentAuthor(roles) {
            out.append((.assignee, nil, { $0.state == "DRAFT" || $0.state == "REVISION_REQUESTED" }))
        }
        if RoleModel.isAdmin(roles) { out.append((nil, "SUBMITTED", all)) }
        return out
    }

    /// The queue: triage first, then maintenance reports, shares and assessments,
    /// each newest first (maintenance reports in the server's order). Maintenance
    /// reports not waiting on this person show only when asked for, or when
    /// opened by a link. An administrator's filter applies last.
    public static func items(_ loaded: Loaded, includeOtherReports: Bool = false, opened: Int? = nil,
                             filter: Filter = .both, admin: Bool = false) -> [Item] {
        var seen = Set<Int>()
        let assessments = loaded.assessments.filter { seen.insert($0.id).inserted }
        let items: [Item] =
            loaded.triage.sorted { ($0.firstObservedAt ?? "") > ($1.firstObservedAt ?? "") }.map(Item.triage)
            + loaded.reports.filter { $0.myTurn || includeOtherReports || $0.id == opened }.map(Item.maintenance)
            + loaded.shares.sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") }.map(Item.share)
            + assessments.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }.map(Item.assessment)
        guard admin, filter != .both else { return items }
        return items.filter { $0.isMaintenance == (filter == .maintenance) }
    }

    /// Loads every list this person's queue draws on. Each is fetched on its
    /// own: one failing list leaves the rest of the queue in place. With a
    /// store, each is kept, and shown from there when ERIS cannot be reached.
    public static func load(api: APIClient, roles: [String], maintenanceDuties: Bool, store: OfflineStore? = nil) async -> Loaded {
        var loaded = Loaded()
        var keptAt: Date?
        func note(_ date: Date?) { if let date { keptAt = min(keptAt ?? date, date) } }
        struct Reports: Decodable { let items: [MaintenanceReport] }
        struct Shares: Decodable { let items: [ShareReview] }
        if RoleModel.canTriage(roles),
           let (list, at) = try? await api.kept("/incidents", query: [URLQueryItem(name: "queue", value: "triage"),
                                                                    URLQueryItem(name: "limit", value: "1000")],
                                                store: store, name: "work/triage", as: IncidentList.self) {
            loaded.triage = list.items.filter { $0.currentStage == "COORDINATOR_REVIEW" && $0.status != "RESOLVED" }
            note(at)
        }
        if maintenanceDuties || RoleModel.isAdmin(roles),
           let (list, at) = try? await api.kept("/maintenance-work/incidents", preservingKeys: true, store: store,
                                                name: "work/maintenance", as: Reports.self) {
            loaded.reports = list.items
            note(at)
        }
        if RoleModel.canDelegateBranch(roles) || RoleModel.canAssignEngineer(roles),
           let (list, at) = try? await api.kept("/shares/reviews", preservingKeys: true, store: store, name: "work/shares",
                                                as: Shares.self) {
            loaded.shares = list.items
            note(at)
        }
        for list in assessmentLists(roles: roles) {
            var query: [URLQueryItem] = []
            if let state = list.state { query.append(URLQueryItem(name: "state", value: state)) }
            if let queue = list.queue { query.append(URLQueryItem(name: "queue", value: queue.rawValue)) }
            let name = "work/assessments-\(list.queue?.rawValue ?? list.state ?? "all")"
            if let (answer, at) = try? await api.kept("/assessments", query: query, store: store, name: name, as: AssessmentList.self) {
                loaded.assessments += answer.items.filter(list.keep)
                note(at)
            }
        }
        loaded.keptAt = keptAt
        return loaded
    }
}
