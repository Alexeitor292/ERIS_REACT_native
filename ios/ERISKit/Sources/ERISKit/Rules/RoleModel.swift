import Foundation

/// Mirror of the backend role model (app/roles.py), ported from
/// mobile/src/utils/roleModel.ts. For showing and hiding UI only: the server
/// enforces every permission.
public enum Role: String, CaseIterable, Sendable {
    case maintenanceCrew = "MAINTENANCE_CREW"
    case maintenanceCoordinator = "MAINTENANCE_COORDINATOR"
    case officeChief = "OFFICE_CHIEF"
    case branchChief = "BRANCH_CHIEF"
    case seniorSpecialist = "SENIOR_SPECIALIST"
    case staff = "STAFF"
    case guest = "GUEST"
    case admin = "ADMIN"

    public var label: String {
        switch self {
        case .maintenanceCrew: return "Maintenance Crew"
        case .maintenanceCoordinator: return "Maintenance Coordinator"
        case .officeChief: return "Office Chief"
        case .branchChief: return "Branch Chief"
        case .seniorSpecialist: return "Senior Specialist"
        case .staff: return "Staff"
        case .guest: return "Guest"
        case .admin: return "Administrator"
        }
    }
}

public enum RoleModel {
    static let maintenanceReporting: Set<String> = [Role.maintenanceCrew.rawValue]
    static let operational: Set<String> = [
        Role.maintenanceCoordinator.rawValue, Role.officeChief.rawValue, Role.branchChief.rawValue,
        Role.staff.rawValue, Role.seniorSpecialist.rawValue, Role.admin.rawValue,
    ]
    // GUEST is deliberately not operational: read-only over approved records.
    static let publicView: Set<String> = [Role.guest.rawValue]

    /// The role's name; an unknown code is shown as stored.
    public static func label(_ code: String) -> String {
        Role(rawValue: code)?.label ?? code
    }

    public static func has(_ roles: [String], _ role: Role) -> Bool { roles.contains(role.rawValue) }
    public static func isAdmin(_ roles: [String]) -> Bool { has(roles, .admin) }
    public static func isOperationalUser(_ roles: [String]) -> Bool { roles.contains { operational.contains($0) } }

    public static func isMaintenanceOnly(_ roles: [String]) -> Bool {
        if roles.contains(where: { operational.contains($0) }) { return false }
        return roles.contains { maintenanceReporting.contains($0) }
    }

    /// Guest is the account's only role: the most permissive role always wins.
    public static func isPublicOnly(_ roles: [String]) -> Bool {
        if roles.contains(where: { operational.contains($0) || maintenanceReporting.contains($0) }) { return false }
        return roles.contains { publicView.contains($0) }
    }

    public static func isWorkforceUser(_ roles: [String]) -> Bool {
        isOperationalUser(roles) || roles.contains { maintenanceReporting.contains($0) }
    }

    public static func canTriage(_ roles: [String]) -> Bool { isAdmin(roles) || has(roles, .maintenanceCoordinator) }
    public static func canDelegateBranch(_ roles: [String]) -> Bool { isAdmin(roles) || has(roles, .officeChief) }
    public static func canAssignEngineer(_ roles: [String]) -> Bool { isAdmin(roles) || has(roles, .branchChief) }
    public static func isStaff(_ roles: [String]) -> Bool { isAdmin(roles) || has(roles, .staff) }
    public static func isSeniorSpecialist(_ roles: [String]) -> Bool { isAdmin(roles) || has(roles, .seniorSpecialist) }
    public static func isAssessmentAuthor(_ roles: [String]) -> Bool { isStaff(roles) || isSeniorSpecialist(roles) }

    /// Exactly the server's FIELD_REPORTING_ROLES.
    public static func canReportIncident(_ roles: [String]) -> Bool {
        isAdmin(roles) || has(roles, .maintenanceCrew) || has(roles, .staff)
    }

    public static func assessmentStateLabel(_ state: String) -> String {
        switch state {
        case "PENDING_OFFICE_DELEGATION": return "Pending office delegation"
        case "PENDING_ENGINEER_ASSIGNMENT": return "Pending Staff assignment"
        case "DRAFT": return "Draft"
        case "SUBMITTED": return "Submitted for review"
        case "REVISION_REQUESTED": return "Revision requested"
        case "APPROVED": return "Approved"
        case "FINALIZED": return "Finalized"
        default: return state
        }
    }
}
