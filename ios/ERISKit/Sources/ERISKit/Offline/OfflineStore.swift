import Foundation

/// What this iPhone keeps so forms can be worked on without a connection:
/// the last copy of each form opened and of the choice lists, the changes not
/// yet sent, and files waiting to upload. One folder per signed-in person.
///
/// Unlike the Expo app's queue of requests, changes are kept as the form they
/// started from plus the form as edited. Sending later catches up with what
/// others saved meanwhile first, exactly as an online save does, so a change
/// made offline never overwrites someone else's.
public final class OfflineStore: @unchecked Sendable {
    public let directory: URL
    /// Run on every file written: the app sets the file's data protection.
    private let protect: (@Sendable (URL) -> Void)?
    private let lock = NSLock()
    private let files = FileManager.default

    public init(directory: URL, protect: (@Sendable (URL) -> Void)? = nil) {
        self.directory = directory
        self.protect = protect
    }

    // MARK: Copies of what the server sent

    /// A copy of a server answer, and when it was kept.
    public struct Copy: Sendable {
        public let data: Data
        public let savedAt: Date
    }

    public func keepForm(_ id: Int, _ data: Data) { write(data, to: "forms/\(id).json") }
    public func form(_ id: Int) -> Copy? { copy("forms/\(id).json") }
    public func keepList(_ data: Data) { write(data, to: "submissions.json") }
    public func list() -> Copy? { copy("submissions.json") }
    public func keepLookups(_ data: Data) { write(data, to: "lookups.json") }
    public func lookups() -> Copy? { copy("lookups.json") }

    // MARK: Changes not yet sent

    public func keepEdits(_ edits: FormEdits) {
        guard let data = try? Self.encoder.encode(edits) else { return }
        write(data, to: "edits/\(edits.submissionId).json")
    }

    public func edits(_ id: Int) -> FormEdits? {
        copy("edits/\(id).json").flatMap { try? Self.decoder.decode(FormEdits.self, from: $0.data) }
    }

    public func removeEdits(_ id: Int) { remove("edits/\(id).json") }

    public func allEdits() -> [FormEdits] {
        names(in: "edits").compactMap { name in
            copy("edits/\(name)").flatMap { try? Self.decoder.decode(FormEdits.self, from: $0.data) }
        }.sorted { $0.savedAt < $1.savedAt }
    }

    // MARK: Files waiting to upload

    public func addUpload(_ upload: PendingUpload, file: Data) {
        write(file, to: "uploads/\(upload.id.uuidString).bin")
        updateUpload(upload)
    }

    public func updateUpload(_ upload: PendingUpload) {
        guard let data = try? Self.encoder.encode(upload) else { return }
        write(data, to: "uploads/\(upload.id.uuidString).json")
    }

    public func uploadFile(_ upload: PendingUpload) -> Data? { copy("uploads/\(upload.id.uuidString).bin")?.data }

    public func removeUpload(_ upload: PendingUpload) {
        remove("uploads/\(upload.id.uuidString).json")
        remove("uploads/\(upload.id.uuidString).bin")
    }

    /// Oldest first, the order they were taken.
    public func uploads(for submissionId: Int? = nil) -> [PendingUpload] {
        names(in: "uploads").filter { $0.hasSuffix(".json") }.compactMap { name in
            copy("uploads/\(name)").flatMap { try? Self.decoder.decode(PendingUpload.self, from: $0.data) }
        }
        .filter { submissionId == nil || $0.submissionId == submissionId }
        .sorted { $0.createdAt < $1.createdAt }
    }

    // MARK: Everything

    /// What is waiting to be sent, for the whole iPhone.
    public var waiting: Waiting {
        Waiting(edits: allEdits(), uploads: uploads(), incidents: queuedIncidents())
    }

    public struct Waiting: Equatable, Sendable {
        public let edits: [FormEdits]
        public let uploads: [PendingUpload]
        public var incidents: [QueuedIncident] = []

        /// Changes saved to send (or waiting on this person); changes still being
        /// typed are kept on the iPhone but are not waiting to be sent.
        public var toSend: [FormEdits] { edits.filter { $0.state != .editing } }

        public var isEmpty: Bool { toSend.isEmpty && uploads.isEmpty && incidents.isEmpty }
        public var forms: Set<Int> { Set(edits.map(\.submissionId)).union(uploads.map(\.submissionId)) }

        /// "1 report, 2 forms with changes and 3 files waiting to send".
        public var summary: String? {
            var parts: [String] = []
            if !incidents.isEmpty { parts.append("\(incidents.count) \(incidents.count == 1 ? "report" : "reports")") }
            let edits = toSend
            if !edits.isEmpty { parts.append("\(edits.count) \(edits.count == 1 ? "form" : "forms") with changes") }
            if !uploads.isEmpty { parts.append("\(uploads.count) \(uploads.count == 1 ? "file" : "files")") }
            guard !parts.isEmpty else { return nil }
            let joined = parts.count == 1 ? parts[0] : parts.dropLast().joined(separator: ", ") + " and " + parts.last!
            return joined + " waiting to send"
        }

        /// Forms where someone else changed the same fields: they wait for this person.
        public var needingChoice: [Int] { edits.filter { $0.state == .needsChoice }.map(\.submissionId) }
    }

    /// Deletes everything kept, as on signing out.
    public func wipe() {
        lock.locked { try? files.removeItem(at: directory) }
    }

    // MARK: Files

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private func url(_ path: String) -> URL { directory.appendingPathComponent(path) }

    private func write(_ data: Data, to path: String) {
        lock.locked {
            let target = url(path)
            try? files.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            do {
                try data.write(to: target, options: .atomic)
                protect?(target)
            } catch {}
        }
    }

    private func copy(_ path: String) -> Copy? {
        lock.locked {
            let target = url(path)
            guard let data = try? Data(contentsOf: target) else { return nil }
            let date = (try? files.attributesOfItem(atPath: target.path)[.modificationDate] as? Date) ?? Date()
            return Copy(data: data, savedAt: date)
        }
    }

    private func remove(_ path: String) {
        lock.locked { _ = try? files.removeItem(at: url(path)) }
    }

    private func names(in folder: String) -> [String] {
        lock.locked { (try? files.contentsOfDirectory(atPath: url(folder).path)) ?? [] }
    }

    // MARK: Copies of other answers, and files

    /// A server answer kept under a name ("assessments/5", "work/assignee").
    public func keep(_ data: Data, as name: String) { write(data, to: "copies/\(name).json") }
    public func copy(named name: String) -> Copy? { copy("copies/\(name).json") }

    /// A form's photo, kept so it shows without a connection.
    public func keepFile(_ attachmentId: Int, _ data: Data) { write(data, to: "files/\(attachmentId)") }
    public func file(_ attachmentId: Int) -> Data? { copy("files/\(attachmentId)")?.data }
    public func keptFileIds() -> Set<Int> { Set(names(in: "files").compactMap(Int.init)) }
    public func removeFile(_ attachmentId: Int) { remove("files/\(attachmentId)") }

    // For the other kinds of kept work (IncidentQueue.swift).
    func writeFile(_ data: Data, to path: String) { write(data, to: path) }
    func readFile(_ path: String) -> Data? { copy(path)?.data }
    func removeFile(_ path: String) { remove(path) }
    func folders(in path: String) -> [String] { names(in: path) }
}

/// A form's changes not yet sent: the saved form they started from, and the
/// form as edited. Rebuilt into an editor, they catch up and save as any edit does.
public struct FormEdits: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        /// Being edited; not saved yet.
        case editing
        /// Saved on this iPhone, to be sent when ERIS can be reached.
        case waiting
        /// Someone else changed the same fields: this person chooses on opening the form.
        case needsChoice
        /// The server refused them for a reason a retry will not fix.
        case refused
    }

    public let submissionId: Int
    public var base: GisaEditor.Base
    public var form: [String: String]
    public var listed: [String]
    public var actions: SubmissionDetail.Actions
    public var state: State
    /// Why they were refused, or who else changed the same fields.
    public var note: String?
    public var savedAt: Date

    /// "D04 ALA 880 PM 12.30", for lists of waiting work.
    public var title: String {
        SubmissionDescriptor.text(district: form["district"] ?? "", county: form["county"] ?? "", route: form["route"] ?? "",
                                  postMile: form["post_mile"] ?? "", createdAt: nil)
    }
}

/// A file taken or chosen while ERIS could not be reached.
public struct PendingUpload: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let submissionId: Int
    public let fileName: String
    public let mimeType: String
    public let sectionKey: String?
    public let kind: String
    public let capture: PhotoCaptureMetadata?
    public let size: Int
    public let createdAt: Date
    /// Sent at least once without an answer: before sending again, check the
    /// form does not already have it.
    public var attempted: Bool
    /// Why the server refused it, if it did.
    public var problem: String?

    public init(submissionId: Int, fileName: String, mimeType: String, sectionKey: String?, kind: String,
                capture: PhotoCaptureMetadata?, size: Int, id: UUID = UUID(), createdAt: Date = Date()) {
        self.id = id
        self.submissionId = submissionId
        self.fileName = fileName
        self.mimeType = mimeType
        self.sectionKey = sectionKey
        self.kind = kind
        self.capture = capture
        self.size = size
        self.createdAt = createdAt
        attempted = false
    }
}

extension GisaEditor {
    /// The editor's changes, to keep on this iPhone.
    public func edits(_ submissionId: Int, state: FormEdits.State, note: String? = nil, now: Date = Date()) -> FormEdits {
        FormEdits(submissionId: submissionId, base: base, form: form.values, listed: listedIncidentTypes, actions: actions,
                  state: state, note: note, savedAt: now)
    }

    /// The editor as it was when its changes were kept.
    public init(edits: FormEdits) {
        form = GisaForm()
        for (key, value) in edits.form { form[key] = value }
        contacts = DistrictContact.parse(form["district_contact"])
        listedIncidentTypes = edits.listed
        actions = edits.actions
        base = edits.base
    }

    /// Whether there is anything to send.
    public var hasChanges: Bool { !changedKeys.isEmpty }
}
