import Foundation

/// Every file on a form (photos, videos, documents, sketches) with the GISA
/// section it was filed under. Ported from the web's
/// features/submissions/submissionAttachmentModel.ts.
public enum SubmissionLibrary {
    public enum Media: String, Sendable {
        case photo, video, document
    }

    public enum Filter: String, CaseIterable, Identifiable, Sendable {
        case all = "All", photos = "Photos", videos = "Videos", documents = "Documents"
        public var id: String { rawValue }
    }

    public struct Item: Equatable, Identifiable, Sendable {
        public let attachment: AttachmentRef
        public let media: Media
        public let sectionKey: String?
        public let sectionLabel: String

        public var id: Int { attachment.id }
        public var fileName: String { attachment.fileName ?? "Attachment \(attachment.id)" }
    }

    public struct Counts: Equatable, Sendable {
        public var all = 0, photos = 0, videos = 0, documents = 0

        public init(all: Int = 0, photos: Int = 0, videos: Int = 0, documents: Int = 0) {
            self.all = all
            self.photos = photos
            self.videos = videos
            self.documents = documents
        }

        public func count(_ filter: Filter) -> Int {
            switch filter {
            case .all: return all
            case .photos: return photos
            case .videos: return videos
            case .documents: return documents
            }
        }
    }

    /// The section names the form files under (`attachment_links.section_key`).
    public static let sectionLabels: [String: String] = [
        "submission": "Submission", "distribution": "Distribution", "highway_status": "Highway Status",
        "incident_type": "Incident Type", "material": "Material", "pavement_ground_status": "Pavement / Ground Status",
        "vegetation_slope": "Vegetation on Slope", "vegetation_on_slope": "Vegetation on Slope",
        "water_drainage": "Water / Drainage", "water_content": "Water Content", "measurements": "Measurements",
        "record_of_event": "Record of Event", "maintenance_history": "Maintenance History", "observation": "Observation",
        "geotechnical_assessment": "Geotechnical Assessment", "recommendations": "Recommendations", "sketchpad": "Sketchpad",
    ]

    /// "custom_thing" -> "Custom Thing".
    public static func humanize(_ key: String) -> String {
        key.trimmingCharacters(in: .whitespaces).split(separator: "_").map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    public static func normalizedSection(_ key: String?) -> String? {
        let value = (key ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return value.isEmpty ? nil : value
    }

    /// A section's name; files with none belong to the Submission.
    public static func sectionLabel(_ key: String?) -> String {
        guard let key = normalizedSection(key) else { return "Submission" }
        return sectionLabels[key] ?? humanize(key)
    }

    /// By MIME type first; the link's kind only when the type is missing.
    public static func media(mimeType: String?, kind: String?) -> Media {
        let mime = (mimeType ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if mime.hasPrefix("image/") { return .photo }
        if mime.hasPrefix("video/") { return .video }
        if mime.isEmpty {
            switch (kind ?? "").trimmingCharacters(in: .whitespaces).uppercased() {
            case "PHOTO", "SKETCH": return .photo
            case "VIDEO": return .video
            default: break
            }
        }
        return .document
    }

    public static func isPDF(mimeType: String?, fileName: String?) -> Bool {
        if (mimeType ?? "").trimmingCharacters(in: .whitespaces).lowercased() == "application/pdf" { return true }
        return (fileName ?? "").lowercased().hasSuffix(".pdf")
    }

    public static func items(_ attachments: [AttachmentRef]) -> [Item] {
        attachments.map { attachment in
            let key = normalizedSection(attachment.sectionKey)
            return Item(attachment: attachment, media: media(mimeType: attachment.mimeType, kind: attachment.kind),
                        sectionKey: key, sectionLabel: sectionLabel(key))
        }
    }

    /// The form's files: its attachments, or its photos from an older server.
    public static func items(of detail: SubmissionDetail) -> [Item] {
        items(detail.attachments ?? detail.photos ?? [])
    }

    public static func filter(_ items: [Item], _ filter: Filter) -> [Item] {
        switch filter {
        case .all: return items
        case .photos: return items.filter { $0.media == .photo }
        case .videos: return items.filter { $0.media == .video }
        case .documents: return items.filter { $0.media == .document }
        }
    }

    public static func counts(_ items: [Item]) -> Counts {
        var counts = Counts(all: items.count)
        for item in items {
            switch item.media {
            case .photo: counts.photos += 1
            case .video: counts.videos += 1
            case .document: counts.documents += 1
            }
        }
        return counts
    }

    public static func items(_ items: [Item], inSections keys: [String]) -> [Item] {
        let wanted = Set(keys.map { $0.lowercased() })
        return items.filter { $0.sectionKey.map(wanted.contains) ?? false }
    }

    /// "4 items · 2 photos · 1 video · 1 document", or "No files".
    public static func countLabel(_ counts: Counts) -> String {
        func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
        var parts: [String] = []
        if counts.photos > 0 { parts.append(plural(counts.photos, "photo")) }
        if counts.videos > 0 { parts.append(plural(counts.videos, "video")) }
        if counts.documents > 0 { parts.append(plural(counts.documents, "document")) }
        if parts.isEmpty { return "No files" }
        return ([plural(counts.all, "item")] + parts).joined(separator: " · ")
    }

    // MARK: Adding a file

    /// The link kind for an upload, as the Expo editor infers it.
    public static func uploadKind(fileName: String, mimeType: String) -> String {
        let mime = mimeType.lowercased()
        let sketch = fileName.range(of: "sketch", options: .caseInsensitive) != nil
        if mime == "image/png" && sketch { return "SKETCH" }
        if mime.hasPrefix("image/") { return "PHOTO" }
        if mime.hasPrefix("video/") { return "VIDEO" }
        let ext = (fileName.split(separator: ".").last.map(String.init) ?? "").lowercased()
        if ext == "png" && sketch { return "SKETCH" }
        if ["jpg", "jpeg", "png", "heic", "heif", "gif", "webp"].contains(ext) { return "PHOTO" }
        if ["mp4", "mov", "m4v", "avi", "mkv", "webm"].contains(ext) { return "VIDEO" }
        return "DOC"
    }

    /// The server's upload limit (backend config `MAX_UPLOAD_MB`, 95 by default).
    public static let maxUploadMB = 95

    /// Why a file is too large to send, in the server's words; nil when it fits.
    public static func sizeProblem(fileName: String, bytes: Int, limitMB: Int = maxUploadMB) -> String? {
        guard bytes > limitMB * 1024 * 1024 else { return nil }
        return "\(fileName.isEmpty ? "That file" : fileName) is larger than \(limitMB) MB. Shorten or compress it, or share a link in the notes."
    }

    /// "2.4 MB", "830 KB".
    public static func sizeText(_ bytes: Int?) -> String? {
        guard let bytes else { return nil }
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded())) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1024 / 1024)
    }
}
