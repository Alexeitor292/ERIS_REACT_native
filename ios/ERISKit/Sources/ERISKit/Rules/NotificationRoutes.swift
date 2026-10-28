import Foundation

/// A screen in the iOS app. Ported from mobile/src/notifications/notificationRoutes.ts.
public enum AppRoute: Equatable, Hashable, Sendable {
    case trackIncidents
    case incident(Int)
    case submission(Int)
    case assessments
    case maintenance(incident: Int?)
}

public enum NotificationRoutes {
    /// Where a notification leads. The feed stores web paths; steps done on
    /// the web (sharing approvals, office routing) return nil and the list
    /// simply marks them read.
    public static func route(link: String?, kind: String) -> AppRoute? {
        if kind == "INCIDENT_COORDINATOR_REVIEW" { return .trackIncidents }
        guard let link, !link.isEmpty else { return nil }
        let path = String(link.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        if path == "/maintenance-work" { return .maintenance(incident: queryNumber(in: link, named: "incident")) }
        if let id = numberAfter("/incidents/", in: path) { return .incident(id) }
        if let id = numberAfter("/submissions/", in: path) { return .submission(id) }
        if path == "/assessments" || numberAfter("/assessments/", in: path) != nil { return .assessments }
        if path == "/my-work" && link.contains("assessment=") { return .assessments }
        return nil
    }

    /// Nothing at zero, "9+" past nine.
    public static func badgeText(_ unread: Int) -> String? {
        if unread <= 0 { return nil }
        return unread > 9 ? "9+" : String(unread)
    }

    static func numberAfter(_ prefix: String, in path: String) -> Int? {
        guard path.hasPrefix(prefix) else { return nil }
        let rest = path.dropFirst(prefix.count)
        guard !rest.isEmpty, rest.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return Int(rest)
    }

    static func queryNumber(in link: String, named name: String) -> Int? {
        guard let query = link.split(separator: "?", maxSplits: 1).dropFirst().first else { return nil }
        for pair in query.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1)
            if parts.count == 2, parts[0] == Substring(name), let value = Int(parts[1]), value >= 0 {
                return value
            }
        }
        return nil
    }
}

/// APNs device registration.
public enum PushRegistration {
    /// The lowercase hex form APNs and the ERIS API expect.
    public static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// Builds run from Xcode receive sandbox tokens; Enterprise/Intune builds
    /// use the production gateway.
    public static func registration(token: Data, sandbox: Bool) -> DeviceRegistration {
        DeviceRegistration(token: hex(token), platform: sandbox ? "apns-sandbox" : "apns")
    }
}
