import Foundation

/// Any JSON value, for server fields the app shows or passes along but does
/// not interpret.
public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

// MARK: - Sign-in

/// `GET /auth/config`: which sign-in methods the server offers.
public struct AuthConfig: Decodable, Equatable, Sendable {
    public let localLoginEnabled: Bool
    public let entraEnabled: Bool
    public let sessionIdleMinutes: Int?
    public let sessionAbsoluteMinutes: Int?
    /// The ERIS Mobile public client, or nil when mobile sign-in is off.
    public let entraMobile: EntraMobileConfig?
}

public struct EntraMobileConfig: Codable, Equatable, Sendable {
    /// `https://login.microsoftonline.com/<tenant-id>`
    public let authority: String
    public let clientId: String
    /// The ERIS API scope, `api://<web-app-id>/access_as_user`.
    public let scopes: [String]

    public init(authority: String, clientId: String, scopes: [String]) {
        self.authority = authority
        self.clientId = clientId
        self.scopes = scopes
    }
}

/// `POST /auth/entra/native`: the ERIS session for this device.
public struct SessionResponse: Decodable, Equatable, Sendable {
    public let accessToken: String
    public let tokenType: String
    public let expiresAt: String?
}

/// `GET /auth/me`.
public struct Me: Decodable, Equatable, Sendable {
    public let id: Int
    public let email: String
    public let fullName: String
    public let roles: [String]
    public let maintenanceDistricts: [JSONValue]?
    public let org: Org?

    public struct Org: Decodable, Equatable, Sendable {
        public let officeName: String?
        public let officeShortName: String?
        public let branchName: String?
        public let homeDistrict: String?
        public let jobTitle: String?
    }

    /// Someone holding a duty in a district maintenance workflow; its reports wait in My Work.
    public var hasMaintenanceDistricts: Bool { !(maintenanceDistricts ?? []).isEmpty }

    /// A district duty that includes reporting incidents.
    public var reportsForMaintenance: Bool {
        (maintenanceDistricts ?? []).contains { district in
            if case .object(let fields) = district, case .bool(true)? = fields["report"] { return true }
            return false
        }
    }
}

// MARK: - Notifications

/// One item of the notification feed (the same feed as the web portal's bell).
public struct FeedItem: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let kind: String
    public let title: String
    public let body: String?
    /// A web path; `NotificationRoutes.route` maps it to a screen.
    public let link: String?
    public let actor: String?
    public let createdAt: String?
    public let read: Bool
}

public struct Feed: Decodable, Equatable, Sendable {
    public let items: [FeedItem]
    public let unread: Int
}

public struct UnreadCount: Decodable, Equatable, Sendable {
    public let unread: Int
}

/// `POST /notifications/devices`: this iPhone's APNs registration.
public struct DeviceRegistration: Codable, Equatable, Sendable {
    public let token: String
    public let platform: String

    public init(token: String, platform: String) {
        self.token = token
        self.platform = platform
    }
}

// MARK: - Incidents

public struct IncidentAssignment: Decodable, Equatable, Sendable {
    public let assignmentId: Int?
    public let assigneeUserId: Int?
    public let assignmentMode: String?
    public let assignmentStage: String?
    public let assignedAt: String?
    public let assigneeEmail: String?
    public let assigneeName: String?
}

/// An incident as `GET /incidents` and `GET /incidents/{id}` return it.
/// Enumerated fields stay strings so a new server value never breaks decoding.
public struct Incident: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let incidentKey: String?
    public let title: String?
    public let incidentType: String?
    public let description: String?
    public let firstObservedAt: String?
    public let firstOccurredAt: String?
    public let latitude: Double?
    public let longitude: Double?
    public let district: String?
    public let county: String?
    public let route: String?
    public let postMile: String?
    public let officeCode: String?
    public let currentStage: String
    public let status: String
    public let reporterUserId: Int?
    public let createdAt: String?
    public let updatedAt: String?
    public let resolvedAt: String?
    public let resolutionComment: String?
    public let linkedSubmissionId: Int?
    public let assignment: IncidentAssignment?

    /// "D04 · ALA · 880 · PM 12.3", from whichever parts are known.
    public var locationLine: String {
        var parts: [String] = []
        if let district, !district.isEmpty { parts.append("D\(district)") }
        if let county, !county.isEmpty { parts.append(county) }
        if let route, !route.isEmpty { parts.append(route) }
        if let postMile, !postMile.isEmpty { parts.append("PM \(postMile)") }
        return parts.joined(separator: " · ")
    }

    public var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let incidentKey, !incidentKey.isEmpty { return incidentKey }
        return "Incident #\(id)"
    }
}

public struct IncidentList: Decodable, Equatable, Sendable {
    public let items: [Incident]
}

public enum IncidentLabels {
    public static func status(_ status: String) -> String {
        switch status {
        case "NEW": return "New"
        case "IN_PROGRESS": return "In progress"
        case "RESOLVED": return "Resolved"
        default: return status
        }
    }

    public static func stage(_ stage: String) -> String {
        switch stage {
        case "COORDINATOR_REVIEW": return "Coordinator review"
        case "OFFICE_CHIEF_REVIEW": return "Office chief review"
        case "BRANCH_CHIEF_REVIEW": return "Branch chief review"
        case "ENGINEER_ASSIGNED": return "Staff assigned"
        case "RESOLVED": return "Resolved"
        default: return stage
        }
    }
}
