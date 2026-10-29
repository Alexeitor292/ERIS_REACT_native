import Foundation

/// The colour family of an assessment state's badge.
public enum AssessmentTone: Sendable {
    case done, attention, inReview, waiting, neutral

    public init(state: String) {
        switch state {
        case "APPROVED", "FINALIZED": self = .done
        case "REVISION_REQUESTED": self = .attention
        case "SUBMITTED": self = .inReview
        case _ where state.hasPrefix("PENDING"): self = .waiting
        default: self = .neutral
        }
    }
}

/// What the person may do with an open assessment. For showing and hiding
/// controls only: the server enforces every step. Review authority comes from
/// the server's `can_review`; the assignee is `assigned_engineer_user_id` on
/// both routes.
public struct AssessmentActions: Equatable, Sendable {
    /// Office chief: hand it to a branch chief.
    public let delegate: Bool
    /// Branch chief: assign a Staff member. Offered only on the branch route.
    public let assign: Bool
    /// Pending Staff assignment, but on the Senior Specialist route.
    public let assignNotOnThisRoute: Bool
    /// The assignee (or an administrator): submit for review.
    public let submit: Bool
    public let review: Bool
    /// Submitted: say who decides, whether or not this person can.
    public let explainReview: Bool

    public init(assessment: Assessment, roles: [String], meId: Int?) {
        let state = assessment.state
        delegate = state == "PENDING_OFFICE_DELEGATION" && RoleModel.canDelegateBranch(roles)
        let pendingAssignment = state == "PENDING_ENGINEER_ASSIGNMENT" && RoleModel.canAssignEngineer(roles)
        assign = pendingAssignment && assessment.isBranchRoute
        assignNotOnThisRoute = pendingAssignment && !assessment.isBranchRoute
        let isAssignee = meId != nil && assessment.assignedEngineerUserId == meId
        submit = (state == "DRAFT" || state == "REVISION_REQUESTED") && (RoleModel.isAdmin(roles) || isAssignee)
        review = state == "SUBMITTED" && assessment.canReview == true
        explainReview = state == "SUBMITTED"
    }
}
