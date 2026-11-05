import Foundation

/// Open work by who holds it (`GET /assessments/workload`), for a chief moving it
/// around. Someone who has moved on is flagged: their work waits to be spread
/// around or all given to whoever took over. An office chief needs none of this
/// for their own successor, since office review goes by office.
public struct Workload: Decodable, Equatable, Sendable {
    public var groups: [HeldWork]
    /// Assessments left by someone who moved on.
    public var left: Int

    public init(groups: [HeldWork] = [], left: Int = 0) {
        self.groups = groups
        self.left = left
    }
}

public struct HeldWork: Decodable, Hashable, Identifiable, Sendable {
    public struct Holder: Decodable, Hashable, Sendable {
        public let id: Int?
        public let fullName: String?
        public let placement: String?
    }

    public struct Item: Decodable, Hashable, Identifiable, Sendable {
        public let id: Int
        public let incidentId: Int
        public let state: String
        public let title: String?
        public let branchLabel: String?
    }

    public enum Kind: String, Decodable, Sendable {
        case branchChief = "BRANCH_CHIEF", staff = "STAFF", seniorSpecialist = "SENIOR_SPECIALIST"

        public var roleLabel: String {
            switch self {
            case .branchChief: return "Branch chief"
            case .staff: return "Staff"
            case .seniorSpecialist: return "Senior Specialist"
            }
        }

        public var pickerTitle: String {
            switch self {
            case .branchChief: return "New branch chief"
            case .staff: return "New Staff member"
            case .seniorSpecialist: return "New Senior Specialist"
            }
        }
    }

    public let kind: Kind
    public let holder: Holder
    public let left: Bool
    public let items: [Item]

    public var id: String { "\(kind.rawValue):\(holder.id.map(String.init) ?? "none")" }

    /// "Lee Left · Staff · has moved on".
    public var holderLine: String {
        let line = "\(holder.fullName ?? "Nobody") · \(kind.roleLabel)"
        return left ? "\(line) · has moved on" : line
    }
}

public struct MoveResult: Decodable, Equatable, Sendable {
    public struct Failure: Decodable, Equatable, Sendable {
        public let id: Int
        public let detail: String
    }

    public let moved: [Int]
    public let failed: [Failure]

    /// What happened, in a sentence.
    public func outcome(to name: String) -> String {
        let count = moved.count
        let said = count > 0 ? "Moved \(count) assessment\(count == 1 ? "" : "s") to \(name). Their work stayed with them." : "Nothing moved."
        guard !failed.isEmpty else { return said }
        return "\(said) Not moved: " + failed.map { "#\($0.id) (\($0.detail))" }.joined(separator: "; ")
    }
}

extension AssessmentsAPI {
    public func workload() async throws -> Workload {
        try await api.get("/assessments/workload", as: Workload.self)
    }

    /// Everyone this group's work could move to, minus the person it is moving from.
    public func moveOptions(_ group: HeldWork) async throws -> RoutingOptions {
        guard let first = group.items.first else { return RoutingOptions(groups: [], items: []) }
        let options: RoutingOptions
        switch group.kind {
        case .branchChief: options = try await branchOptions(first.id)
        case .staff: options = try await engineerOptions(first.id)
        case .seniorSpecialist: options = try await seniorOptions(first.id)
        }
        return RoutingOptions(groups: options.groups, items: options.items.filter { $0.id != group.holder.id })
    }

    public func move(_ assessments: [Int], to user: Int, kind: HeldWork.Kind, notes: String) async throws -> MoveResult {
        var body: [String: JSONValue] = [
            "assessment_ids": .array(assessments.map { .number(Double($0)) }),
            "to_user_id": .number(Double(user)),
            "kind": .string(kind.rawValue),
        ]
        let trimmed = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { body["notes"] = .string(trimmed) }
        return try await api.request("POST", "/assessments/move", body: try JSONEncoder().encode(body), as: MoveResult.self)
    }
}
