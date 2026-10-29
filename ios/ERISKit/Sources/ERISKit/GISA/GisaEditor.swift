import Foundation

/// The GISA editor's state for one submission: the form, the district
/// contacts being edited, the listed incident types and actions, and the
/// errors shown beside fields. The SwiftUI screen only displays it.
public struct GisaEditor: Equatable, Sendable {
    public var form: GisaForm
    /// Kept apart from the form, as in the Expo editor, so a contact just added
    /// (still empty, so not yet stored) keeps its place and identity.
    public internal(set) var contacts: [DistrictContact]
    public var listedIncidentTypes: [String]
    public var actions: SubmissionDetail.Actions
    /// Field key -> message.
    public var errors: [String: String] = [:]
    /// What a save is checked against (FormCollab.swift).
    public internal(set) var base: Base
    /// Fields someone else also changed, waiting for this person's choice.
    public internal(set) var pending: Pending?

    public init(detail: SubmissionDetail) {
        form = detail.form
        contacts = DistrictContact.parse(form["district_contact"])
        // Listed types plus those ticked on the form, as the Expo editor loads them.
        var seen = Set<String>()
        listedIncidentTypes = ((detail.incidentTypes ?? []) + form.tickedIncidentTypes).filter { seen.insert($0).inserted }
        actions = detail.actions ?? .init()
        base = Base(detail: detail, form: form, listed: listedIncidentTypes)
    }

    /// The contacts as the form now stores them.
    mutating func resetContacts() {
        contacts = DistrictContact.parse(form["district_contact"])
    }

    /// Changes a field and clears its error.
    public mutating func set(_ key: String, _ value: String) {
        form[key] = value
        errors[key] = nil
    }

    public mutating func chooseDistrict(_ district: String) {
        form.chooseDistrict(district)
        for key in ["district", "county", "route"] { errors[key] = nil }
    }

    public mutating func chooseCounty(_ code: String) {
        form.chooseCounty(code)
        for key in ["district", "county", "route"] { errors[key] = nil }
    }

    /// Replaces the contacts and stores them in the form.
    public mutating func setContacts(_ next: [DistrictContact]) {
        contacts = next
        set("district_contact", DistrictContact.serialize(next))
    }

    /// What one save sends: only what this person changed, each part with the
    /// saved value it started from, so the server can refuse a field someone
    /// else changed meanwhile. A part left nil is not sent.
    public struct SaveRequest: Equatable, Sendable {
        public let form: GisaForm
        /// The changed columns, and `base`: each one's saved value when this person started.
        public let body: [String: JSONValue]?
        public let incidentTypes: [String: JSONValue]?
        public let actions: [String: JSONValue]?

        public var isEmpty: Bool { body == nil && incidentTypes == nil && actions == nil }
    }

    /// Why a save cannot be sent yet, with the alert the Expo editor shows.
    public struct SaveProblem: Error, Equatable, Sendable {
        public let title: String
        public let message: String

        public init(title: String, message: String) {
            self.title = title
            self.message = message
        }
    }

    /// Checks the form as `saveDraft` does and builds the request, or marks the
    /// fields to fix and says why.
    public mutating func prepareSave(lookups: GisaLookups) -> Result<SaveRequest, SaveProblem> {
        let missing = GisaValidation.draftErrors(form)
        guard missing.isEmpty else {
            errors = missing
            return .failure(SaveProblem(title: "Almost there",
                                        message: "Please fill the highlighted required fields before continuing."))
        }
        // Lists that did not load (offline) cannot judge the codes; the server still checks them.
        let listsLoaded = !lookups.actions.immediate.isEmpty || !lookups.actions.followUp.isEmpty
        if listsLoaded, let problem = GisaValidation.actionGroupProblem(immediate: actions.immediate, followUp: actions.followUp,
                                                           lookups: lookups) {
            return .failure(SaveProblem(title: "Cannot Save Yet", message: problem))
        }
        form = form.enforcingBusinessRules()
        do {
            return .success(try changes())
        } catch let error as GisaFieldError {
            errors[error.key] = error.message
            return .failure(SaveProblem(title: "Almost there", message: error.message))
        } catch {
            return .failure(SaveProblem(title: "Save failed", message: String(describing: error)))
        }
    }

    /// The request for what changed since `base`.
    func changes() throws -> SaveRequest {
        let now = try form.patchBody()
        let was = (try? base.form.patchBody()) ?? [:]
        let keys = now.keys.filter { !FormMerge.savedSame(now[$0], was[$0]) }.sorted()
        var body: [String: JSONValue]?
        if !keys.isEmpty {
            var changed = Dictionary(uniqueKeysWithValues: keys.map { ($0, now[$0] ?? .null) })
            changed["base"] = .object(Dictionary(uniqueKeysWithValues: keys.map { ($0, base.gisa[$0] ?? .null) }))
            body = changed
        }
        func list(_ items: [String]) -> JSONValue { .array(items.map(JSONValue.string)) }
        let items = form.incidentTypeItems(listed: listedIncidentTypes)
        let incidentTypes: [String: JSONValue]? = Set(items) == Set(base.incidentTypes) ? nil
            : ["items": list(items), "base": list(base.incidentTypes)]
        let sameActions = Set(actions.immediate) == Set(base.actions.immediate)
            && Set(actions.followUp) == Set(base.actions.followUp)
        let actionsBody: [String: JSONValue]? = sameActions ? nil : [
            "immediate": list(actions.immediate), "follow_up": list(actions.followUp),
            "base_immediate": list(base.actions.immediate), "base_follow_up": list(base.actions.followUp),
        ]
        return SaveRequest(form: form, body: body, incidentTypes: incidentTypes, actions: actionsBody)
    }
}
