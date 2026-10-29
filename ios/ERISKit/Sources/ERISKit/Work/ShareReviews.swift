import Foundation

/// A share of a technical form waiting on a branch or office chief
/// (`GET /shares/reviews`). APPROVAL: it takes effect only once every branch
/// chief with a say approves. NOTICE: the chief is told and may stop it.
/// Ported from the web's ShareWorkItem.
public struct ShareReview: Decodable, Equatable, Identifiable, Sendable {
    public struct Person: Decodable, Equatable, Sendable {
        public let id: Int
        public let fullName: String?
        public let email: String?
        public let placement: String?

        enum CodingKeys: String, CodingKey { case id, email, placement, fullName = "full_name" }

        /// Name, else email.
        public var label: String {
            let name = (fullName ?? "").trimmingCharacters(in: .whitespaces)
            let mail = (email ?? "").trimmingCharacters(in: .whitespaces)
            return !name.isEmpty ? name : !mail.isEmpty ? mail : "Unnamed user"
        }
    }

    public struct Review: Decodable, Equatable, Identifiable, Sendable {
        public let id: Int
        public let unitLabel: String
        public let kind: String
        public let decision: String
        public let decidedBy: String?

        enum CodingKeys: String, CodingKey { case id, kind, decision, unitLabel = "unit_label", decidedBy = "decided_by" }

        /// "Branch C — approved by M. Okafor".
        public var line: String {
            let by = decidedBy.map { " by \($0)" } ?? ""
            if decision == "REJECTED" { return "\(unitLabel) — \(kind == "APPROVAL" ? "rejected" : "stopped")\(by)" }
            if kind == "APPROVAL" { return "\(unitLabel) — \(decision == "APPROVED" ? "approved\(by)" : "waiting for approval")" }
            return "\(unitLabel) — \(decision == "ACKNOWLEDGED" ? "told, seen\(by)" : "told")"
        }
    }

    public struct Form: Decodable, Equatable, Sendable {
        public let id: Int
        public let title: String?
    }

    public let reviewId: Int
    public let shareId: Int
    public let kind: String
    public let unitLabel: String
    public let status: String
    public let createdAt: String?
    public let submission: Form
    public let owner: Person
    public let sharer: Person
    public let recipient: Person
    public let reviews: [Review]

    public var id: Int { reviewId }
    public var isApproval: Bool { kind == "APPROVAL" }

    enum CodingKeys: String, CodingKey {
        case kind, status, submission, owner, sharer, recipient, reviews
        case reviewId = "review_id", shareId = "share_id", unitLabel = "unit_label", createdAt = "created_at"
    }

    /// "A. Lee is sharing “Slip at PM 4” with B. Cho".
    public var headline: String {
        let form = submission.title.map { "“\($0)”" } ?? "technical form #\(submission.id)"
        return "\(owner.label) is sharing \(form) with \(recipient.label)"
    }

    /// What the chief needs to know before deciding.
    public var explanation: String {
        if isApproval { return "It takes effect only once every branch chief below approves. Rejecting it stops it." }
        return status == "ACTIVE" ? "It is in effect. You need not do anything; you may stop it."
            : "It is waiting on the branch chiefs. You need not do anything; you may stop it."
    }

    public enum Decision: String, Sendable {
        case approve = "APPROVE", reject = "REJECT", acknowledge = "ACKNOWLEDGE"
    }

    /// The decisions offered, with their buttons' words.
    public var decisions: [(Decision, String)] {
        isApproval ? [(.approve, "Approve"), (.reject, "Reject")] : [(.acknowledge, "Keep it"), (.reject, "Stop sharing")]
    }

    /// What happened, once decided; the share's status after it.
    public func outcome(_ decision: Decision, status: String) -> String {
        switch decision {
        case .approve:
            return status == "PENDING" ? "Approved. It takes effect once the other branch chief approves too." : "Approved. The form is now shared."
        case .reject: return isApproval ? "Rejected. The form was not shared." : "Stopped. The form is no longer shared."
        case .acknowledge: return "Noted. The share stands."
        }
    }
}

extension SubmissionsAPI {
    public func shareReviews() async throws -> [ShareReview] {
        struct Answer: Decodable { let items: [ShareReview] }
        return try await api.get("/shares/reviews", preservingKeys: true, as: Answer.self).items
    }

    /// Records the chief's decision; the share's status after it.
    public func decide(_ review: ShareReview, _ decision: ShareReview.Decision, note: String) async throws -> String {
        struct Answer: Decodable { let status: String }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let body: [String: JSONValue] = ["decision": .string(decision.rawValue), "note": trimmed.isEmpty ? .null : .string(trimmed)]
        return try await api.request("POST", "/shares/\(review.shareId)/reviews/\(review.reviewId)",
                                     body: try JSONEncoder().encode(body), preservingKeys: true, as: Answer.self).status
    }
}
