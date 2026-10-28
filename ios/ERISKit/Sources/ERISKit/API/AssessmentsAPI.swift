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
    /// The office and branch names as they read when routed; render these
    /// first, and the office code only when they are null.
    public let routedOfficeName: String?
    public let routedBranchName: String?
    public let routingPath: String?
    public let assignedEngineerUserId: Int?
    /// Server-derived review authority for the caller. Never re-derive it from roles.
    public let canReview: Bool?
    public let state: String
    public let notes: String?
    public let submittedAt: String?
    public let approvedAt: String?
    public let createdAt: String?
    public let updatedAt: String?

    public var routedTo: String? {
        [routedOfficeName ?? officeCode, routedBranchName].compactMap { $0 }.filter { !$0.isEmpty }
            .joined(separator: " › ").nilIfEmpty
    }
}

public struct AssessmentList: Decodable, Equatable, Sendable {
    public let items: [Assessment]
}

/// The worklists `GET /assessments?queue=` serves.
public enum AssessmentQueue: String, CaseIterable, Sendable {
    case officeChief = "office_chief"
    case officeChiefReview = "office_chief_review"
    case branchChief = "branch_chief"
    case branchChiefReview = "branch_chief_review"
    case assignee
    case reviewer

    public var title: String {
        switch self {
        case .officeChief: return "To route (office)"
        case .officeChiefReview: return "To review (office)"
        case .branchChief: return "To assign (branch)"
        case .branchChiefReview: return "To review (branch)"
        case .assignee: return "Assigned to me"
        case .reviewer: return "To review"
        }
    }

    /// The worklists a person's roles give them, most specific first.
    public static func queues(for roles: [String]) -> [AssessmentQueue] {
        var out: [AssessmentQueue] = []
        if RoleModel.has(roles, .officeChief) || RoleModel.isAdmin(roles) { out += [.officeChief, .officeChiefReview] }
        if RoleModel.has(roles, .branchChief) || RoleModel.isAdmin(roles) { out += [.branchChief, .branchChiefReview] }
        if RoleModel.isAssessmentAuthor(roles) { out.append(.assignee) }
        return out
    }
}

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
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
