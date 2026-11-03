import Foundation

/// Out of the office (`services/delegations.py`): someone names a colleague to act
/// for them between two dates. While it runs, that colleague may switch to acting
/// for them: `APIClient.actingFor` adds a header, and the server then judges each
/// request as the absent person and records who it really was.
public struct Delegation: Decodable, Equatable, Identifiable, Sendable {
    public struct Person: Decodable, Equatable, Sendable {
        public let id: Int
        public let fullName: String
    }

    public let id: Int
    public let delegator: Person
    public let delegate: Person
    public let startsOn: String
    public let endsOn: String
    public let note: String?
    public let status: String
    public let actionCount: Int

    /// Scheduled or running: it can still be cancelled.
    public var isOpen: Bool { status == "SCHEDULED" || status == "ACTIVE" }

    public var statusLabel: String {
        switch status {
        case "SCHEDULED": return "Scheduled"
        case "ACTIVE": return "Active now"
        case "ENDED": return "Ended"
        case "CANCELLED": return "Cancelled"
        default: return status
        }
    }

    public var periodLabel: String {
        let first = DelegationDates.label(startsOn), last = DelegationDates.label(endsOn)
        return startsOn == endsOn ? first : "\(first) to \(last)"
    }
}

public struct DelegationOverview: Decodable, Equatable, Sendable {
    public let given: [Delegation]
    public let received: [Delegation]
    public let actingOptions: [Me.ActingOption]
}

public struct DelegationCandidate: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let fullName: String
    public let placement: String?

    /// "M. Okafor · Branch Chief · OGDW › Branch C".
    public var label: String { [fullName, placement].compactMap { $0 }.joined(separator: " · ") }
}

public struct DelegatedAction: Decodable, Equatable, Sendable {
    public let method: String
    public let path: String
    public let actorName: String?
    public let createdAt: String?

    /// What was done, in words, from the request it was.
    public var label: String {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 2, Int(parts[1]) != nil else {
            return path == "/assessments/move" ? "Moved assessments" : "\(method) \(path)"
        }
        switch parts[0] {
        case "assessments": return parts.last == "review" ? "Reviewed assessment #\(parts[1])" : "Changed assessment #\(parts[1])"
        case "shares": return "Decided share #\(parts[1])"
        case "submissions": return "Changed form #\(parts[1])"
        case "incidents": return "Changed report #\(parts[1])"
        default: return "\(method) \(path)"
        }
    }
}

/// Calendar days as the server sends them ("2026-11-14"), never moved by a time zone.
public enum DelegationDates {
    private static var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    /// The day this date is on the iPhone's own calendar, as the server wants it.
    public static func string(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// "Nov 14, 2026"; anything unreadable as sent.
    public static func label(_ day: String) -> String {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, let date = utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return day }
        var style = Date.FormatStyle(date: .abbreviated, time: .omitted)
        style.timeZone = utc.timeZone
        return date.formatted(style)
    }

    /// Why these cannot be sent yet, or nil. The server checks all of it again.
    public static func problem(delegate: Int?, first: Date, last: Date, today: Date = Date(), calendar: Calendar = .current) -> String? {
        if delegate == nil { return "Choose who will act for you." }
        let from = string(first, calendar: calendar), to = string(last, calendar: calendar)
        if to < from { return "The last day cannot be before the first day." }
        if to < string(today, calendar: calendar) { return "The last day has already passed." }
        return nil
    }
}

public struct DelegationsAPI: Sendable {
    public let api: APIClient
    public init(api: APIClient) { self.api = api }

    public func overview() async throws -> DelegationOverview {
        try await api.get("/delegations", as: DelegationOverview.self)
    }

    /// Whom else the caller may set one for, as their chief.
    public func people() async throws -> [Delegation.Person] {
        struct Answer: Decodable { let items: [Delegation.Person] }
        return try await api.get("/delegations/people", as: Answer.self).items
    }

    public func candidates(forUser user: Int? = nil) async throws -> [DelegationCandidate] {
        struct Answer: Decodable { let items: [DelegationCandidate] }
        let query = user.map { [URLQueryItem(name: "for_user_id", value: String($0))] } ?? []
        return try await api.get("/delegations/candidates", query: query, as: Answer.self).items
    }

    public func create(delegate: Int, first: Date, last: Date, note: String, forUser: Int? = nil, calendar: Calendar = .current) async throws {
        var body: [String: JSONValue] = [
            "delegate_user_id": .number(Double(delegate)),
            "starts_on": .string(DelegationDates.string(first, calendar: calendar)),
            "ends_on": .string(DelegationDates.string(last, calendar: calendar)),
        ]
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { body["note"] = .string(trimmed) }
        if let forUser { body["for_user_id"] = .number(Double(forUser)) }
        _ = try await api.request("POST", "/delegations", body: try JSONEncoder().encode(body), as: EmptyResponse.self)
    }

    public func cancel(_ id: Int) async throws {
        _ = try await api.request("POST", "/delegations/\(id)/cancel", as: EmptyResponse.self)
    }

    public func actions(_ id: Int) async throws -> [DelegatedAction] {
        struct Answer: Decodable { let items: [DelegatedAction] }
        return try await api.get("/delegations/\(id)/actions", as: Answer.self).items
    }
}
