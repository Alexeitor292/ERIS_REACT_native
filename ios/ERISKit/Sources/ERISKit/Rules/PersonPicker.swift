import Foundation

/// One heading of a person picker and the people under it.
public struct PickerSection: Equatable, Sendable {
    public let group: PickerGroup
    public let label: String
    /// Non-nil when nobody in this group may be chosen, and says why.
    public let disabledReason: String?
    /// The group's home city and district, for the heading.
    public let place: String?
    public internal(set) var items: [RoutingUserOption]
}

/// The pure model behind the assessment person pickers. Ported from
/// web/src/features/assessments/personPickerModel.ts, which the Expo screen's
/// inline helpers are an earlier copy of.
///
/// Two rules. **Inform, never choose:** nothing returns a default, a
/// recommendation or a ranking, and `initialValue` is nil for every data shape,
/// including a single candidate. **Nobody is hidden:** a person away on rotation
/// is shown with their return date, and a branch not staffed yet is shown
/// disabled with the reason.
public enum PersonPicker {
    static let otherGroupKey = "__other__"
    static let otherGroupLabel = "Not in a listed group"

    /// "D4", "D11": a district as it reads in a sentence, from the stored "04".
    public static func districtLabel(_ district: String?) -> String? {
        var code = Substring(district?.trimmed ?? "")
        guard !code.isEmpty else { return nil }
        while code.count > 1, code.first == "0", code.dropFirst().first?.isNumber == true { code.removeFirst() }
        return "D\(code)"
    }

    /// "Oakland D4", "Oakland" or "D4": whichever parts exist.
    public static func placeLabel(city: String?, district: String?) -> String? {
        [city?.trimmed ?? "", districtLabel(district) ?? ""].filter { !$0.isEmpty }.joined(separator: " ").nilIfEmpty
    }

    /// A branch's name; "Branch F" when it has only a letter.
    public static func branchLabel(name: String?, letter: String?) -> String? {
        if let name = name?.trimmed.nilIfEmpty { return name }
        return letter?.trimmed.nilIfEmpty.map { "Branch \($0)" }
    }

    /// Why this group cannot be chosen from, or nil.
    public static func disabledReason(_ group: PickerGroup) -> String? {
        let name = branchLabel(name: group.branchName, letter: group.branchLetter) ?? group.label ?? "This group"
        if group.isActive == false { return "\(name) has been retired" }
        if group.acceptsAssignments == false { return "\(name) is not staffed yet" }
        return nil
    }

    /// Groups and their people in the server's order. A person whose group is
    /// missing lands in a trailing "Not in a listed group" section rather than
    /// vanishing.
    public static func sections(groups: [PickerGroup], items: [RoutingUserOption]) -> [PickerSection] {
        var sections = groups.map { group in
            PickerSection(group: group,
                          label: group.label?.trimmed.nilIfEmpty ?? branchLabel(name: group.branchName,
                                                                               letter: group.branchLetter) ?? "Group",
                          disabledReason: disabledReason(group),
                          place: placeLabel(city: group.homeCity, district: group.homeDistrict),
                          items: [])
        }
        var other: PickerSection?
        for item in items {
            if let index = sections.firstIndex(where: { $0.group.groupKey == item.groupKey }) {
                sections[index].items.append(item)
                continue
            }
            if other == nil {
                other = PickerSection(group: PickerGroup(groupKey: otherGroupKey, label: otherGroupLabel),
                                      label: otherGroupLabel, disabledReason: nil, place: nil, items: [])
            }
            other?.items.append(item)
        }
        if let other { sections.append(other) }
        return sections
    }

    /// Every person in render order.
    public static func flatten(_ sections: [PickerSection]) -> [RoutingUserOption] {
        sections.flatMap(\.items)
    }

    /// The people who may actually be chosen: a disabled group's members may not.
    public static func selectable(_ sections: [PickerSection]) -> [RoutingUserOption] {
        sections.filter { $0.disabledReason == nil }.flatMap(\.items)
    }

    /// The initial value of a picker: always nil. A function, not a constant,
    /// so a future "convenience" that preselects has to delete it.
    public static func initialValue(_ sections: [PickerSection] = []) -> Int? { nil }

    /// The chosen person, or nil. Never falls back to "the only one".
    public static func selectedPerson(_ sections: [PickerSection], _ value: Int?) -> RoutingUserOption? {
        guard let value else { return nil }
        return flatten(sections).first { $0.id == value }
    }

    /// "2/5/27" from "2027-02-05", read off the string so a date-only value
    /// cannot shift a day backwards in California.
    public static func formatAvailabilityDate(_ value: String?) -> String? {
        let raw = value?.trimmed ?? ""
        guard !raw.isEmpty else { return nil }
        let parts = raw.prefix(10).split(separator: "-")
        guard raw.count >= 10, parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else { return raw }
        return "\(month)/\(day)/\(String(format: "%02d", year % 100))"
    }

    static let availabilityLabels = [
        "ROTATION_OUT": "Rotation out",
        "ACTING_ELSEWHERE": "Acting elsewhere",
        "UNAVAILABLE": "Unavailable",
    ]

    /// "Rotation out — back 2/5/27", or nil for someone who is simply around.
    public static func availabilityNote(availability: String?, until: String?) -> String? {
        guard let label = availabilityLabels[(availability ?? "AVAILABLE").uppercased()] else { return nil }
        return formatAvailabilityDate(until).map { "\(label) — back \($0)" } ?? label
    }

    /// "4 open · 2 waiting on them": about a third party, never an ordering.
    public static func workloadNote(open: Int?, awaiting: Int?) -> String {
        let open = open ?? 0
        let awaiting = awaiting ?? 0
        if open <= 0 && awaiting <= 0 { return "No open assessments" }
        var parts = ["\(open) open"]
        if awaiting > 0 { parts.append("\(awaiting) waiting on them") }
        return parts.joined(separator: " · ")
    }

    /// "Branch C · Oakland D4": where this person sits.
    public static func placeNote(_ person: RoutingUserOption) -> String? {
        [branchLabel(name: person.branchName, letter: person.branchLetter) ?? "",
         placeLabel(city: person.homeCity, district: person.homeDistrict) ?? ""]
            .filter { !$0.isEmpty }.joined(separator: " · ").nilIfEmpty
    }

    /// Whether a chosen Staff member sits outside the assessment's branch. The
    /// server allows it only with a recorded reason, so the app warns first.
    /// Unknown on either side is not a warning.
    public static func isOutOfBranchChoice(_ person: RoutingUserOption?, assessmentBranchId: Int?) -> Bool {
        guard let person, let assessmentBranchId, let branchId = person.branchId else { return false }
        return branchId != assessmentBranchId
    }
}

extension RoutingUserOption {
    public var availabilityNote: String? { PersonPicker.availabilityNote(availability: availability, until: availableUntil) }
    public var workloadNote: String { PersonPicker.workloadNote(open: openAssessmentCount, awaiting: awaitingActionCount) }
    public var placeNote: String? { PersonPicker.placeNote(self) }
}
