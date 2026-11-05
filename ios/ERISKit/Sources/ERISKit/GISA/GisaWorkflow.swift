import Foundation

/// Sending a form for review, deciding it, and telling the maintenance
/// coordinator about immediate actions. The checks and wording are the Expo
/// editor's (submitDraft, notifyCoordinatorNow, review); where the form is sent
/// is the web form's: a form that belongs to an assessment goes for review, and
/// is decided, on that assessment (backend main.py `submit`, `review_submission`).
public enum GisaWorkflow {
    /// One thing a form needs before review, and whether it has it.
    public struct Requirement: Equatable, Identifiable, Sendable {
        public enum Kind: String, Sendable {
            case location, geotechnical, photo, soil, debris
        }

        public let kind: Kind
        public let label: String
        /// Why it is not met yet; nil when it is.
        public let problem: String?

        public var id: Kind { kind }
        public var met: Bool { problem == nil }
    }

    /// What the server checks when a form is sent for review (`validate_submit_ready`),
    /// in the order the Expo editor checks it. Soil and debris appear only when
    /// they apply.
    public static func requirements(form: GisaForm, photoCount: Int) -> [Requirement] {
        let missing = GisaValidation.draftErrors(form)
        let location = GisaValidation.draftRequired.filter { missing[$0.key] != nil }.map(\.label)
        var out = [
            Requirement(kind: .location, label: "Location: district, county, route, post mile and coordinates",
                        problem: location.isEmpty ? nil : "Missing: \(location.joined(separator: ", ")).")
        ]
        out.append(Requirement(kind: .geotechnical, label: "Geotechnical Assessment written",
                               problem: GisaValidation.hasGeotechnicalAssessment(form)
                                   ? nil : "Geotechnical Assessment is required before submitting."))
        out.append(Requirement(kind: .photo, label: "At least one photo",
                               problem: photoCount > 0 ? nil : "Please upload at least one photo before submitting."))
        if form["material_soil"] == "YES" {
            out.append(Requirement(kind: .soil, label: "Material soil shares total 100%",
                                   problem: GisaValidation.soilTotalProblem(form)))
        }
        if let problem = GisaValidation.debrisTotalProblem(form) {
            out.append(Requirement(kind: .debris, label: "Landslide debris shares total 100%", problem: problem))
        } else if ["est_debris_clay_silt_pct", "est_debris_sand_pct", "est_debris_gravel_pct", "est_debris_boulder_pct"]
            .contains(where: { !form[$0].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            out.append(Requirement(kind: .debris, label: "Landslide debris shares total 100%", problem: nil))
        }
        return out
    }

    /// The alert for the first requirement not met, as the Expo editor words it.
    public static func submitProblem(_ requirements: [Requirement]) -> GisaEditor.SaveProblem? {
        guard let first = requirements.first(where: { !$0.met }) else { return nil }
        if first.kind == .location {
            return .init(title: "Almost there", message: "Please fill the highlighted required fields before continuing.")
        }
        return .init(title: "Cannot Submit Yet", message: first.problem ?? "")
    }

    /// The server's "Cannot submit: missing required fields [photo, soil_pct_total(90.00)]"
    /// in words, or nil when the refusal is about something else.
    public static func submitRefusal(_ detail: String) -> String? {
        guard let match = detail.range(of: #"missing required fields \[([^\]]+)\]"#,
                                       options: [.regularExpression, .caseInsensitive]) else { return nil }
        let inside = detail[match].drop { $0 != "[" }.dropFirst().dropLast()
        let missing = inside.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if missing.count == 1, missing[0].lowercased() == "photo" {
            return "Please upload at least one photo before submitting."
        }
        return "Please complete required items before submitting: \(missing.joined(separator: ", "))."
    }

    /// Why the coordinator cannot be notified yet, as the Expo editor words it.
    public static func notifyProblem(immediate: [String], message: String) -> GisaEditor.SaveProblem? {
        if immediate.isEmpty {
            return .init(title: "Immediate Action Required", message: "Select at least one Immediate Action before notifying.")
        }
        if message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .init(title: "Message Required", message: "Please add a justification message before notifying.")
        }
        return nil
    }

    /// A notice to the coordinator already sent from this form.
    public struct CoordinatorNotice: Equatable, Identifiable, Sendable {
        public let id: Int
        public let createdAt: String?
        /// The action codes sent.
        public let actions: [String]
        public let message: String
    }

    /// The coordinator notices on the form, newest first. The server records
    /// each as "Immediate actions: A, B | Message: …".
    public static func coordinatorNotices(_ events: [SubmissionDetail.WorkflowEvent]) -> [CoordinatorNotice] {
        events.filter { $0.eventType == "COORDINATOR_NOTIFIED" }.reversed().map { event in
            let comment = event.comment ?? ""
            let prefix = "Immediate actions: ", separator = " | Message: "
            guard comment.hasPrefix(prefix), let split = comment.range(of: separator) else {
                return CoordinatorNotice(id: event.id, createdAt: event.createdAt, actions: [], message: comment)
            }
            let codes = comment[comment.index(comment.startIndex, offsetBy: prefix.count)..<split.lowerBound]
                .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            return CoordinatorNotice(id: event.id, createdAt: event.createdAt, actions: codes,
                                     message: String(comment[split.upperBound...]))
        }
    }

    /// Labels for action codes, in the order chosen; an unknown code shows as itself.
    public static func actionLabels(_ codes: [String], lookups: GisaLookups) -> [String] {
        let all = lookups.actions.immediate + lookups.actions.followUp
        return codes.map { code in all.first { $0.code == code }?.label ?? code }
    }

    /// Where this form is sent for review and decided.
    public enum Route: Equatable, Sendable {
        /// On its own (a legacy form with no assessment).
        case form
        /// With the assessment it belongs to.
        case assessment(Int)
    }

    public static func route(_ detail: SubmissionDetail) -> Route {
        detail.context?.assessmentId.map(Route.assessment) ?? .form
    }

    /// Whether this person decides the form here: only a submitted legacy form,
    /// and only for those the server allows.
    public static func decidesHere(_ detail: SubmissionDetail) -> Bool {
        route(detail) == .form && detail.submission.status == "SUBMITTED"
            && (detail.submission.canReview == true || detail.context?.canReview == true)
    }

    /// Who holds a submitted form, as the web header words it.
    public static func submittedHint(_ detail: SubmissionDetail) -> String {
        switch detail.context?.assessmentRoutingPath {
        case "BRANCH": return "Awaiting branch chief review"
        case "SENIOR_ENGINEER": return "Awaiting office chief review"
        default: return "Sent for review"
        }
    }

    /// What a decision did, for the alert after it.
    public static func reviewDone(_ decision: SubmissionsAPI.ReviewDecision) -> String {
        decision == .approve ? "Submission approved." : "Submission returned for correction."
    }
}
