import Foundation

/// The checks the editor makes before saving and submitting. Ported from the
/// validate* functions of mobile/app/(tabs)/submissions/[id].tsx.
public enum GisaValidation {
    /// The fields a draft needs before it can be saved, and the step they are on.
    public static let draftRequired: [(key: String, label: String)] = [
        ("district", "District"), ("county", "County"), ("route", "Route"), ("post_mile", "Post Mile"),
        ("latitude", "Latitude"), ("longitude", "Longitude"),
    ]

    /// Field key -> "District is required." for each missing draft field.
    public static func draftErrors(_ form: GisaForm) -> [String: String] {
        var errors: [String: String] = [:]
        for field in draftRequired where form[field.key].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            errors[field.key] = "\(field.label) is required."
        }
        return errors
    }

    /// Submitting also needs the geotechnical assessment.
    public static func submitErrors(_ form: GisaForm) -> [String: String] {
        var errors = draftErrors(form)
        if errors.isEmpty && !hasGeotechnicalAssessment(form) {
            errors["geotechnical_assessment_notes"] = "Geotechnical Assessment is required."
        }
        return errors
    }

    /// Whether the Geotechnical Assessment memo has any words. The memo's
    /// document is what is edited; its plain copy is the server's, made on save.
    public static func hasGeotechnicalAssessment(_ form: GisaForm) -> Bool {
        !MemoContent.text(ofHTML: form["geotechnical_assessment_notes_html"])
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// When soil is present, clay, silt, sand, gravel and boulder must total 100%.
    public static func soilTotalProblem(_ form: GisaForm) -> String? {
        guard form["material_soil"] == "YES" else { return nil }
        guard let clay = percent(form["est_clay_pct"]), let silt = percent(form["est_silt_pct"]) else {
            return "Clay/Silt percentage must be numeric."
        }
        var total = clay + silt
        for (key, label) in [("est_sand_pct", "Sand"), ("est_gravel_pct", "Gravel"), ("est_boulder_pct", "Boulder")] {
            guard let value = percent(form[key]) else { return "\(label) percentage must be numeric." }
            total += value
        }
        return totalProblem(total, what: "Material Soil")
    }

    /// When any landslide debris share is entered, the four must total 100%.
    public static func debrisTotalProblem(_ form: GisaForm) -> String? {
        let fields = [("est_debris_clay_silt_pct", "Debris Clay/Silt"), ("est_debris_sand_pct", "Debris Sand"),
                      ("est_debris_gravel_pct", "Debris Gravel/Cobbles"), ("est_debris_boulder_pct", "Debris Boulder")]
        guard fields.contains(where: { !form[$0.0].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            return nil
        }
        var total = 0.0
        for (key, label) in fields {
            guard let value = percent(form[key]) else { return "\(label) percentage must be numeric." }
            total += value
        }
        return totalProblem(total, what: "Landslide Debris")
    }

    /// An action code in the wrong group, or one the lookups do not know.
    public static func actionGroupProblem(immediate: [String], followUp: [String], lookups: GisaLookups) -> String? {
        let immediateAllowed = Set(lookups.actions.immediate.map(\.code))
        let followUpAllowed = Set(lookups.actions.followUp.map(\.code))
        var problems: [String] = []
        let unknownImmediate = immediate.filter { !immediateAllowed.contains($0) }
        let unknownFollowUp = followUp.filter { !followUpAllowed.contains($0) }
        let wrongImmediate = immediate.filter { followUpAllowed.contains($0) }
        let wrongFollowUp = followUp.filter { immediateAllowed.contains($0) }
        if !unknownImmediate.isEmpty { problems.append("Immediate has unknown code(s): \(unknownImmediate.joined(separator: ", "))") }
        if !unknownFollowUp.isEmpty { problems.append("Follow-up has unknown code(s): \(unknownFollowUp.joined(separator: ", "))") }
        if !wrongImmediate.isEmpty { problems.append("Immediate has FOLLOW_UP code(s): \(wrongImmediate.joined(separator: ", "))") }
        if !wrongFollowUp.isEmpty { problems.append("Follow-up has IMMEDIATE code(s): \(wrongFollowUp.joined(separator: ", "))") }
        return problems.isEmpty ? nil : "Action group mismatch detected.\n" + problems.joined(separator: "\n")
    }

    /// A blank share counts as 0; nil when the text is not a number.
    static func percent(_ text: String) -> Double? {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : JS.number(text)
    }

    static func totalProblem(_ total: Double, what: String) -> String? {
        if total == 100 { return nil }
        let delta = total - 100
        return String(format: "%@ percentages must total 100%%. Current total is %.2f%% (%@ by %.2f%%).",
                      what, total, delta > 0 ? "over" : "under", abs(delta))
    }
}

/// A district contact, stored in the form as a JSON list in `district_contact`.
public struct DistrictContact: Equatable, Identifiable, Sendable {
    public let id: UUID
    public var firstName = ""
    public var lastName = ""
    public var sNumber = ""
    public var phone = ""
    public var cellPhone = ""

    public init(id: UUID = UUID(), firstName: String = "", lastName: String = "", sNumber: String = "",
                phone: String = "", cellPhone: String = "") {
        self.id = id
        self.firstName = firstName
        self.lastName = lastName
        self.sNumber = sNumber
        self.phone = phone
        self.cellPhone = cellPhone
    }

    /// "Ana Ruiz", or "Contact 2" before a name is typed.
    public func displayName(index: Int) -> String {
        let full = "\(firstName) \(lastName)".trimmingCharacters(in: .whitespaces)
        return full.isEmpty ? "Contact \(index + 1)" : full
    }

    /// The contacts in `district_contact`. Text that is not JSON (an older
    /// free-text value) becomes one contact with that text as the first name.
    public static func parse(_ raw: String) -> [DistrictContact] {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return [] }
        guard let parsed = try? JSONDecoder().decode(JSONValue.self, from: Data(value.utf8)) else {
            return [DistrictContact(firstName: value)]
        }
        guard case .array(let items) = parsed else { return [] }
        return items.map { item in
            let fields: [String: JSONValue]
            if case .object(let object) = item { fields = object } else { fields = [:] }
            return DistrictContact(firstName: JS.string(fields["first_name"]), lastName: JS.string(fields["last_name"]),
                                   sNumber: JS.string(fields["s_number"]), phone: JS.string(fields["phone"]),
                                   cellPhone: JS.string(fields["cell_phone"]))
        }
    }

    /// The JSON list for `district_contact`, without empty contacts; "" when none.
    public static func serialize(_ contacts: [DistrictContact]) -> String {
        let rows = contacts.map { contact in
            [("first_name", contact.firstName), ("last_name", contact.lastName), ("s_number", contact.sNumber),
             ("phone", contact.phone), ("cell_phone", contact.cellPhone)]
                .map { ($0.0, $0.1.trimmingCharacters(in: .whitespacesAndNewlines)) }
        }.filter { $0.contains { !$0.1.isEmpty } }
        guard !rows.isEmpty else { return "" }
        // Keys in a fixed order, as JSON.stringify writes them.
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        func quoted(_ text: String) -> String {
            (try? encoder.encode(text)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        }
        let objects = rows.map { row in "{" + row.map { "\(quoted($0.0)):\(quoted($0.1))" }.joined(separator: ",") + "}" }
        return "[" + objects.joined(separator: ",") + "]"
    }
}

/// One choice in a GISA list (`GET /gisa/lookups`).
public struct GisaOption: Decodable, Equatable, Identifiable, Sendable {
    public let code: String
    public let label: String
    public var id: String { code }

    public init(code: String, label: String) {
        self.code = code
        self.label = label
    }
}

/// The GISA choice lists.
public struct GisaLookups: Decodable, Equatable, Sendable {
    public struct Actions: Decodable, Equatable, Sendable {
        public let immediate: [GisaOption]
        public let followUp: [GisaOption]

        public init(immediate: [GisaOption], followUp: [GisaOption]) {
            self.immediate = immediate
            self.followUp = followUp
        }
    }

    public let distribution: [GisaOption]
    public let highwayStatus: [GisaOption]
    public let incidentTypes: [GisaOption]
    public let actions: Actions

    public static let empty = GisaLookups(distribution: [], highwayStatus: [], incidentTypes: [],
                                          actions: Actions(immediate: [], followUp: []))

    public init(distribution: [GisaOption], highwayStatus: [GisaOption], incidentTypes: [GisaOption], actions: Actions) {
        self.distribution = distribution
        self.highwayStatus = highwayStatus
        self.incidentTypes = incidentTypes
        self.actions = actions
    }
}
