import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// `POST /incidents` and `PATCH /incidents/{id}` body. Ported from
/// `IncidentCreatePayload` in mobile/src/api/incidents.ts.
public struct IncidentDraft: Encodable, Equatable, Sendable {
    public var title: String?
    public var incidentType: String?
    public var description: String?
    /// ISO 8601, e.g. "2026-10-28T08:00:00Z".
    public var firstObservedAt: String
    public var firstOccurredAt: String?
    public var latitude: Double
    public var longitude: Double
    public var district: String
    public var county: String
    public var route: String
    public var postMile: String

    public init(title: String? = nil, incidentType: String? = nil, description: String? = nil,
                firstObservedAt: String, firstOccurredAt: String? = nil, latitude: Double, longitude: Double,
                district: String, county: String, route: String, postMile: String) {
        self.title = title
        self.incidentType = incidentType
        self.description = description
        self.firstObservedAt = firstObservedAt
        self.firstOccurredAt = firstOccurredAt
        self.latitude = latitude
        self.longitude = longitude
        self.district = district
        self.county = county
        self.route = route
        self.postMile = postMile
    }

    /// What must be fixed before the server will accept it; empty when ready.
    public var problems: [String] {
        var out: [String] = []
        if !(-90...90).contains(latitude) || !(-180...180).contains(longitude) || (latitude == 0 && longitude == 0) {
            out.append("A valid location is required.")
        }
        for (name, value) in [("District", district), ("County", county), ("Route", route), ("Post mile", postMile)]
            where value.trimmingCharacters(in: .whitespaces).isEmpty {
            out.append("\(name) is required.")
        }
        return out
    }
}

public struct IncidentEnvelope: Decodable, Equatable, Sendable {
    public let incident: Incident
}

public enum IncidentAttachmentKind: String, Sendable {
    case photo = "PHOTO", video = "VIDEO", doc = "DOC", sketch = "SKETCH"
}

/// The incident calls the app makes, typed.
public struct IncidentsAPI: Sendable {
    let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    public func list(status: String? = nil, unclaimedOnly: Bool = false, limit: Int? = nil) async throws -> [Incident] {
        var query = [URLQueryItem]()
        if let status { query.append(URLQueryItem(name: "status", value: status)) }
        if unclaimedOnly { query.append(URLQueryItem(name: "unclaimed_only", value: "true")) }
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        query.append(URLQueryItem(name: "scope", value: "mobile"))
        return try await api.get("/incidents", query: query, as: IncidentList.self).items
    }

    public func get(_ id: Int) async throws -> Incident {
        try await api.get("/incidents/\(id)", as: Incident.self)
    }

    public func create(_ draft: IncidentDraft) async throws -> Incident {
        try await api.post("/incidents", json: draft, as: IncidentEnvelope.self).incident
    }

    public func update(_ id: Int, _ draft: IncidentDraft) async throws -> Incident {
        try await api.patch("/incidents/\(id)", json: draft, as: IncidentEnvelope.self).incident
    }

    public func claim(_ id: Int) async throws {
        _ = try await api.request("POST", "/incidents/\(id)/claim", as: EmptyResponse.self)
    }

    public func unassign(_ id: Int) async throws {
        _ = try await api.request("POST", "/incidents/\(id)/unassign", as: EmptyResponse.self)
    }

    public func resolve(_ id: Int, comment: String?) async throws {
        _ = try await api.post("/incidents/\(id)/resolve", json: CommentBody(comment: comment), as: EmptyResponse.self)
    }

    public func forwardByCoordinator(_ id: Int, comment: String?) async throws {
        _ = try await api.post("/incidents/\(id)/coordinator/approve", json: CommentBody(comment: comment),
                               as: EmptyResponse.self)
    }

    public func requestRevision(_ id: Int, comment: String?, fields: [String] = []) async throws {
        _ = try await api.post("/incidents/\(id)/coordinator/request-revision",
                               json: RevisionBody(comment: comment, revisionFields: fields), as: EmptyResponse.self)
    }

    public func upload(_ id: Int, file: Data, fileName: String, mimeType: String,
                       kind: IncidentAttachmentKind) async throws {
        let form = MultipartForm(file: file, fieldName: "file", fileName: fileName, mimeType: mimeType)
        _ = try await api.request("POST", "/incidents/\(id)/attachments",
                                  query: [URLQueryItem(name: "kind", value: kind.rawValue)],
                                  body: form.body, contentType: form.contentType, as: EmptyResponse.self)
    }

    struct CommentBody: Encodable {
        let comment: String?
    }

    struct RevisionBody: Encodable {
        let comment: String?
        let revisionFields: [String]
    }
}

/// A one-file `multipart/form-data` body.
public struct MultipartForm: Sendable {
    public let boundary: String
    public let body: Data

    public var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    /// `fields` are plain text parts sent before the file (for example
    /// `capture_metadata_json`).
    public init(file: Data, fieldName: String, fileName: String, mimeType: String, fields: [(String, String)] = [],
                boundary: String = "ERIS-\(UUID().uuidString)") {
        self.boundary = boundary
        // Quotes and line breaks in a file name would break the header.
        let safeName = fileName.replacingOccurrences(of: "\"", with: "_")
            .replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
        var body = Data()
        for (name, value) in fields {
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".utf8))
            body.append(Data(value.utf8))
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(safeName)\"\r\n".utf8))
        body.append(Data("Content-Type: \(mimeType)\r\n\r\n".utf8))
        body.append(file)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        self.body = body
    }
}
