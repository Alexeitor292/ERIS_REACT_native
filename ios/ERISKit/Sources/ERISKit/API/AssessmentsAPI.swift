import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A technical assessment, as `GET /assessments` returns it. Ported from
/// `Assessment` in mobile/src/api/assessments.ts.
public struct Assessment: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let incidentId: Int
    public let submissionId: Int?
    public let district: String?
    public let officeCode: String?
    /// The routing snapshot: the office and branch as they read when this
    /// assessment was routed, so a later rename cannot rewrite the record.
    public let routedOfficeName: String?
    public let routedBranchId: Int?
    public let routedBranchName: String?
    public let routedBranchLetter: String?
    /// `BRANCH` or `SENIOR_ENGINEER`; null until the office chief chooses.
    public let routingPath: String?
    public let branchChiefUserId: Int?
    /// The assignee on both routes; `assignedUserKind` says which kind.
    public let assignedEngineerUserId: Int?
    public let assignedUserKind: String?
    /// Server-derived review authority for the caller. Never re-derive it from roles.
    public let canReview: Bool?
    public let state: String
    public let triageDisposition: String?
    public let notes: String?
    public let submittedAt: String?
    public let approvedAt: String?
    public let createdAt: String?
    public let updatedAt: String?

    public var isBranchRoute: Bool { routingPath == "BRANCH" }

    /// The office by name from the routing snapshot, else its code.
    public var officeLabel: String {
        routedOfficeName?.trimmed.nilIfEmpty ?? officeCode?.nilIfEmpty ?? "—"
    }

    /// The branch the work was handed to, or nil before the hand-off.
    public var branchLabel: String? {
        PersonPicker.branchLabel(name: routedBranchName, letter: routedBranchLetter)
    }
}

public struct AssessmentList: Decodable, Equatable, Sendable {
    public let items: [Assessment]
}

/// One step in an assessment's history.
public struct AssessmentEvent: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let actorUserId: Int?
    public let actorName: String?
    public let eventType: String
    public let disposition: String?
    public let fromState: String?
    public let toState: String?
    public let notes: String?
    public let createdAt: String?

    public var actorLabel: String {
        actorName?.nilIfEmpty ?? actorUserId.map { "user #\($0)" } ?? "—"
    }
}

/// `GET /assessments/{id}`. The server also sends `assignments`, which the
/// phone does not show.
public struct AssessmentDetail: Decodable, Equatable, Sendable {
    public let assessment: Assessment
    public let events: [AssessmentEvent]
}

/// A picker heading: a branch, a location, or the "not recorded" tail.
public struct PickerGroup: Decodable, Equatable, Sendable {
    public let groupKey: String
    public let label: String?
    public let branchId: Int?
    public let branchLetter: String?
    public let branchName: String?
    public let homeCity: String?
    public let homeDistrict: String?
    /// False for a branch on the chart that is not staffed yet: shown disabled, never omitted.
    public let acceptsAssignments: Bool?
    public let isActive: Bool?

    public init(groupKey: String, label: String?, branchId: Int? = nil, branchLetter: String? = nil,
                branchName: String? = nil, homeCity: String? = nil, homeDistrict: String? = nil,
                acceptsAssignments: Bool? = nil, isActive: Bool? = nil) {
        self.groupKey = groupKey
        self.label = label
        self.branchId = branchId
        self.branchLetter = branchLetter
        self.branchName = branchName
        self.homeCity = homeCity
        self.homeDistrict = homeDistrict
        self.acceptsAssignments = acceptsAssignments
        self.isActive = isActive
    }
}

/// One person in a picker. The counts and availability are annotation, never
/// ranking: nothing sorts, filters or hides on them.
public struct RoutingUserOption: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let email: String?
    public let fullName: String
    public let officeCode: String?
    public let officeName: String?
    public let branchId: Int?
    public let branchLetter: String?
    public let branchName: String?
    public let homeCity: String?
    public let homeDistrict: String?
    public let openAssessmentCount: Int?
    public let awaitingActionCount: Int?
    /// AVAILABLE | ROTATION_OUT | ACTING_ELSEWHERE | UNAVAILABLE.
    public let availability: String?
    public let availableUntil: String?
    public let groupKey: String?

    public init(id: Int, fullName: String, email: String? = nil, officeCode: String? = nil, officeName: String? = nil,
                branchId: Int? = nil, branchLetter: String? = nil, branchName: String? = nil,
                homeCity: String? = nil, homeDistrict: String? = nil, openAssessmentCount: Int? = 0,
                awaitingActionCount: Int? = 0, availability: String? = "AVAILABLE", availableUntil: String? = nil,
                groupKey: String?) {
        self.id = id
        self.email = email
        self.fullName = fullName
        self.officeCode = officeCode
        self.officeName = officeName
        self.branchId = branchId
        self.branchLetter = branchLetter
        self.branchName = branchName
        self.homeCity = homeCity
        self.homeDistrict = homeDistrict
        self.openAssessmentCount = openAssessmentCount
        self.awaitingActionCount = awaitingActionCount
        self.availability = availability
        self.availableUntil = availableUntil
        self.groupKey = groupKey
    }
}

/// The people one hand-off may go to, grouped by the server.
public struct RoutingOptions: Decodable, Equatable, Sendable {
    public let groups: [PickerGroup]?
    public let items: [RoutingUserOption]

    public var sections: [PickerSection] { PersonPicker.sections(groups: groups ?? [], items: items) }
}

/// The worklists `GET /assessments?queue=` serves.
public enum AssessmentQueue: String, CaseIterable, Sendable {
    case officeChief = "office_chief"
    case officeChiefReview = "office_chief_review"
    case branchChief = "branch_chief"
    case branchChiefReview = "branch_chief_review"
    case assignee
    /// The server's alias of `assignee`, which the Expo app requests.
    case engineer
    case reviewer
}

public enum AssessmentReviewAction: String, Encodable, Sendable {
    case approve = "APPROVE"
    case requestRevision = "REQUEST_REVISION"
}

/// The assessment calls the app makes, typed.
public struct AssessmentsAPI: Sendable {
    let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    public func list(queue: AssessmentQueue? = nil, state: String? = nil) async throws -> [Assessment] {
        var query = [URLQueryItem]()
        if let state { query.append(URLQueryItem(name: "state", value: state)) }
        if let queue { query.append(URLQueryItem(name: "queue", value: queue.rawValue)) }
        return try await api.get("/assessments", query: query, as: AssessmentList.self).items
    }

    public func detail(_ id: Int) async throws -> AssessmentDetail {
        try await api.get("/assessments/\(id)", as: AssessmentDetail.self)
    }

    /// The branch chiefs an office chief may hand this assessment to.
    public func branchOptions(_ id: Int) async throws -> RoutingOptions {
        try await api.get("/assessments/\(id)/branch-options", as: RoutingOptions.self)
    }

    /// The Staff members a branch chief may assign, own branch first.
    public func engineerOptions(_ id: Int) async throws -> RoutingOptions {
        try await api.get("/admin/assessment-assignment-options/\(id)",
                          query: [URLQueryItem(name: "kind", value: "ENGINEER")], as: RoutingOptions.self)
    }

    public func delegateBranch(_ id: Int, branchChiefUserId: Int, notes: String?) async throws {
        struct Body: Encodable { let branchChiefUserId: Int; let notes: String? }
        _ = try await api.post("/assessments/\(id)/delegate-branch",
                               json: Body(branchChiefUserId: branchChiefUserId, notes: notes.blankAsNil),
                               as: EmptyResponse.self)
    }

    /// Assign a Staff member (`assign-engineer` is the deployed name). The server
    /// accepts someone from another branch only with a reason in `notes`.
    public func assignEngineer(_ id: Int, engineerUserId: Int, notes: String?) async throws {
        struct Body: Encodable { let engineerUserId: Int; let notes: String? }
        _ = try await api.post("/assessments/\(id)/assign-engineer",
                               json: Body(engineerUserId: engineerUserId, notes: notes.blankAsNil),
                               as: EmptyResponse.self)
    }

    public func submit(_ id: Int, notes: String?) async throws {
        struct Body: Encodable { let notes: String? }
        _ = try await api.post("/assessments/\(id)/submit", json: Body(notes: notes.blankAsNil), as: EmptyResponse.self)
    }

    public func review(_ id: Int, action: AssessmentReviewAction, notes: String?) async throws {
        struct Body: Encodable { let action: AssessmentReviewAction; let notes: String? }
        _ = try await api.post("/assessments/\(id)/review", json: Body(action: action, notes: notes.blankAsNil),
                               as: EmptyResponse.self)
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

extension Optional where Wrapped == String {
    /// Notes are sent trimmed, and not at all when blank.
    var blankAsNil: String? { self?.trimmed.nilIfEmpty }
}
