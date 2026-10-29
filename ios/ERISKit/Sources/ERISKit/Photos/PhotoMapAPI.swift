import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// One photo of `GET /submissions/{id}/photo-map`, with its effective (that is,
/// corrected where someone corrected it) location and direction.
public struct MappedPhoto: Decodable, Equatable, Identifiable, Sendable {
    public struct Correction: Decodable, Equatable, Sendable {
        public struct Location: Decodable, Equatable, Sendable {
            public let latitude: Double
            public let longitude: Double
        }

        public let hasHistory: Bool?
        public let locationOverridden: Bool?
        public let headingOverridden: Bool?
        public let locationOverride: Location?
        public let headingOverrideDeg: Double?
        public let correctedAt: String?
    }

    public let attachmentId: Int
    public let fileName: String?
    public let mimeType: String?
    public let sectionKey: String?
    /// SUBMISSION, or INCIDENT for a photo from the linked incident report.
    public let sourceScope: String?
    public let canEditCorrection: Bool?
    public let capturedAt: String?
    public let latitude: Double?
    public let longitude: Double?
    public let horizontalAccuracyM: Double?
    public let cameraHeadingDeg: Double?
    public let cameraHeadingAccuracyCode: Int?
    public let locationSource: String?
    public let headingSource: String?
    public let correction: Correction?
    /// A presigned link, valid about 15 minutes; fetched without the ERIS token.
    public let downloadUrl: String?

    public var id: Int { attachmentId }

    /// "37.731200, -122.197500 · ±5 m", or nil when the photo has no location.
    public var locationText: String? {
        guard let latitude, let longitude else { return nil }
        var text = String(format: "%.6f, %.6f", latitude, longitude)
        if let accuracy = horizontalAccuracyM { text += " · ±\(Int((accuracy + 0.5).rounded(.down))) m" }
        return text
    }

    /// "Facing 123° (SE)", or nil when the direction was not recorded.
    public var directionText: String? {
        cameraHeadingDeg.map { "Facing \(Int(($0 + 0.5).rounded(.down)) % 360)° (\(PhotoCapture.compassPoint($0)))" }
    }

    /// Where the location and direction came from, in words.
    public var sourceText: String {
        func source(_ code: String?) -> String? {
            switch code {
            case "DEVICE_AT_CAPTURE": return "measured by the phone"
            case "DEVICE_TRUE_HEADING": return "measured by the phone"
            case "EXIF_GPS", "EXIF_GPS_IMG_DIRECTION": return "from the photo file"
            case "MANUAL": return "corrected by hand"
            case nil: return nil
            default: return "source unknown"
            }
        }
        return [source(locationSource).map { "Location \($0)" }, source(headingSource).map { "direction \($0)" }]
            .compactMap { $0 }.joined(separator: "; ")
    }
}

public struct PhotoMap: Decodable, Equatable, Sendable {
    public struct Summary: Decodable, Equatable, Sendable {
        public let photosTotal: Int
        public let photosGeotagged: Int
        public let photosWithHeading: Int
        public let photosUnmapped: Int
    }

    public let submissionId: Int
    public let canEditCorrections: Bool?
    public let summary: Summary?
    public let photos: [MappedPhoto]
}

/// A correction is the whole corrected state: a location, a direction, or
/// both; nil for either keeps (or restores) what the camera recorded.
public struct PhotoCorrection: Encodable, Equatable, Sendable {
    public struct Location: Encodable, Equatable, Sendable {
        public let latitude: Double
        public let longitude: Double

        public init(latitude: Double, longitude: Double) {
            self.latitude = latitude
            self.longitude = longitude
        }
    }

    /// Lets a retried request be recognised instead of recorded twice.
    public let clientCorrectionUuid: String
    public let locationOverride: Location?
    public let headingOverrideDeg: Double?

    public init(locationOverride: Location?, headingOverrideDeg: Double?, clientCorrectionUuid: String = UUID().uuidString) {
        self.clientCorrectionUuid = clientCorrectionUuid
        self.locationOverride = locationOverride
        self.headingOverrideDeg = headingOverrideDeg
    }

    enum CodingKeys: String, CodingKey {
        case clientCorrectionUuid = "client_correction_uuid", locationOverride = "location_override"
        case headingOverrideDeg = "heading_override_deg"
    }

    /// Both keys are always sent: null is the instruction to use the camera's value.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(clientCorrectionUuid, forKey: .clientCorrectionUuid)
        try container.encode(locationOverride, forKey: .locationOverride)
        try container.encode(headingOverrideDeg, forKey: .headingOverrideDeg)
    }
}

public struct UploadedAttachment: Decodable, Equatable, Sendable {
    public let attachmentId: Int
    public let sectionKey: String?
}

/// The GISA form's photo sections, in figure order (`GALLERY_SOURCE_SECTIONS`).
public enum GisaPhotoSections {
    public static let all: [(key: String, label: String, figureSection: Int)] = [
        ("submission", "Submission", 1), ("distribution", "Distribution", 2), ("highway_status", "Highway Status", 3),
        ("incident_type", "Incident Type", 4), ("material", "Material", 5),
        ("pavement_ground_status", "Pavement / Ground Status", 6), ("vegetation_slope", "Vegetation on Slope", 7),
        ("water_drainage", "Water / Drainage", 8), ("water_content", "Water Content", 9),
        ("measurements", "Measurements", 10), ("record_of_event", "Record of Event", 11),
        ("maintenance_history", "Maintenance History", 12), ("observation", "Observation", 13),
        ("geotechnical_assessment", "Geotechnical Assessment", 14), ("sketchpad", "Sketchpad", 15),
    ]

    /// Every photo on the form, newest first (to place as a memo figure).
    public static func allPhotos(of detail: SubmissionDetail) -> [AttachmentRef] {
        let photoIds = Set((detail.photos ?? []).map(\.id))
        return (detail.attachments ?? detail.photos ?? [])
            .filter { photoIds.contains($0.id) || ($0.mimeType ?? "").lowercased().hasPrefix("image/") }
            .sorted { $0.id > $1.id }
    }

    /// A section's attachments that can be shown as pictures.
    public static func photos(in sectionKey: String, of detail: SubmissionDetail) -> [AttachmentRef] {
        let photoIds = Set((detail.photos ?? []).map(\.id))
        return (detail.attachments ?? detail.photos ?? []).filter { attachment in
            attachment.sectionKey == sectionKey
                && (photoIds.contains(attachment.id) || (attachment.mimeType ?? "").lowercased().hasPrefix("image/"))
        }
    }
}

extension SubmissionsAPI {
    /// Uploads a file to the form, tagged with its section; a photo carries
    /// where and which way it was taken.
    public func uploadAttachment(_ id: Int, file: Data, fileName: String, mimeType: String, sectionKey: String?,
                                 kind: String, capture: PhotoCaptureMetadata?) async throws -> UploadedAttachment {
        var fields: [(String, String)] = []
        if let capture, let json = String(data: try JSONEncoder().encode(capture), encoding: .utf8) {
            fields.append(("capture_metadata_json", json))
        }
        let form = MultipartForm(file: file, fieldName: "file", fileName: fileName, mimeType: mimeType, fields: fields)
        var query = [URLQueryItem(name: "kind", value: kind)]
        if let sectionKey { query.insert(URLQueryItem(name: "section_key", value: sectionKey), at: 0) }
        return try await api.request("POST", "/submissions/\(id)/attachments", query: query, body: form.body,
                                     contentType: form.contentType, as: UploadedAttachment.self)
    }

    public func photoMap(_ id: Int) async throws -> PhotoMap {
        try await api.get("/submissions/\(id)/photo-map", as: PhotoMap.self)
    }

    public func correctPhoto(_ id: Int, attachmentId: Int, _ correction: PhotoCorrection) async throws {
        _ = try await api.request("PUT", "/submissions/\(id)/photo-map/photos/\(attachmentId)/correction",
                                  body: try JSONEncoder().encode(correction), as: EmptyResponse.self)
    }
}
