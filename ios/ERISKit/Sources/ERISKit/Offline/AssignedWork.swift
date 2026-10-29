import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension APIClient {
    /// An answer, kept under `name` in the store; the kept copy, and when it
    /// was kept, when ERIS cannot be reached.
    func kept<T: Decodable>(_ path: String, query: [URLQueryItem] = [], preservingKeys: Bool = false, store: OfflineStore?,
                            name: String, as type: T.Type) async throws -> (T, Date?) {
        do {
            let value = try await get(path, query: query, preservingKeys: true, as: JSONValue.self)
            let data = try JSONEncoder().encode(value)
            let decoded = try decode(T.self, from: data, preservingKeys: preservingKeys)
            store?.keep(data, as: name)
            return (decoded, nil)
        } catch let error as APIError where error.isUnreachable {
            guard let copy = store?.copy(named: name),
                  let decoded = try? decode(T.self, from: copy.data, preservingKeys: preservingKeys) else { throw error }
            return (decoded, copy.savedAt)
        }
    }
}

/// Everything a person needs to work on what is assigned to them, kept on
/// this iPhone without their asking: for each assessment assigned to them
/// (Draft or Revision requested), the assessment, its incident and the
/// incident's photos, every technical form with its site history and photos,
/// and the choice lists. Run when work may have changed (a notice arrives,
/// the network returns, the app comes to the front, now and then in the
/// background), so work assigned while offline is ready once back online.
public struct AssignedWork: Sendable {
    public struct Summary: Equatable, Sendable {
        public var assessments = 0
        public var forms = 0
        public var photos = 0
        /// Site terrain packages downloaded this round.
        public var terrain = 0
        /// ERIS could not be reached; what was kept before stays.
        public var unreachable = false
    }

    let api: APIClient
    let store: OfflineStore
    let me: Int
    let download: @Sendable (URL) async throws -> Data

    public init(api: APIClient, store: OfflineStore, me: Int,
                download: @escaping @Sendable (URL) async throws -> Data = AssignedWork.fetch) {
        self.api = api
        self.store = store
        self.me = me
        self.download = download
    }

    /// The assessments assigned to this person that they are working on.
    public static func assigned(_ assessments: [Assessment], to me: Int) -> [Assessment] {
        var seen = Set<Int>()
        return assessments.filter {
            $0.assignedEngineerUserId == me && ($0.state == "DRAFT" || $0.state == "REVISION_REQUESTED") && seen.insert($0.id).inserted
        }
    }

    /// Keeps the bundle for these assessments, and drops photos no longer needed.
    public func prepare(_ assessments: [Assessment]) async -> Summary {
        var summary = Summary()
        let submissions = SubmissionsAPI(api: api), incidents = IncidentsAPI(api: api)
        _ = try? await submissions.lookups(keepingIn: store)
        var wanted = Set<Int>()
        for assessment in Self.assigned(assessments, to: me) {
            summary.assessments += 1
            _ = try? await api.kept("/assessments/\(assessment.id)", store: store, name: "assessments/\(assessment.id)",
                                    as: AssessmentDetail.self)
            if let (incident, _) = try? await api.kept("/incidents/\(assessment.incidentId)", store: store,
                                                      name: "incidents/\(assessment.incidentId)", as: IncidentEnvelope.self) {
                _ = incident
                struct Evidence: Decodable { let items: [IncidentEvidence] }
                if let (evidence, at) = try? await api.kept("/incidents/\(assessment.incidentId)/attachments", preservingKeys: true,
                                                           store: store, name: "incidents/\(assessment.incidentId)-evidence",
                                                           as: Evidence.self), at == nil {
                    for item in evidence.items where item.isPhoto {
                        wanted.insert(item.attachmentId)
                        if await keepPhoto(item.attachmentId, url: item.downloadUrl) { summary.photos += 1 }
                    }
                }
            }
            for formId in Set(assessment.submissionIds ?? []).union(assessment.submissionId.map { [$0] } ?? []).sorted() {
                guard let form = try? await submissions.detail(formId, keepingIn: store) else { continue }
                if form.keptAt != nil { summary.unreachable = true; continue }
                summary.forms += 1
                _ = try? await api.kept("/submissions/\(formId)/site-history", preservingKeys: true, store: store,
                                        name: "forms/\(formId)-site-history", as: SiteHistory.self)
                // The site in 3D, for the measurements and cross-sections offline.
                switch await AssignedTerrain(api: api, store: store, download: download).keep(formId) {
                case .downloaded: summary.terrain += 1
                case .unreachable: summary.unreachable = true
                default: break
                }
                for photo in GisaPhotoSections.allPhotos(of: form.value) {
                    wanted.insert(photo.id)
                    if store.file(photo.id) != nil { continue }
                    guard let link = try? await submissions.attachmentLink(photo.id) else { continue }
                    if await keepPhoto(photo.id, url: link.downloadUrl) { summary.photos += 1 }
                }
            }
        }
        // Photos of work no longer assigned go; those of forms with changes waiting stay.
        if !summary.unreachable {
            for id in store.keptFileIds().subtracting(wanted) { store.removeFile(id) }
        }
        return summary
    }

    /// A file by its link, without the ERIS session (the link carries its own signature).
    public static func fetch(_ url: URL) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            URLSession.shared.dataTask(with: url) { data, response, error in
                // An HTTP answer must be a success; a data: or file: link has no status.
                let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? true
                if let data, error == nil, ok {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: error ?? URLError(.badServerResponse))
                }
            }.resume()
        }
    }

    /// A photo by its presigned link (fetched without the ERIS session); true when newly kept.
    private func keepPhoto(_ id: Int, url: String?) async -> Bool {
        guard store.file(id) == nil, let url = url.flatMap(URL.init(string:)), let data = try? await download(url),
              !data.isEmpty, data.count <= 25 * 1024 * 1024 else { return false }
        store.keepFile(id, data)
        return true
    }
}

extension AssessmentsAPI {
    /// The assessment, or the copy kept on this iPhone when ERIS cannot be reached.
    public func detail(_ id: Int, keepingIn store: OfflineStore) async throws -> SubmissionsAPI.Kept<AssessmentDetail> {
        let (detail, at) = try await api.kept("/assessments/\(id)", store: store, name: "assessments/\(id)", as: AssessmentDetail.self)
        return SubmissionsAPI.Kept(value: detail, keptAt: at)
    }
}

extension SubmissionsAPI {
    /// The site's history, or the kept copy offline.
    public func siteHistory(_ id: Int, keepingIn store: OfflineStore) async throws -> SiteHistory {
        try await api.kept("/submissions/\(id)/site-history", preservingKeys: true, store: store, name: "forms/\(id)-site-history",
                           as: SiteHistory.self).0
    }
}
