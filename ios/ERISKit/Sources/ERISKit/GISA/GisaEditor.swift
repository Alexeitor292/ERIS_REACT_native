import Foundation

/// The GISA editor's state for one submission: the form, the district
/// contacts being edited, the listed incident types and actions, and the
/// errors shown beside fields. The SwiftUI screen only displays it.
public struct GisaEditor: Equatable, Sendable {
    public var form: GisaForm
    /// Kept apart from the form, as in the Expo editor, so a contact just added
    /// (still empty, so not yet stored) keeps its place and identity.
    public private(set) var contacts: [DistrictContact]
    public var listedIncidentTypes: [String]
    public var actions: SubmissionDetail.Actions
    /// Field key -> message.
    public var errors: [String: String] = [:]

    public init(detail: SubmissionDetail) {
        form = detail.form
        contacts = DistrictContact.parse(form["district_contact"])
        // Listed types plus those ticked on the form, as the Expo editor loads them.
        var seen = Set<String>()
        listedIncidentTypes = ((detail.incidentTypes ?? []) + form.tickedIncidentTypes).filter { seen.insert($0).inserted }
        actions = detail.actions ?? .init()
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

    /// Everything one save sends.
    public struct SaveRequest: Equatable, Sendable {
        public let form: GisaForm
        public let body: [String: JSONValue]
        public let incidentTypes: [String]
        public let actions: SubmissionDetail.Actions
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
        if let problem = GisaValidation.actionGroupProblem(immediate: actions.immediate, followUp: actions.followUp,
                                                           lookups: lookups) {
            return .failure(SaveProblem(title: "Cannot Save Yet", message: problem))
        }
        form = form.enforcingBusinessRules()
        do {
            let body = try form.patchBody()
            return .success(SaveRequest(form: form, body: body,
                                        incidentTypes: form.incidentTypeItems(listed: listedIncidentTypes),
                                        actions: actions))
        } catch let error as GisaFieldError {
            errors[error.key] = error.message
            return .failure(SaveProblem(title: "Almost there", message: error.message))
        } catch {
            return .failure(SaveProblem(title: "Save failed", message: String(describing: error)))
        }
    }
}
