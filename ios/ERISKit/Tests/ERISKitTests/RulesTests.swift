import XCTest
@testable import ERISKit

/// Ported from mobile/src/utils/roleModel.test.ts and notificationRoutes.test.ts.
final class RoleModelTests: XCTestCase {
    let retired = [
        "MAINTENANCE", "MAINTENANCE_FIELD_WORKER", "MAINT_COORDINATOR", "GEOTECH_OFFICE_CHIEF",
        "GEOTECH_BRANCH_CHIEF", "GEOTECH_ENGINEER", "GEOTECH_SENIOR_ENGINEER", "FIELD_WORKER",
        "CALTRANS_VIEWER", "REVIEWER",
    ]

    var gates: [(String, ([String]) -> Bool)] {
        [
            ("isOperationalUser", RoleModel.isOperationalUser), ("isMaintenanceOnly", RoleModel.isMaintenanceOnly),
            ("isPublicOnly", RoleModel.isPublicOnly), ("isWorkforceUser", RoleModel.isWorkforceUser),
            ("canTriage", RoleModel.canTriage), ("canDelegateBranch", RoleModel.canDelegateBranch),
            ("canAssignEngineer", RoleModel.canAssignEngineer), ("isStaff", RoleModel.isStaff),
            ("isSeniorSpecialist", RoleModel.isSeniorSpecialist), ("isAssessmentAuthor", RoleModel.isAssessmentAuthor),
            ("canReportIncident", RoleModel.canReportIncident), ("isAdmin", RoleModel.isAdmin),
        ]
    }

    func testTheRolesAreTheSevenWorkRolesAndTheAdministrator() {
        XCTAssertEqual(Role.allCases.map { RoleModel.label($0.rawValue) }, [
            "Maintenance Crew", "Maintenance Coordinator", "Office Chief", "Branch Chief",
            "Senior Specialist", "Staff", "Guest", "Administrator",
        ])
        for role in Role.allCases {
            XCTAssertNil(role.label.range(of: "engineer", options: .caseInsensitive))
        }
    }

    func testARetiredCodeOpensNothing() {
        for code in retired {
            for (name, gate) in gates { XCTAssertFalse(gate([code]), "\(name)(\(code))") }
            XCTAssertEqual(RoleModel.label(code), code)
        }
    }

    func testEachRoleReachesItsOwnWork() {
        XCTAssertTrue(RoleModel.canReportIncident(["MAINTENANCE_CREW"]))
        XCTAssertTrue(RoleModel.isMaintenanceOnly(["MAINTENANCE_CREW"]))
        XCTAssertTrue(RoleModel.canTriage(["MAINTENANCE_COORDINATOR"]))
        XCTAssertTrue(RoleModel.canDelegateBranch(["OFFICE_CHIEF"]))
        XCTAssertTrue(RoleModel.canAssignEngineer(["BRANCH_CHIEF"]))
        XCTAssertTrue(RoleModel.isAssessmentAuthor(["STAFF"]))
        XCTAssertTrue(RoleModel.isAssessmentAuthor(["SENIOR_SPECIALIST"]))
        XCTAssertFalse(RoleModel.isStaff(["SENIOR_SPECIALIST"]))
        XCTAssertFalse(RoleModel.has(["STAFF"], .seniorSpecialist))
        XCTAssertFalse(RoleModel.canReportIncident(["SENIOR_SPECIALIST"]))
        XCTAssertFalse(RoleModel.canReportIncident(["MAINTENANCE_COORDINATOR"]))
    }

    func testTheGuestIsReadOnlyUnlessAnotherRoleSaysOtherwise() {
        XCTAssertTrue(RoleModel.isPublicOnly(["GUEST"]))
        for (name, gate) in gates where name != "isPublicOnly" { XCTAssertFalse(gate(["GUEST"]), name) }
        XCTAssertFalse(RoleModel.isPublicOnly(["GUEST", "OFFICE_CHIEF"]))
        XCTAssertTrue(RoleModel.canDelegateBranch(["GUEST", "OFFICE_CHIEF"]))
    }

    func testTheAdministratorPassesEveryWorkflowGate() {
        let admin = ["ADMIN"]
        XCTAssertTrue(RoleModel.canTriage(admin))
        XCTAssertTrue(RoleModel.canDelegateBranch(admin))
        XCTAssertTrue(RoleModel.canAssignEngineer(admin))
        XCTAssertTrue(RoleModel.isAssessmentAuthor(admin))
        XCTAssertTrue(RoleModel.canReportIncident(admin))
        XCTAssertTrue(RoleModel.isWorkforceUser(admin))
        XCTAssertFalse(RoleModel.isMaintenanceOnly(admin))
        XCTAssertFalse(RoleModel.isPublicOnly(admin))
    }
}

final class NotificationRoutesTests: XCTestCase {
    func testEachNoticeOpensTheScreenThatDoesTheSameJob() {
        XCTAssertEqual(NotificationRoutes.route(link: "/my-work", kind: "INCIDENT_COORDINATOR_REVIEW"), .trackIncidents)
        XCTAssertEqual(NotificationRoutes.route(link: "/incidents/42", kind: "ASSESSMENT_APPROVED_COORDINATOR"), .incident(42))
        XCTAssertEqual(NotificationRoutes.route(link: "/submissions/7", kind: "SHARE_RECEIVED"), .submission(7))
        XCTAssertEqual(NotificationRoutes.route(link: "/my-work?assessment=9", kind: "ASSESSMENT_STAFF_ASSIGNMENT"), .assessment(9))
        XCTAssertEqual(NotificationRoutes.route(link: "/assessments/9", kind: "ASSESSMENT_APPROVED_AUTHOR"), .assessment(9))
        XCTAssertEqual(NotificationRoutes.route(link: "/assessments", kind: "X"), .assessments)
        XCTAssertEqual(NotificationRoutes.route(link: "/my-work", kind: "SHARE_APPROVAL"), .assessments, "an approval waits in My Work")
        XCTAssertEqual(NotificationRoutes.route(link: "/my-work?share=8", kind: "SHARE_NOTICE"), .share(review: 8), "a notice opens by itself")
        XCTAssertEqual(NotificationRoutes.route(link: "/my-work?maintenance=42", kind: "MAINTENANCE_WORKFLOW"),
                       .maintenance(incident: 42))
        XCTAssertEqual(NotificationRoutes.route(link: "/maintenance-work?incident=42", kind: "MAINTENANCE_WORKFLOW"),
                       .maintenance(incident: 42), "an earlier notice")
    }

    func testALinkWithNoScreenStaysInTheList() {
        XCTAssertNil(NotificationRoutes.route(link: nil, kind: "SHARE_ENDED"))
        XCTAssertNil(NotificationRoutes.route(link: "/incidents/abc", kind: "X"))
    }

    func testTheBadgeIsQuietAtZeroAndCapsAtNinePlus() {
        XCTAssertNil(NotificationRoutes.badgeText(0))
        XCTAssertEqual(NotificationRoutes.badgeText(4), "4")
        XCTAssertEqual(NotificationRoutes.badgeText(40), "9+")
    }

    func testAStepAlreadyTakenIsNotUnreadThoughNeverOpened() throws {
        func item(_ extra: String) throws -> FeedItem {
            let json = #"{"id":1,"kind":"K","title":"T",\#(extra)}"#
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            return try decoder.decode(FeedItem.self, from: Data(json.utf8))
        }
        XCTAssertTrue(try item(#""read":false"#).isUnread)
        XCTAssertTrue(try item(#""read":false,"done":null"#).isUnread)
        XCTAssertFalse(try item(#""read":true,"done":null"#).isUnread)
        XCTAssertFalse(try item(#""read":false,"done":{"at":"2026-10-25T11:00:00","by":"M. Okafor","by_you":false,"action":"ASSIGN","state":"DRAFT"}"#).isUnread)
        // Its step can be done with no one recorded as having taken it.
        XCTAssertFalse(try item(#""read":false,"done":{"at":null,"by":null,"by_you":false,"action":null,"state":"APPROVED"}"#).isUnread)
    }

    func testDeviceTokensAreLowercaseHexForTheRightGateway() {
        let token = Data([0x00, 0xAB, 0x10, 0xFF])
        XCTAssertEqual(PushRegistration.hex(token), "00ab10ff")
        XCTAssertEqual(PushRegistration.registration(token: token, sandbox: true).platform, "apns-sandbox")
        XCTAssertEqual(PushRegistration.registration(token: token, sandbox: false).platform, "apns")
    }
}

final class EntraAuthorityTests: XCTestCase {
    let tenant = "11111111-1111-4111-8111-111111111111"

    func testMicrosoftTenantAuthoritiesAreAccepted() throws {
        XCTAssertEqual(try EntraAuthority.validated("https://login.microsoftonline.com/\(tenant)"),
                       "https://login.microsoftonline.com/\(tenant)")
        XCTAssertEqual(try EntraAuthority.validated("https://LOGIN.microsoftonline.us/\(tenant.uppercased())/"),
                       "https://login.microsoftonline.us/\(tenant)")
    }

    func testAnythingElseIsRefused() {
        for authority in [
            "https://evil.example/\(tenant)",
            "http://login.microsoftonline.com/\(tenant)",
            "https://login.microsoftonline.com/common",
            "https://login.microsoftonline.com/\(tenant)/oauth2",
            "https://login.microsoftonline.com.evil.example/\(tenant)",
            "https://login.microsoftonline.com/\(tenant)?x=1",
            "not a url",
        ] {
            XCTAssertThrowsError(try EntraAuthority.validated(authority), authority) { error in
                XCTAssertEqual(error as? AuthError, .untrustedAuthority)
            }
        }
    }
}
