import Foundation

/// A report moving through its district's maintenance workflow
/// (`GET /maintenance-work/incidents`), as My Work lists it.
public struct MaintenanceReport: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let title: String?
    public let district: String
    public let outcome: String?
    public let stepName: String
    public let waitingReporter: Bool
    /// This person's action is needed.
    public let myTurn: Bool
    /// Whether this person filed it, when the server says.
    public let reportedByMe: Bool?

    enum CodingKeys: String, CodingKey {
        case id, title, district, outcome
        case stepName = "step_name", waitingReporter = "waiting_reporter", myTurn = "my_turn", reportedByMe = "reported_by_me"
    }

    public init(id: Int, title: String?, district: String, outcome: String?, stepName: String, waitingReporter: Bool, myTurn: Bool,
                reportedByMe: Bool? = nil) {
        self.reportedByMe = reportedByMe
        self.id = id
        self.title = title
        self.district = district
        self.outcome = outcome
        self.stepName = stepName
        self.waitingReporter = waitingReporter
        self.myTurn = myTurn
    }

    /// Where it stands, in a few words.
    public var status: String {
        if let outcome { return outcome == "GEOTECH" ? "Sent to GeoTech" : "Maintenance handles it" }
        return waitingReporter ? "Waiting on reporter" : stepName
    }

    /// "District 4".
    public var districtLabel: String { "District \(Int(district).map(String.init) ?? district)" }
}

/// One report's place in its review path, with what this person may do
/// (`GET /maintenance-work/incidents/{id}`). Ported from the web's
/// MaintenanceWorkflowPanel.
public struct MaintenanceWorkflow: Decodable, Equatable, Sendable {
    public struct Step: Decodable, Equatable, Sendable {
        public let name: String
        public let kind: String
        public let rule: String?
        public let requestInformation: Bool?
        public let allowMaintenance: Bool?
        public let allowGeotech: Bool?

        enum CodingKeys: String, CodingKey {
            case name, kind, rule
            case requestInformation = "request_information", allowMaintenance = "allow_maintenance", allowGeotech = "allow_geotech"
        }
    }

    public struct State: Decodable, Equatable, Sendable {
        public struct Decision: Decodable, Equatable, Sendable {
            public let eventGroupId: Int?
            public let newGroupTitle: String?
            enum CodingKeys: String, CodingKey { case eventGroupId = "event_group_id", newGroupTitle = "new_group_title" }
        }

        public let stepIndex: Int
        public let approvedUserIds: [Int]
        public let waitingReporter: Bool
        public let pendingOutcome: String?
        public let decision: Decision?

        enum CodingKeys: String, CodingKey {
            case decision
            case stepIndex = "step_index", approvedUserIds = "approved_user_ids", waitingReporter = "waiting_reporter"
            case pendingOutcome = "pending_outcome"
        }
    }

    public struct Person: Decodable, Equatable, Identifiable, Sendable {
        public let id: Int
        public let fullName: String
        public let isActive: Bool?
        enum CodingKeys: String, CodingKey { case id, fullName = "full_name", isActive = "is_active" }
    }

    public struct Event: Decodable, Equatable, Identifiable, Sendable {
        public let id: Int
        public let action: String
        public let notes: String?
        public let actorName: String?
        public let createdAt: String?
        enum CodingKeys: String, CodingKey { case id, action, notes, actorName = "actor_name", createdAt = "created_at" }

        /// "Review completed", as the history lists it.
        public var label: String {
            [
                "REPORTED": "Report filed", "APPROVE": "Review completed", "REQUEST_INFORMATION": "Reporter information requested",
                "RESUBMIT": "Information supplied", "EDIT": "Report edited", "MAINTENANCE": "Maintenance handles it",
                "GEOTECH": "GeoTech referral", "RESTART": "Restarted on current district workflow",
            ][action] ?? action
        }
    }

    public struct Group: Decodable, Equatable, Identifiable, Sendable {
        public let id: Int
        public let title: String
    }

    public struct StepName: Decodable, Equatable, Sendable {
        public let name: String
        public let kind: String
    }

    public let incidentId: Int
    public let district: String
    public let revision: Int
    public let version: Int
    public let state: State
    public let step: Step
    public let steps: [StepName]
    public let outcome: String?
    public let assigned: [Person]
    public let events: [Event]
    public let groups: [Group]
    public let canAct: Bool
    public let canEdit: Bool
    public let canResubmit: Bool
    public let canRestart: Bool

    enum CodingKeys: String, CodingKey {
        case district, revision, version, state, step, steps, outcome, assigned, events, groups
        case incidentId = "incident_id", canAct = "can_act", canEdit = "can_edit", canResubmit = "can_resubmit"
        case canRestart = "can_restart"
    }

    public enum Action: String, CaseIterable, Identifiable, Sendable {
        case approve = "APPROVE", maintenance = "MAINTENANCE", geotech = "GEOTECH"
        case requestInformation = "REQUEST_INFORMATION", resubmit = "RESUBMIT", edit = "EDIT", restart = "RESTART"

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .approve: return "Complete review and continue"
            case .maintenance: return "Maintenance can handle it — end review"
            case .geotech: return "Send to GeoTech"
            case .requestInformation: return "Ask the reporter for more information"
            case .resubmit: return "Supply information and return for review"
            case .edit: return "Update the report description"
            case .restart: return "Restart using the latest district workflow"
            }
        }

        /// The report's description goes with it, and review starts again at step one.
        public var changesDescription: Bool { self == .edit || self == .resubmit }
    }

    /// What this person may do now, in the panel's order.
    public var actions: [Action] {
        var out: [Action] = []
        if canAct {
            let pending = state.pendingOutcome
            if step.kind == "REVIEW" && pending == nil { out.append(.approve) }
            if step.allowMaintenance == true && (pending == nil || pending == "MAINTENANCE") { out.append(.maintenance) }
            if step.allowGeotech == true && (pending == nil || pending == "GEOTECH") { out.append(.geotech) }
            if step.requestInformation == true { out.append(.requestInformation) }
        }
        if canResubmit { out.append(.resubmit) }
        if canEdit { out.append(.edit) }
        if canRestart { out.append(.restart) }
        return out
    }

    /// Where the review stands, in a sentence.
    public var standing: String {
        if let outcome {
            return outcome == "GEOTECH" ? "Maintenance review ended: sent to GeoTech." : "Maintenance review ended: maintenance handles the repair."
        }
        if state.waitingReporter { return "Waiting for more information from the reporter." }
        return "Current step: \(step.name) · \(step.rule == "ALL" ? "Every assigned person must agree" : "Any assigned person may act")"
    }

    /// Who is assigned, and the reviews recorded so far.
    public var assignedLine: String? {
        guard outcome == nil else { return nil }
        let names = assigned.map { "\($0.fullName)\($0.isActive == false ? " (inactive — ask a manager to update the workflow)" : "")" }
            .joined(separator: ", ")
        let count = state.approvedUserIds.count
        guard count > 0 else { return "Assigned: \(names)." }
        let towards = state.pendingOutcome.map { $0 == "GEOTECH" ? " for GeoTech referral" : " for maintenance handling" } ?? ""
        return "Assigned: \(names). \(count) review\(count == 1 ? "" : "s") recorded\(towards)."
    }

    /// What was done, once it is recorded.
    public var doneMessage: String {
        guard let outcome else { return "Your action was recorded." }
        return outcome == "GEOTECH" ? "Sent to GeoTech." : "Maintenance will handle this incident. The maintenance review is complete."
    }

    /// The request for an action. Notes are required; a referral names its
    /// Incident Group, or a new group's title (nil: the incident's own name).
    public func request(_ action: Action, notes: String, description: String?, groupId: Int?, newGroupTitle: String?) -> [String: JSONValue]? {
        let notes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !notes.isEmpty else { return nil }
        var body: [String: JSONValue] = ["version": .number(Double(version)), "action": .string(action.rawValue), "notes": .string(notes)]
        if action.changesDescription { body["description"] = .string(description ?? "") }
        if action == .geotech {
            body["event_group_id"] = groupId.map { .number(Double($0)) } ?? .null
            let title = (newGroupTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            body["new_group_title"] = groupId == nil && !title.isEmpty ? .string(title) : .null
        }
        return body
    }
}

extension IncidentsAPI {
    public func maintenanceReports() async throws -> [MaintenanceReport] {
        struct Answer: Decodable { let items: [MaintenanceReport] }
        return try await api.get("/maintenance-work/incidents", preservingKeys: true, as: Answer.self).items
    }

    public func maintenanceWorkflow(_ id: Int) async throws -> MaintenanceWorkflow {
        try await api.get("/maintenance-work/incidents/\(id)", preservingKeys: true, as: MaintenanceWorkflow.self)
    }

    /// Records an action; the workflow as it now stands. A stale version is refused (409).
    public func act(on id: Int, _ body: [String: JSONValue]) async throws -> MaintenanceWorkflow {
        try await api.request("POST", "/maintenance-work/incidents/\(id)/actions", body: try JSONEncoder().encode(body),
                              preservingKeys: true, as: MaintenanceWorkflow.self)
    }
}
