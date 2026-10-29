import Foundation

/// Several people can have one technical form open. Ported from the web
/// app's collab/formMerge.ts and collab/presenceModel.ts; the server's side is
/// backend/app/services/form_saves.py and form_presence.py.
///
/// A form is compared as a flat snapshot (field -> value). Three snapshots
/// matter: `base` (the form as this person opened it, or last caught up with),
/// `mine` (what the screen shows now) and `fresh` (what is saved now).
public enum FormMerge {
    public typealias Snapshot = [String: JSONValue]

    private static func blank(_ value: JSONValue?) -> Bool {
        switch value {
        case .none, .null?: return true
        case .string(let text)?: return text.isEmpty
        default: return false
        }
    }

    /// Equal as the form shows them: blanks are one value, lists by content.
    public static func same(_ a: JSONValue?, _ b: JSONValue?) -> Bool {
        if blank(a) && blank(b) { return true }
        return (a ?? .null) == (b ?? .null)
    }

    /// The fields changed since `base`, in key order.
    public static func changedKeys(base: Snapshot, mine: Snapshot) -> [String] {
        Set(base.keys).union(mine.keys).filter { !same(base[$0], mine[$0]) }.sorted()
    }

    public struct Result: Equatable, Sendable {
        /// The form after folding in what others saved; conflicts keep this person's value.
        public let merged: Snapshot
        /// Fields taken from what others saved (this person had not changed them).
        public let theirs: [String]
        /// Fields both changed, to different values: this person decides.
        public let conflicts: [String]
    }

    /// Three-way merge: others' saved changes land where this person has not typed.
    public static func mergeFresh(base: Snapshot, mine: Snapshot, fresh: Snapshot) -> Result {
        var merged = mine
        var theirs: [String] = [], conflicts: [String] = []
        for key in Set(base.keys).union(mine.keys).union(fresh.keys).sorted() where !same(base[key], fresh[key]) {
            if same(base[key], mine[key]) {
                merged[key] = fresh[key]
                theirs.append(key)
            } else if !same(mine[key], fresh[key]) {
                conflicts.append(key)
            }
        }
        return Result(merged: merged, theirs: theirs, conflicts: conflicts)
    }

    /// The new starting point after catching up with `fresh`: what is saved now,
    /// except the fields still in conflict, which keep the old start so a save of
    /// them is refused until this person has chosen.
    public static func rebase(base: Snapshot, fresh: Snapshot, keep: [String]) -> Snapshot {
        var next = fresh
        for key in keep { next[key] = base[key] }
        return next
    }

    /// Equal as the server stores them (form_saves.same): blanks as nothing,
    /// numbers by value however written, booleans as 1 and 0, JSON by content.
    public static func savedSame(_ a: JSONValue?, _ b: JSONValue?) -> Bool {
        normalized(a) == normalized(b)
    }

    private static func normalized(_ value: JSONValue?) -> JSONValue {
        switch value {
        case .none, .null?: return .null
        case .bool(let flag)?: return .number(flag ? 1 : 0)
        case .number(let n)?: return .number(n)
        case .string(let text)?:
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return .null }
            if let n = Double(trimmed), n.isFinite { return .number(n) }
            return .string(trimmed)
        case .array?, .object?: return value!
        }
    }
}

// MARK: - Who else is in the form

/// Another open copy of the form (`POST /submissions/{id}/presence`).
public struct PresenceOther: Decodable, Equatable, Identifiable, Sendable {
    public let sessionId: String
    public let userId: Int
    public let name: String
    /// "card:<id>" or "memo:<key>": the part of the form they are in.
    public let area: String?
    public let field: String?
    /// Memos they are writing (locked for everyone else).
    public let memos: [String]

    public var id: String { sessionId }

    public init(sessionId: String, userId: Int, name: String, area: String? = nil, field: String? = nil, memos: [String] = []) {
        self.sessionId = sessionId
        self.userId = userId
        self.name = name
        self.area = area
        self.field = field
        self.memos = memos
    }

    enum CodingKeys: String, CodingKey {
        case name, area, field, memos
        case sessionId = "session_id", userId = "user_id"
    }
}

public struct PresenceReply: Decodable, Equatable, Sendable {
    public struct Person: Decodable, Equatable, Sendable {
        public let userId: Int
        public let name: String
        enum CodingKeys: String, CodingKey { case name, userId = "user_id" }
    }

    public let others: [PresenceOther]
    /// The memos this copy now holds.
    public let granted: [String]
    /// Memos it asked for that someone else holds.
    public let denied: [String: Person]
    /// The form's saved revision: higher than this copy's means someone saved.
    public let revision: Int
    public let savedBy: Person?

    enum CodingKeys: String, CodingKey {
        case others, granted, denied, revision
        case savedBy = "saved_by"
    }
}

public enum Presence {
    /// "Maria Garcia" -> "MG"; "maria.garcia@dot.ca.gov" -> "MG"; one name -> its first two letters.
    public static func initials(_ name: String) -> String {
        let cleaned = name.contains("@")
            ? String(name.split(separator: "@", omittingEmptySubsequences: false)[0])
                .replacingOccurrences(of: #"[._-]+"#, with: " ", options: .regularExpression)
            : name
        let words = cleaned.split(whereSeparator: \.isWhitespace)
        guard let first = words.first else { return "?" }
        if words.count == 1 { return String(first.prefix(2)).uppercased() }
        return (String(first.prefix(1)) + String(words.last!.prefix(1))).uppercased()
    }

    /// One colour per person, the same on every screen (as #rrggbb).
    public static func color(_ userId: Int) -> String {
        let colors = ["#c2410c", "#7c3aed", "#0f766e", "#be185d", "#4d7c0f", "#b45309", "#1d4ed8", "#9f1239"]
        return colors[abs(userId) % colors.count]
    }

    /// Everyone in the form, once each.
    public static func people(_ others: [PresenceOther]) -> [PresenceOther] {
        var seen = Set<Int>()
        return others.filter { seen.insert($0.userId).inserted }
    }

    /// Memo key -> the person writing it.
    public static func writers(_ others: [PresenceOther]) -> [String: PresenceOther] {
        var out: [String: PresenceOther] = [:]
        for other in others { for memo in other.memos where out[memo] == nil { out[memo] = other } }
        return out
    }

    /// "Maria Garcia is also in this form", "… and … are also in this form", "3 others …".
    public static func sentence(_ others: [PresenceOther]) -> String {
        let names = people(others).map(\.name)
        switch names.count {
        case 0: return ""
        case 1: return "\(names[0]) is also in this form"
        case 2: return "\(names[0]) and \(names[1]) are also in this form"
        default: return "\(names.count) others are also in this form"
        }
    }

    /// A readable name for a form field ("settlement_in" -> "Settlement (in)").
    public static func fieldLabel(_ key: String) -> String {
        let named = [
            "ea": "EA", "project_id": "Project ID", "post_mile": "Post mile", "route": "Highway (route)",
            "geometry_json": "Site areas", "district_contact": "District contacts",
            "observations_notes": "Observations", "geotechnical_assessment_notes": "Geotechnical assessment",
            "recommendations_notes": "Recommendations", "sketchpad_notes": "Sketch notes",
            "record_of_event_notes": "Notes on earlier incidents", "maintenance_history_notes": "Notes on maintenance",
            "list:inc": "Incident types", "list:imm": "Immediate actions", "list:fol": "Follow-up actions",
        ]
        var bare = key.hasPrefix("memo:") ? String(key.dropFirst(5)) : key
        if bare.hasSuffix("_html") { bare = String(bare.dropLast(5)) }
        if let name = named[bare] { return name }
        var parts = bare.split(separator: "_").map(String.init)
        let unit = parts.last.flatMap { ["ft": "ft", "in": "in", "pct": "%", "deg": "°"][$0] }
        if unit != nil { parts.removeLast() }
        if parts.first == "est" { parts[0] = "estimated" }
        let words = parts.joined(separator: " ")
        let label = words.prefix(1).uppercased() + words.dropFirst()
        return unit.map { "\(label) (\($0))" } ?? label
    }
}

// MARK: - The editor's side

/// Why a save was refused: someone else changed the same fields, or is writing a memo.
public enum FormRefusal: Error, Equatable, Sendable {
    case conflicts(savedBy: String?)
    case locked(String)
}

extension GisaEditor {
    /// The form as this person opened it (or last caught up with), and the saved
    /// values a save is checked against.
    public struct Base: Codable, Equatable, Sendable {
        public var form: GisaForm
        public var listed: [String]
        public var gisa: [String: JSONValue]
        public var incidentTypes: [String]
        public var actions: SubmissionDetail.Actions
        public var revision: Int

        init(detail: SubmissionDetail, form: GisaForm, listed: [String]) {
            self.form = form
            self.listed = listed
            gisa = detail.gisa ?? [:]
            incidentTypes = detail.incidentTypes ?? []
            actions = detail.actions ?? .init()
            revision = detail.revision
        }
    }

    /// One field both changed: what this person has, and what is saved now.
    public struct FieldConflict: Equatable, Identifiable, Sendable {
        public let key: String
        public let label: String
        public let mine: String
        public let theirs: String
        public var id: String { key }
    }

    /// Fields both changed, waiting for this person's choice, with the saved form they came from.
    public struct Pending: Equatable, Sendable {
        public let conflicts: [FieldConflict]
        public let savedBy: String?
        let fresh: SubmissionDetail
    }

    static func snapshot(form: GisaForm, listed: [String], actions: SubmissionDetail.Actions) -> FormMerge.Snapshot {
        var out = form.values.mapValues(JSONValue.string)
        func list(_ items: [String]) -> JSONValue { .array(Set(items).sorted().map(JSONValue.string)) }
        out["list:inc"] = list(form.incidentTypeItems(listed: listed))
        out["list:imm"] = list(actions.immediate)
        out["list:fol"] = list(actions.followUp)
        return out
    }

    /// What the screen shows now, as one snapshot.
    public var snapshot: FormMerge.Snapshot { Self.snapshot(form: form, listed: listedIncidentTypes, actions: actions) }

    var baseSnapshot: FormMerge.Snapshot { Self.snapshot(form: base.form, listed: base.listed, actions: base.actions) }

    /// The fields this person has changed since opening the form or catching up.
    public var changedKeys: [String] { FormMerge.changedKeys(base: baseSnapshot, mine: snapshot) }

    /// Puts snapshot values on screen.
    mutating func apply(_ values: FormMerge.Snapshot, keys: [String]) {
        for key in keys {
            let value = values[key]
            let items: [String] = { if case .array(let list)? = value { return list.map { JS.string($0) } } else { return [] } }()
            switch key {
            case "list:inc": listedIncidentTypes = items
            case "list:imm": actions.immediate = items
            case "list:fol": actions.followUp = items
            default:
                form[key] = JS.string(value)
                errors[key] = nil
                if key == "district_contact" { resetContacts() }
            }
        }
    }

    /// The column a form field is saved in.
    static func serverKey(_ key: String) -> String {
        guard let field = GisaForm.fields.first(where: { $0.key == key }), case .json(let serverKey, _) = field.kind else { return key }
        return serverKey
    }

    static func label(_ key: String) -> String {
        if let field = GisaForm.fields.first(where: { $0.key == key }), !field.label.isEmpty { return field.label }
        return Presence.fieldLabel(key)
    }

    /// A field's value as the conflict choice shows it.
    static func shown(_ key: String, _ value: JSONValue?) -> String {
        if case .array(let items)? = value { return items.map { JS.string($0) }.joined(separator: ", ") }
        let text = JS.string(value)
        switch text {
        case "YES": return "Yes"
        case "NO": return "No"
        case "UNKNOWN": return ""
        default: return key == "geometry_json" ? (text.isEmpty ? "" : "Site areas as drawn") : text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    /// Folds what others saved into the form, where this person has not typed;
    /// fields both changed wait in `pending` for a choice. Returns the labels of
    /// the fields taken from what others saved.
    @discardableResult
    public mutating func catchUp(with fresh: SubmissionDetail, savedBy: String?) -> [String] {
        let freshEditor = GisaEditor(detail: fresh)
        let baseSnap = baseSnapshot, mine = snapshot, freshSnap = freshEditor.snapshot
        let result = FormMerge.mergeFresh(base: baseSnap, mine: mine, fresh: freshSnap)
        apply(freshSnap, keys: result.theirs)
        let keep = result.conflicts
        // The new start: what is saved, except the fields still to decide.
        var next = freshEditor.base
        let old = base
        for key in keep {
            switch key {
            case "list:inc": next.incidentTypes = old.incidentTypes; next.listed = old.listed
            case "list:imm": next.actions.immediate = old.actions.immediate
            case "list:fol": next.actions.followUp = old.actions.followUp
            default:
                next.form[key] = old.form[key]
                let column = Self.serverKey(key)
                next.gisa[column] = old.gisa[column]
                // Failure boxes are also incident types: a kept one keeps the list too.
                if GisaForm.incidentTypeCodes.contains(where: { $0.key == key }) {
                    next.incidentTypes = old.incidentTypes
                }
            }
        }
        base = next
        pending = keep.isEmpty ? nil : Pending(
            conflicts: keep.map { FieldConflict(key: $0, label: Self.label($0), mine: Self.shown($0, mine[$0]),
                                                theirs: Self.shown($0, freshSnap[$0])) },
            savedBy: savedBy, fresh: fresh)
        return result.theirs.map(Self.label)
    }

    /// This person's choice for each field both changed: those named take what
    /// is saved, the rest keep theirs. Both versions seen, every field now starts
    /// from what is saved.
    public mutating func resolve(takingTheirs keys: Set<String>) {
        guard let pending else { return }
        let freshEditor = GisaEditor(detail: pending.fresh)
        apply(freshEditor.snapshot, keys: pending.conflicts.map(\.key).filter(keys.contains))
        base = freshEditor.base
        self.pending = nil
    }
}

extension SubmissionDetail {
    /// The saved form's revision; each save raises it.
    public var revision: Int {
        if case .number(let n)? = gisa?["revision"] { return Int(n) }
        return 0
    }
}

extension SubmissionsAPI {
    /// This copy of the form's heartbeat: where it is, the memos it is writing.
    public func presence(_ id: Int, session: String, area: String?, field: String?, memos: [String],
                         typing: Bool) async throws -> PresenceReply {
        let body: [String: JSONValue] = [
            "session_id": .string(session), "area": area.map(JSONValue.string) ?? .null,
            "field": field.map(JSONValue.string) ?? .null, "memos": .array(memos.map(JSONValue.string)), "typing": .bool(typing),
        ]
        return try await api.request("POST", "/submissions/\(id)/presence", body: try JSONEncoder().encode(body),
                                     preservingKeys: true, as: PresenceReply.self)
    }

    /// This copy of the form has closed.
    public func leavePresence(_ id: Int, session: String) async throws {
        _ = try await api.request("DELETE", "/submissions/\(id)/presence/\(session)", as: EmptyResponse.self)
    }
}
