import Foundation

/// An incident reported while ERIS could not be reached, with its photos,
/// kept on this iPhone until it is filed. Ported from
/// mobile/src/offline/incidentQueue.ts.
public struct QueuedIncident: Codable, Equatable, Identifiable, Sendable {
    public struct File: Codable, Equatable, Identifiable, Sendable {
        public let id: UUID
        public let fileName: String
        public let mimeType: String
        public let kind: IncidentAttachmentKind
        public var uploaded = false

        public init(fileName: String, mimeType: String, kind: IncidentAttachmentKind, id: UUID = UUID()) {
            self.id = id
            self.fileName = fileName
            self.mimeType = mimeType
            self.kind = kind
        }
    }

    public let id: UUID
    public let draft: IncidentDraft
    public var files: [File]
    public let createdAt: Date
    /// The incident once ERIS has it.
    public var serverId: Int?
    /// Set just before each attempt to file it: an attempt whose answer was
    /// lost is looked for before another is made.
    public var attemptedAt: Date?
    /// Why ERIS refused it, if it did; kept for the reporter to see.
    public var problem: String?

    public init(draft: IncidentDraft, files: [File], id: UUID = UUID(), createdAt: Date = Date()) {
        self.id = id
        self.draft = draft
        self.files = files
        self.createdAt = createdAt
    }

    public var title: String { draft.title?.nilIfBlank ?? "Report at \(draft.county) \(draft.route) PM \(draft.postMile)" }
}

private extension String {
    var nilIfBlank: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}

extension OfflineStore {
    public func queueIncident(_ incident: QueuedIncident, files: [UUID: Data]) {
        for (id, data) in files { writeFile(data, to: "incidents/\(incident.id.uuidString)/\(id.uuidString).bin") }
        updateIncident(incident)
    }

    public func updateIncident(_ incident: QueuedIncident) {
        guard let data = try? Self.encoder.encode(incident) else { return }
        writeFile(data, to: "incidents/\(incident.id.uuidString)/report.json")
    }

    public func queuedIncidents() -> [QueuedIncident] {
        folders(in: "incidents").compactMap { folder in
            readFile("incidents/\(folder)/report.json").flatMap { try? Self.decoder.decode(QueuedIncident.self, from: $0) }
        }.sorted { $0.createdAt < $1.createdAt }
    }

    public func incidentFile(_ incident: QueuedIncident, _ file: QueuedIncident.File) -> Data? {
        readFile("incidents/\(incident.id.uuidString)/\(file.id.uuidString).bin")
    }

    public func removeIncident(_ incident: QueuedIncident) {
        removeFile("incidents/\(incident.id.uuidString)")
    }
}

/// Files kept reports in the order they were made, then their photos.
public struct IncidentSync: Sendable {
    let incidents: IncidentsAPI
    let store: OfflineStore
    let me: Int

    public init(api: APIClient, store: OfflineStore, me: Int) {
        incidents = IncidentsAPI(api: api)
        self.store = store
        self.me = me
    }

    public enum Outcome: Equatable, Sendable {
        case nothing, sent, unreachable
        case refused(String)
    }

    /// Every kept report, oldest first, until ERIS cannot be reached.
    public func sendAll() async -> Outcome {
        var outcome = Outcome.nothing
        for queued in store.queuedIncidents() where queued.problem == nil {
            switch await send(queued) {
            case .unreachable: return .unreachable
            case .sent: outcome = .sent
            case .refused(let why): if outcome == .nothing { outcome = .refused(why) }
            case .nothing: break
            }
        }
        return outcome
    }

    /// One kept report: filed (unless an earlier attempt already was), then its photos.
    public func send(_ original: QueuedIncident) async -> Outcome {
        var queued = original
        do {
            if queued.serverId == nil {
                if queued.attemptedAt != nil {
                    // An earlier attempt may have been filed without its answer
                    // arriving. If that cannot be checked, wait: never file twice.
                    queued.serverId = try await alreadyFiled(queued)
                    if queued.serverId != nil { store.updateIncident(queued) }
                }
                if queued.serverId == nil {
                    queued.attemptedAt = Date()
                    store.updateIncident(queued)
                    queued.serverId = try await incidents.create(queued.draft).id
                    store.updateIncident(queued)
                }
            }
            guard let id = queued.serverId else { return .unreachable }
            for index in queued.files.indices where !queued.files[index].uploaded {
                let file = queued.files[index]
                if let data = store.incidentFile(queued, file) {
                    try await incidents.upload(id, file: data, fileName: file.fileName, mimeType: file.mimeType, kind: file.kind)
                }
                queued.files[index].uploaded = true
                store.updateIncident(queued)
            }
            store.removeIncident(queued)
            return .sent
        } catch let error as APIError where error.isUnreachable {
            return .unreachable
        } catch let error as APIError {
            queued.problem = error.refusal
            store.updateIncident(queued)
            return .refused(error.refusal)
        } catch {
            return .unreachable
        }
    }

    /// The report ERIS already has from an earlier attempt: this person's, at
    /// the same moment first seen, the same place and the same words. Reports
    /// in a district maintenance workflow are listed apart, so both lists are read.
    func alreadyFiled(_ queued: QueuedIncident) async throws -> Int? {
        let listed = try await incidents.list(limit: 200)
        if let match = listed.first(where: { Self.same(queued.draft, $0, reporter: me) }) { return match.id }
        let listedIds = Set(listed.map(\.id))
        let workflow = try await incidents.maintenanceReports()
        for report in workflow.filter({ ($0.reportedByMe ?? true) && !listedIds.contains($0.id) }).prefix(10) {
            if Self.same(queued.draft, try await incidents.get(report.id), reporter: me) { return report.id }
        }
        return nil
    }

    /// Whether a filed incident is this draft.
    public static func same(_ draft: IncidentDraft, _ incident: Incident, reporter: Int) -> Bool {
        guard incident.reporterUserId == reporter,
              let lat = incident.latitude, let lon = incident.longitude,
              abs(lat - draft.latitude) <= 0.000001, abs(lon - draft.longitude) <= 0.000001,
              sameMoment(draft.firstObservedAt, incident.firstObservedAt) else { return false }
        func norm(_ text: String?) -> String { (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
        return norm(draft.county) == norm(incident.county) && norm(draft.description) == norm(incident.description)
            && RoadReference.normalizeRoute(draft.route) == RoadReference.normalizeRoute(incident.route ?? "")
    }

    /// The moment the app sent and the one ERIS returns. The database keeps no
    /// zone: it may hand back the same instant, or the time as written (the UTC
    /// clock reading the app sent), so either counts.
    static func sameMoment(_ sent: String, _ filed: String?) -> Bool {
        guard let filed else { return false }
        func clock(_ text: String) -> String { String(text.replacingOccurrences(of: " ", with: "T").prefix(19)) }
        if clock(sent) == clock(filed) { return true }
        guard let a = ServerDate.parse(sent), let b = ServerDate.parse(filed) else { return false }
        return abs(a.timeIntervalSince(b)) < 1
    }
}
