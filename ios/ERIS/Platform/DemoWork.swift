#if DEBUG
import ERISKit
import Foundation

/// The demo's My Work: a field report to triage, maintenance reports in a
/// district workflow (one waiting on this person, one to read, one sent back
/// to them as its reporter), and a form share to approve. Each step changes
/// the sample data, so a whole decision can be clicked through.
struct DemoWork {
    private var triaged: Set<Int> = []
    private var shareDecided = false
    private var nextAssessment = 8
    private var runs: [Int: Run] = [
        20: Run(title: "Culvert overflowing on SR-84", reporter: 7),
        21: Run(title: "Shoulder slump near PM 3.1", reporter: 9, assigned: [44]),
        22: Run(title: "Ditch blocked below the cut", reporter: DemoData.meId, waitingReporter: true),
    ]

    struct Run {
        let title: String
        let reporter: Int
        var assigned: [Int] = [DemoData.meId]
        var waitingReporter = false
        var stepIndex = 0
        var outcome: String?
        var version = 1
        var description = "Water over the road after the storm; the inlet is full of debris."
        var events: [[String: Any]] = [["id": 1, "action": "REPORTED", "notes": NSNull(), "actor_name": "Field reporter",
                                         "created_at": "2026-10-28T07:10:00"]]
    }

    static let steps: [[String: Any]] = [
        ["name": "Supervisor review", "kind": "REVIEW", "duty_ids": [], "notify_duty_ids": [], "rule": "ANY",
         "request_information": true, "allow_maintenance": true, "allow_geotech": false],
        ["name": "District decision", "kind": "DECISION", "duty_ids": [], "notify_duty_ids": [], "rule": "ANY",
         "request_information": true, "allow_maintenance": true, "allow_geotech": true],
    ]

    /// Answers the My Work routes; nil for any other.
    mutating func route(_ method: String, _ parts: [String], _ query: [URLQueryItem], _ body: [String: Any],
                        incidents: inout [[String: Any]], assessments: inout [[String: Any]]) -> (Int, Any)? {
        switch (method, parts) {
        case ("POST", ["incidents"]):
            var filed = body
            filed["id"] = 30 + incidents.count
            filed["reporter_user_id"] = DemoData.meId
            filed["current_stage"] = "COORDINATOR_REVIEW"
            filed["status"] = "NEW"
            filed["created_at"] = "2026-10-28T12:00:00Z"
            incidents.append(filed)
            return (200, ["incident": filed])
        case ("POST", let p) where p.count == 3 && p[0] == "incidents" && p[2] == "attachments":
            return (200, ["attachment_id": 990])
        case ("GET", ["incidents"]) where query.contains(where: { $0.name == "queue" && $0.value == "triage" }):
            return (200, ["items": incidents.filter { $0["current_stage"] as? String == "COORDINATOR_REVIEW" && !triaged.contains($0["id"] as? Int ?? 0) }])
        case ("GET", let p) where p.count == 2 && p[0] == "incidents" && runs[Int(p[1]) ?? 0] != nil:
            return (200, ["incident": incident(Int(p[1])!)])
        case ("GET", let p) where p.count == 3 && p[0] == "incidents" && p[2] == "attachments":
            let photo = DemoData.samplePhoto
            return (200, ["incident_id": Int(p[1]) ?? 0, "items": [[
                "attachment_id": 801, "kind": "PHOTO", "file_name": "field-photo-sample.jpg", "mime_type": "image/jpeg",
                "captured_at": "2026-10-28T07:05:00",
                "download_url": "data:image/jpeg;base64,\(photo.data.base64EncodedString())"]]])
        case ("GET", let p) where p.count == 3 && p[0] == "incidents" && p[2] == "nearby-event-groups":
            return (200, ["items": [["id": 3, "title": "I-880 slides, October storm", "incident_count": 2, "nearest_distance_m": 640.0]]])
        case ("POST", let p) where p.count == 3 && p[0] == "incidents" && p[2] == "triage":
            guard let id = Int(p[1]) else { return nil }
            triaged.insert(id)
            if let index = incidents.firstIndex(where: { $0["id"] as? Int == id }) {
                incidents[index]["current_stage"] = body["disposition"] as? String == "ASSESSMENT_REQUIRED" ? "OFFICE_CHIEF_REVIEW" : "CLOSED"
            }
            guard body["disposition"] as? String == "ASSESSMENT_REQUIRED" else { return (200, ["incident_id": id]) }
            nextAssessment += 1
            var opened = assessments[0]
            opened["id"] = nextAssessment
            opened["incident_id"] = id
            opened["state"] = "PENDING_OFFICE_DELEGATION"
            assessments.append(opened)
            return (200, ["incident_id": id, "assessment": ["id": nextAssessment]])
        case ("GET", ["maintenance-work", "incidents"]):
            return (200, ["items": runs.keys.sorted(by: >).map { id in
                let run = runs[id]!
                return ["id": id, "title": run.title, "district": "04", "outcome": run.outcome ?? NSNull(),
                        "step_name": (Self.steps[run.stepIndex]["name"] as? String) ?? "", "waiting_reporter": run.waitingReporter,
                        "my_turn": myTurn(run), "reported_by_me": run.reporter == DemoData.meId] as [String: Any]
            }])
        case ("GET", let p) where p.count == 3 && p[0] == "maintenance-work" && p[1] == "incidents":
            guard let id = Int(p[2]), runs[id] != nil else { return (404, ["detail": "Maintenance report not found"]) }
            return (200, detail(id))
        case ("POST", let p) where p.count == 4 && p[0] == "maintenance-work" && p[3] == "actions":
            guard let id = Int(p[2]) else { return nil }
            return act(id, body)
        case ("GET", ["shares", "reviews"]):
            return (200, ["items": shareDecided ? [] : [Self.share]])
        case ("POST", let p) where p.count == 4 && p[0] == "shares" && p[2] == "reviews":
            shareDecided = true
            return (200, ["share_id": 3, "status": body["decision"] as? String == "APPROVE" ? "PENDING" : "REJECTED"])
        default:
            return nil
        }
    }

    private func myTurn(_ run: Run) -> Bool {
        guard run.outcome == nil else { return false }
        return run.waitingReporter ? run.reporter == DemoData.meId : run.assigned.contains(DemoData.meId)
    }

    private func incident(_ id: Int) -> [String: Any] {
        let run = runs[id]!
        return ["id": id, "title": run.title, "description": run.description, "first_observed_at": "2026-10-28T07:00:00Z",
                "latitude": 37.6, "longitude": -121.9, "district": "04", "county": "ALA", "route": "84", "post_mile": "5.2",
                "current_stage": "MAINTENANCE_REVIEW", "status": "NEW", "reporter_user_id": run.reporter,
                "created_at": "2026-10-28T07:10:00Z", "maintenance_workflow": true]
    }

    private func detail(_ id: Int) -> [String: Any] {
        let run = runs[id]!
        let mine = myTurn(run)
        return ["incident_id": id, "district": "04", "revision": 2, "version": run.version,
                "state": ["step_index": run.stepIndex, "approved_user_ids": [], "waiting_reporter": run.waitingReporter],
                "step": Self.steps[run.stepIndex], "steps": Self.steps.map { ["name": $0["name"]!, "kind": $0["kind"]!] },
                "outcome": run.outcome ?? NSNull(),
                "assigned": run.assigned.map { ["id": $0, "full_name": $0 == DemoData.meId ? "Demo User" : "R. Alvarez", "is_active": true] },
                "events": run.events, "groups": [["id": 3, "title": "I-880 slides, October storm"]],
                "can_act": mine && !run.waitingReporter, "can_edit": run.outcome == nil && run.reporter == DemoData.meId,
                "can_resubmit": run.outcome == nil && run.waitingReporter && run.reporter == DemoData.meId, "can_restart": false]
    }

    private mutating func act(_ id: Int, _ body: [String: Any]) -> (Int, Any) {
        guard var run = runs[id] else { return (404, ["detail": "Maintenance report not found"]) }
        guard body["version"] as? Int == run.version else {
            return (409, ["detail": "Someone else acted on this report first. It has been reloaded."])
        }
        let action = body["action"] as? String ?? ""
        switch action {
        case "APPROVE": run.stepIndex = min(run.stepIndex + 1, Self.steps.count - 1)
        case "MAINTENANCE", "GEOTECH": run.outcome = action
        case "REQUEST_INFORMATION": run.waitingReporter = true
        case "RESUBMIT", "EDIT":
            run.waitingReporter = false
            run.stepIndex = 0
            if let text = body["description"] as? String { run.description = text }
        default: return (400, ["detail": "Unknown action"])
        }
        run.version += 1
        run.events.append(["id": run.events.count + 1, "action": action, "notes": body["notes"] ?? NSNull(),
                           "actor_name": "Demo User", "created_at": "2026-10-28T12:00:00"])
        runs[id] = run
        return (200, detail(id))
    }

    static let share: [String: Any] = [
        "review_id": 8, "share_id": 3, "kind": "APPROVAL", "unit_label": "Branch C", "status": "PENDING",
        "created_at": "2026-10-28T08:30:00", "submission": ["id": 501, "title": "I-880 slope failure GISA"],
        "owner": ["id": DemoData.meId, "full_name": "Demo User", "email": "demo.user@dot.ca.gov", "placement": "Branch C"],
        "sharer": ["id": DemoData.meId, "full_name": "Demo User", "email": "demo.user@dot.ca.gov"],
        "recipient": ["id": 52, "full_name": "B. Nakamura", "email": "b.nakamura@dot.ca.gov", "placement": "Branch A"],
        "reviews": [["id": 8, "unit_label": "Branch C", "kind": "APPROVAL", "decision": "PENDING", "decided_by": NSNull()],
                    ["id": 9, "unit_label": "Branch A", "kind": "APPROVAL", "decision": "APPROVED", "decided_by": "M. Okafor"]],
    ]
}
#endif
