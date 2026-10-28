import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A row of `GET /submissions`.
public struct SubmissionSummary: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let createdByUserId: Int?
    public let status: String
    public let title: String?
    public let district: String?
    public let county: String?
    public let route: String?
    public let postMile: String?
    public let createdAt: String?
    public let submittedAt: String?

    public var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return "Submission #\(id)"
    }

    public var locationLine: String {
        [district.map { "D\($0)" }, county, route, postMile.map { "PM \($0)" }]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// Drafts and returned forms are still being worked on.
    public var isWorkInProgress: Bool { status == "DRAFT" || status == "REJECTED" }
}

public struct SubmissionList: Decodable, Equatable, Sendable {
    public let items: [SubmissionSummary]
}

/// An attachment as the submission detail lists it. Decoded with the server's
/// own keys (see `SubmissionDetail`).
public struct AttachmentRef: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let kind: String?
    public let fileName: String?
    public let mimeType: String?
    public let sectionKey: String?

    enum CodingKeys: String, CodingKey {
        case id, kind
        case fileName = "file_name", mimeType = "mime_type", sectionKey = "section_key"
    }
}

/// `GET /submissions/{id}`. The GISA form stays a JSON object: the app shows
/// it field by field until the full GISA editor is ported. Decoded with
/// `preservingKeys` so the form's field names arrive untouched; hence the
/// explicit snake_case coding keys.
public struct SubmissionDetail: Decodable, Equatable, Sendable {
    public struct Header: Decodable, Equatable, Sendable {
        public let id: Int
        public let status: String
        public let title: String?
        public let createdAt: String?
        public let updatedAt: String?
        public let submittedAt: String?
        public let reviewedAt: String?
        public let reviewComment: String?
        public let canEdit: Bool?
        public let canReview: Bool?

        enum CodingKeys: String, CodingKey {
            case id, status, title
            case createdAt = "created_at", updatedAt = "updated_at", submittedAt = "submitted_at"
            case reviewedAt = "reviewed_at", reviewComment = "review_comment"
            case canEdit = "can_edit", canReview = "can_review"
        }
    }

    public let submission: Header
    public let gisa: [String: JSONValue]?
    public let incidentTypes: [JSONValue]?
    public let photos: [AttachmentRef]?
    public let attachments: [AttachmentRef]?

    enum CodingKeys: String, CodingKey {
        case submission, gisa, photos, attachments
        case incidentTypes = "incident_types"
    }
}

public struct DownloadLink: Decodable, Equatable, Sendable {
    public let downloadUrl: String
}

public enum SubmissionLabels {
    public static func status(_ status: String) -> String {
        switch status {
        case "DRAFT": return "Draft"
        case "SUBMITTED": return "Submitted"
        case "APPROVED": return "Approved"
        case "REJECTED": return "Returned"
        default: return status
        }
    }

    /// "date_incident_reported" -> "Date incident reported".
    public static func fieldName(_ key: String) -> String {
        let words = key.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// A GISA value as text, or nil when empty.
    public static func text(_ value: JSONValue) -> String? {
        switch value {
        case .null: return nil
        case .string(let text): return text.isEmpty ? nil : text
        case .bool(let flag): return flag ? "Yes" : "No"
        case .number(let number):
            return number.rounded() == number && abs(number) < 1e15 ? String(Int(number)) : String(number)
        case .array(let items):
            let parts = items.compactMap(text)
            return parts.isEmpty ? nil : parts.joined(separator: ", ")
        case .object: return nil
        }
    }
}

public struct SubmissionsAPI: Sendable {
    let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    public func list(limit: Int = 100, status: String? = nil) async throws -> [SubmissionSummary] {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let status { query.append(URLQueryItem(name: "status", value: status)) }
        return try await api.get("/submissions", query: query, as: SubmissionList.self).items
    }

    public func detail(_ id: Int) async throws -> SubmissionDetail {
        try await api.get("/submissions/\(id)", preservingKeys: true, as: SubmissionDetail.self)
    }

    /// The latest generated GISA PDF, as a presigned link (fetch it without the ERIS token).
    public func gisaPDF(_ id: Int) async throws -> DownloadLink {
        try await api.get("/submissions/\(id)/gisa/pdf", as: DownloadLink.self)
    }

    /// A presigned storage link for an attachment, valid about 15 minutes.
    public func attachmentLink(_ attachmentId: Int) async throws -> DownloadLink {
        try await api.get("/attachments/\(attachmentId)/download-url", as: DownloadLink.self)
    }
}
