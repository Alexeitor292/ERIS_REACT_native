import Foundation

/// The app is a narrow tool: each person gets the tabs their job needs and
/// nothing to browse. The web portal is where records are read.
///
///  - My Work, for anyone with steps waiting on them: coordinators triaging,
///    maintenance reviewers and approvers, office and branch chiefs routing and
///    reviewing, Staff and Senior Specialists on their assigned assessments.
///  - Report, for maintenance reporters: report an incident and follow their own reports.
///  - Forms, for Staff and Senior Specialists: the technical forms they are completing.
///  - Notifications and Account, for everyone.
public enum AppTab: String, CaseIterable, Identifiable, Sendable {
    case myWork, report, forms, notifications, account
    public var id: String { rawValue }

    public static func visible(roles: [String], maintenanceDuties: Bool, reportsForMaintenance: Bool) -> [AppTab] {
        var tabs: [AppTab] = []
        if MyWork.hasQueue(roles: roles, maintenanceDuties: maintenanceDuties) { tabs.append(.myWork) }
        if RoleModel.isAdmin(roles) || RoleModel.has(roles, .maintenanceCrew) || reportsForMaintenance { tabs.append(.report) }
        if RoleModel.isAssessmentAuthor(roles) { tabs.append(.forms) }
        return tabs + [.notifications, .account]
    }

    public static func visible(for me: Me) -> [AppTab] {
        visible(roles: me.roles, maintenanceDuties: me.hasMaintenanceDistricts, reportsForMaintenance: me.reportsForMaintenance)
    }
}

/// The reports a person filed, for the Report tab: their reports the incident
/// list returns, and those in a district maintenance workflow, which the server
/// lists apart and marks `reported_by_me`. From a server too old to mark them,
/// only a report waiting on its reporter is certainly theirs.
public enum MyReports {
    public enum Item: Equatable, Identifiable, Sendable {
        case incident(Incident)
        case maintenance(MaintenanceReport)

        public var id: Int {
            switch self {
            case .incident(let incident): return incident.id
            case .maintenance(let report): return report.id
            }
        }
    }

    public static func items(incidents: [Incident], maintenance: [MaintenanceReport], me: Int) -> [Item] {
        let mine = maintenance.filter { $0.reportedByMe ?? ($0.myTurn && $0.waitingReporter) }
        let inWorkflow = Set(mine.map(\.id))
        let filed = incidents.filter { $0.reporterUserId == me && !inWorkflow.contains($0.id) }
        return (mine.map(Item.maintenance) + filed.map(Item.incident)).sorted { $0.id > $1.id }
    }
}
