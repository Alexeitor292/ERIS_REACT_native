import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// One of a crack's measurements, as GISA-001 asks for them.
public enum CrackMeasure: String, Codable, CaseIterable, Identifiable, Sendable {
    case lengthFt = "length_ft"
    case widthIn = "width_in"
    case horizontalDispIn = "horizontal_disp_in"
    case verticalDispIn = "vertical_disp_in"
    case depthIn = "depth_in"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .lengthFt: return "Length"
        case .widthIn: return "Width"
        case .horizontalDispIn: return "Horizontal displacement"
        case .verticalDispIn: return "Vertical displacement"
        case .depthIn: return "Depth"
        }
    }

    public var unit: String { self == .lengthFt ? "ft" : "in" }

    /// The GISA-001 wording, short enough for a form row ("Horizontal disp.").
    public var shortLabel: String {
        switch self {
        case .horizontalDispIn: return "Horizontal disp."
        case .verticalDispIn: return "Vertical disp."
        default: return label
        }
    }
}

/// A crack's line relative to the roadway.
public enum CrackOrientation: String, Codable, CaseIterable, Identifiable, Sendable {
    case longitudinal = "LONGITUDINAL", transverse = "TRANSVERSE", diagonal = "DIAGONAL", arcuate = "ARCUATE"
    case other = "OTHER"

    public var id: String { rawValue }
    public var label: String { rawValue.prefix(1) + rawValue.dropFirst().lowercased() }
}

/// A shape drawn over a crack's photo. Points are fractions (0…1) of the
/// photo's width and height, origin top left, so the drawing fits any size.
public struct CrackShape: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case path, arrow, label }

    public var type: Kind
    public var points: [[Double]]?
    public var at: [Double]?
    public var text: String?
    /// The measurement a label shows; it follows the value when that changes.
    public var measure: CrackMeasure?
    public var color: String?

    public init(type: Kind, points: [[Double]]? = nil, at: [Double]? = nil, text: String? = nil,
                measure: CrackMeasure? = nil, color: String? = nil) {
        self.type = type
        self.points = points
        self.at = at
        self.text = text
        self.measure = measure
        self.color = color
    }
}

public struct CrackAnnotations: Codable, Equatable, Sendable {
    public var version: Int
    public var shapes: [CrackShape]

    public init(shapes: [CrackShape]) {
        version = 1
        self.shapes = shapes
    }
}

/// A pavement/ground crack: its own record, with the same fields as every
/// other crack (backend routes/cracks.py).
public struct Crack: Codable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let submissionId: Int
    public let clientUuid: String
    public let sortOrder: Int
    public let label: String?
    public let latitude: Double?
    public let longitude: Double?
    /// PHOTO (approximate), MAP or MANUAL.
    public let locationSource: String?
    public let trendDeg: Double?
    public let orientation: CrackOrientation?
    public let lengthFt: Double?
    public let widthIn: Double?
    public let horizontalDispIn: Double?
    public let verticalDispIn: Double?
    public let depthIn: Double?
    public let notes: String?
    public let photoAttachmentId: Int?
    public let annotations: CrackAnnotations?
    public let revision: Int
    public let createdByName: String?

    enum CodingKeys: String, CodingKey {
        case id, label, latitude, longitude, orientation, notes, revision
        case submissionId = "submission_id", clientUuid = "client_uuid", sortOrder = "sort_order"
        case locationSource = "location_source", trendDeg = "trend_deg", lengthFt = "length_ft", widthIn = "width_in"
        case horizontalDispIn = "horizontal_disp_in", verticalDispIn = "vertical_disp_in", depthIn = "depth_in"
        case photoAttachmentId = "photo_attachment_id", annotations = "annotations_json", createdByName = "created_by_name"
    }

    public func value(_ measure: CrackMeasure) -> Double? {
        switch measure {
        case .lengthFt: return lengthFt
        case .widthIn: return widthIn
        case .horizontalDispIn: return horizontalDispIn
        case .verticalDispIn: return verticalDispIn
        case .depthIn: return depthIn
        }
    }

    /// "Crack 2", or its name.
    public func title(index: Int) -> String {
        label?.trimmingCharacters(in: .whitespaces).nilIfEmpty ?? "Crack \(index + 1)"
    }

    /// "12.5 ft" or "0.75 in", or nil when not measured.
    public func text(_ measure: CrackMeasure) -> String? {
        value(measure).map { "\(Crack.trim($0)) \(measure.unit)" }
    }

    /// One line under the title: what is known about the crack.
    public var summary: String {
        let parts: [String?] = [
            text(.lengthFt).map { "\($0) long" }, text(.widthIn).map { "\($0) wide" },
            text(.horizontalDispIn).map { "\($0) horizontal" }, text(.verticalDispIn).map { "\($0) vertical" },
            text(.depthIn).map { "\($0) deep" }, Crack.trendText(trendDeg).map { "trends \($0)" },
            orientation.map { $0.label.lowercased() },
        ]
        let known = parts.compactMap { $0 }
        return known.isEmpty ? "No measurements yet" : known.joined(separator: " · ")
    }

    /// "37.731200, -122.197500 (approximate, from its photo)".
    public var locationText: String? {
        guard let latitude, let longitude else { return nil }
        let source = ["PHOTO": "approximate, from its photo", "MAP": "mapped"][locationSource ?? ""] ?? "entered"
        return String(format: "%.6f, %.6f (%@)", latitude, longitude, source)
    }

    /// The words a shape shows: a label's own text, else the measure it names
    /// with today's value.
    public func words(for shape: CrackShape) -> String? {
        if shape.type == .label, let own = shape.text?.trimmingCharacters(in: .whitespaces), !own.isEmpty { return own }
        guard let measure = shape.measure else { return nil }
        return "\(measure.label) \(text(measure) ?? "—")"
    }

    /// "035° (NE–SW)": a crack line runs both ways.
    public static func trendText(_ degrees: Double?) -> String? {
        guard let degrees, degrees.isFinite else { return nil }
        let normalized = (degrees.truncatingRemainder(dividingBy: 180) + 180).truncatingRemainder(dividingBy: 180)
        let index = Int((normalized / 22.5).rounded()) % 8
        let points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE"]
        let opposite = ["S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        let whole = Int(normalized.rounded()) % 180
        return String(format: "%03d° (%@–%@)", whole, points[index], opposite[index])
    }

    static func trim(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : JS.numberText((value * 100).rounded() / 100)
    }
}

/// What the crack editor holds: every value as typed.
public struct CrackDraft: Equatable, Sendable {
    public var label: String
    public var latitude: String
    public var longitude: String
    public var trendDeg: String
    public var orientation: CrackOrientation?
    public var notes: String
    public var photoAttachmentId: Int?
    public var measures: [CrackMeasure: String]
    public var annotations: CrackAnnotations?

    public init(_ crack: Crack) {
        func text(_ value: Double?) -> String { value.map(JS.numberText) ?? "" }
        label = crack.label ?? ""
        latitude = text(crack.latitude)
        longitude = text(crack.longitude)
        trendDeg = text(crack.trendDeg)
        orientation = crack.orientation
        notes = crack.notes ?? ""
        photoAttachmentId = crack.photoAttachmentId
        measures = Dictionary(uniqueKeysWithValues: CrackMeasure.allCases.map { ($0, text(crack.value($0))) })
        annotations = crack.annotations
    }

    public subscript(measure: CrackMeasure) -> String {
        get { measures[measure] ?? "" }
        set { measures[measure] = newValue }
    }

    /// The PATCH body for what changed since `crack`, or the first value the
    /// server would refuse. Empty when nothing changed.
    public func changes(from crack: Crack) -> Result<[String: JSONValue], InputProblem> {
        var out: [String: JSONValue] = [:]
        func number(_ text: String, _ name: String, _ min: Double, _ max: Double, below: Bool = false) throws -> Double? {
            let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !raw.isEmpty else { return nil }
            guard let value = JS.number(raw), value >= min, below ? value < max : value <= max else {
                throw InputProblem(message: "\(name) must be a number from \(JS.numberText(min)) to \(below ? "less than \(JS.numberText(max))" : JS.numberText(max)).")
            }
            return value
        }
        func json(_ value: Double?) -> JSONValue { value.map(JSONValue.number) ?? .null }
        func json(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
        do {
            let newLabel = label.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            if newLabel != crack.label { out["label"] = json(newLabel) }
            let newNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            if newNotes != crack.notes { out["notes"] = json(newNotes) }
            for measure in CrackMeasure.allCases {
                let value = try number(self[measure], measure.label, 0, 100_000)
                if value != crack.value(measure) { out[measure.rawValue] = json(value) }
            }
            let trend = try number(trendDeg, "Direction", 0, 360, below: true)
            if trend != crack.trendDeg { out["trend_deg"] = json(trend) }
            if orientation != crack.orientation { out["orientation"] = json(orientation?.rawValue) }
            let lat = try number(latitude, "Latitude", -90, 90)
            let lon = try number(longitude, "Longitude", -180, 180)
            if (lat == nil) != (lon == nil) { throw InputProblem(message: "Enter both latitude and longitude, or neither.") }
            if lat != crack.latitude || lon != crack.longitude {
                out["latitude"] = json(lat)
                out["longitude"] = json(lon)
                out["location_source"] = lat == nil ? .null : .string("MANUAL")
            }
            if photoAttachmentId != crack.photoAttachmentId {
                out["photo_attachment_id"] = photoAttachmentId.map { .number(Double($0)) } ?? .null
            }
            if annotations != crack.annotations {
                out["annotations_json"] = try annotations.map { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode($0)) } ?? .null
            }
        } catch let problem as InputProblem {
            return .failure(problem)
        } catch {
            return .failure(InputProblem(message: String(describing: error)))
        }
        return .success(out)
    }
}

/// A typed value that cannot be sent, and why.
public struct InputProblem: Error, Equatable, Sendable {
    public let message: String
}

/// The crack was saved by someone else since it was read; `theirs` is the saved one.
public struct CrackConflict: Error, Equatable, Sendable {
    public let theirs: Crack?
}

extension SubmissionsAPI {
    struct CrackEnvelope: Decodable { let crack: Crack }
    struct CrackList: Decodable { let items: [Crack] }

    public func cracks(_ id: Int) async throws -> [Crack] {
        try await api.get("/submissions/\(id)/cracks", preservingKeys: true, as: CrackList.self).items
    }

    /// Adds a crack. `clientUuid` makes the request safe to repeat: sending
    /// the same one again returns the crack already made.
    public func createCrack(_ id: Int, clientUuid: UUID = UUID(), fields: [String: JSONValue] = [:]) async throws -> Crack {
        var body = fields
        body["client_uuid"] = .string(clientUuid.uuidString.lowercased())
        return try await api.request("POST", "/submissions/\(id)/cracks", body: try JSONEncoder().encode(body),
                                     preservingKeys: true, as: CrackEnvelope.self).crack
    }

    /// Saves changes to a crack read at `revision`; throws `CrackConflict` with
    /// the saved crack when someone else saved it first.
    public func updateCrack(_ id: Int, crackId: Int, revision: Int, changes: [String: JSONValue]) async throws -> Crack {
        var body = changes
        body["revision"] = .number(Double(revision))
        do {
            return try await api.request("PATCH", "/submissions/\(id)/cracks/\(crackId)", body: try JSONEncoder().encode(body),
                                         preservingKeys: true, as: CrackEnvelope.self).crack
        } catch APIError.http(409, _), APIError.refused(409, _, _) {
            throw CrackConflict(theirs: try? await cracks(id).first { $0.id == crackId })
        }
    }

    public func deleteCrack(_ id: Int, crackId: Int) async throws {
        _ = try await api.request("DELETE", "/submissions/\(id)/cracks/\(crackId)", as: EmptyResponse.self)
    }
}
