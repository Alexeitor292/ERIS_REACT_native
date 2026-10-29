import Foundation

extension APIError {
    /// ERIS could not be reached, or answered that it is down for now: worth
    /// trying again later, unlike a refusal.
    public var isUnreachable: Bool {
        switch self {
        case .transport, .server: return true
        case .http(let status, _), .refused(let status, _, _): return status >= 500
        default: return false
        }
    }

    /// The refusal in words, for a change that could not be sent.
    public var refusal: String {
        switch self {
        case .forbidden(let detail): return detail ?? "You can no longer edit this form."
        case .notFound: return "This form is no longer on ERIS."
        case .http(let status, let detail), .refused(let status, let detail, _):
            return detail ?? "ERIS refused the change (\(status))."
        case .unauthorized: return "Your ERIS session ended. Sign in again to send."
        case .server(let status): return "ERIS had a problem (\(status)). It will be tried again."
        case .decoding, .invalidResponse: return "ERIS answered in a way this app does not understand."
        case .transport(let message): return message
        }
    }
}

extension SubmissionsAPI {
    /// A server answer and, when ERIS could not be reached, when the copy
    /// shown was kept on this iPhone instead.
    public struct Kept<Value: Sendable>: Sendable {
        public let value: Value
        /// Nil when it came from ERIS just now.
        public let keptAt: Date?
    }

    /// An answer with its keys untouched, to keep and decode.
    func raw(_ path: String, query: [URLQueryItem] = []) async throws -> Data {
        let value = try await api.get(path, query: query, preservingKeys: true, as: JSONValue.self)
        return try JSONEncoder().encode(value)
    }

    /// The form, kept for when ERIS cannot be reached; the kept copy when it cannot.
    public func detail(_ id: Int, keepingIn store: OfflineStore) async throws -> Kept<SubmissionDetail> {
        try await kept(store.form(id)) {
            let data = try await raw("/submissions/\(id)")
            let detail = try api.decode(SubmissionDetail.self, from: data, preservingKeys: true)
            store.keepForm(id, data)
            return detail
        } decode: { try api.decode(SubmissionDetail.self, from: $0, preservingKeys: true) }
    }

    public func list(keepingIn store: OfflineStore, limit: Int = 100) async throws -> Kept<[SubmissionSummary]> {
        try await kept(store.list()) {
            let data = try await raw("/submissions", query: [URLQueryItem(name: "limit", value: String(limit))])
            let list = try api.decode(SubmissionList.self, from: data)
            store.keepList(data)
            return list.items
        } decode: { try api.decode(SubmissionList.self, from: $0).items }
    }

    public func lookups(keepingIn store: OfflineStore) async throws -> Kept<GisaLookups> {
        try await kept(store.lookups()) {
            let data = try await raw("/gisa/lookups")
            let lookups = try api.decode(GisaLookups.self, from: data)
            store.keepLookups(data)
            return lookups
        } decode: { try api.decode(GisaLookups.self, from: $0) }
    }

    private func kept<Value: Sendable>(_ copy: OfflineStore.Copy?, fetch: () async throws -> Value,
                                       decode: (Data) throws -> Value) async throws -> Kept<Value> {
        do {
            return Kept(value: try await fetch(), keptAt: nil)
        } catch let error as APIError where error.isUnreachable {
            guard let copy, let value = try? decode(copy.data) else { throw error }
            return Kept(value: value, keptAt: copy.savedAt)
        }
    }
}

/// Sends what was kept on this iPhone while ERIS could not be reached: each
/// form's saved changes, caught up with what others saved first (fields both
/// changed wait for this person), then its files, oldest first.
public struct FormSync: Sendable {
    public enum Outcome: Equatable, Sendable {
        /// Nothing was waiting.
        case nothing
        case sent
        /// ERIS could not be reached; everything is kept to try again.
        case unreachable
        /// Someone else changed the same fields; the form waits for this person's choice.
        case needsChoice
        /// To try again later, for this reason (a memo someone else is writing).
        case held(String)
        /// Refused for a reason a retry will not fix; kept for this person to see.
        case refused(String)
    }

    let submissions: SubmissionsAPI
    let store: OfflineStore

    public init(api: APIClient, store: OfflineStore) {
        submissions = SubmissionsAPI(api: api)
        self.store = store
    }

    /// Every form with something waiting, until ERIS cannot be reached. The
    /// changes of the form open on screen (`open`) are left to it; its files go.
    public func sendAll(except open: Int? = nil) async -> [Int: Outcome] {
        var outcomes: [Int: Outcome] = [:]
        for id in store.waiting.forms.sorted() {
            let outcome = await send(id, includingEdits: id != open)
            outcomes[id] = outcome
            if outcome == .unreachable { break }
        }
        return outcomes
    }

    /// One form's changes, then its files.
    public func send(_ id: Int, includingEdits: Bool = true) async -> Outcome {
        let changes = includingEdits ? await sendEdits(id) : .nothing
        if changes == .unreachable { return changes }
        let files = await sendUploads(id)
        if files == .unreachable { return files }
        // The kept copy follows what is now saved.
        if changes != .nothing || files != .nothing { _ = try? await submissions.detail(id, keepingIn: store) }
        for outcome in [changes, files] {
            switch outcome {
            case .refused, .needsChoice, .held: return outcome
            default: continue
            }
        }
        return changes == .sent || files == .sent ? .sent : .nothing
    }

    func sendEdits(_ id: Int) async -> Outcome {
        guard var kept = store.edits(id), kept.state == .waiting else { return .nothing }
        let lookups = (try? await submissions.lookups(keepingIn: store))?.value ?? .empty
        for _ in 0..<2 {
            let fresh: SubmissionDetail
            do {
                let answer = try await submissions.detail(id, keepingIn: store)
                guard answer.keptAt == nil else { return .unreachable }
                fresh = answer.value
            } catch let error as APIError {
                return error.isUnreachable ? .unreachable : refuse(&kept, error.refusal)
            } catch {
                return .unreachable
            }
            guard fresh.submission.isEditable else {
                return refuse(&kept, "This form is \(SubmissionLabels.status(fresh.submission.status).lowercased()) now and can no longer be changed. Your changes are kept on this iPhone.")
            }
            var editor = GisaEditor(edits: kept)
            editor.catchUp(with: fresh, savedBy: nil)
            if editor.pending != nil {
                kept.state = .needsChoice
                kept.note = "Someone else changed \(editor.pending!.conflicts.map(\.label).joined(separator: ", ")) too. Open the form to choose which to keep."
                store.keepEdits(kept)
                return .needsChoice
            }
            switch editor.prepareSave(lookups: lookups) {
            case .failure(let problem):
                return refuse(&kept, problem.message)
            case .success(let request):
                if request.isEmpty {
                    store.removeEdits(id)
                    return .sent
                }
                do {
                    try await submissions.saveGisa(id, request)
                    store.removeEdits(id)
                    return .sent
                } catch FormRefusal.conflicts {
                    continue  // Someone saved just now: catch up again.
                } catch FormRefusal.locked(let message) {
                    kept.note = message
                    store.keepEdits(kept)
                    return .held(message)
                } catch let error as APIError {
                    return error.isUnreachable ? .unreachable : refuse(&kept, error.refusal)
                } catch {
                    return refuse(&kept, String(describing: error))
                }
            }
        }
        return .held("Others are saving this form right now. It will be tried again.")
    }

    private func refuse(_ kept: inout FormEdits, _ note: String) -> Outcome {
        kept.state = .refused
        kept.note = note
        store.keepEdits(kept)
        return .refused(note)
    }

    func sendUploads(_ id: Int) async -> Outcome {
        var outcome = Outcome.nothing
        var fresh: SubmissionDetail?
        for upload in store.uploads(for: id) where upload.problem == nil {
            guard let file = store.uploadFile(upload) else {
                store.removeUpload(upload)
                continue
            }
            if upload.attempted {
                // An earlier try may have arrived without its answer: look before sending again.
                if fresh == nil {
                    guard let answer = try? await submissions.detail(id, keepingIn: store), answer.keptAt == nil else {
                        return .unreachable
                    }
                    fresh = answer.value
                }
                if (fresh?.attachments ?? []).contains(where: { $0.fileName == upload.fileName && $0.fileSizeBytes == upload.size }) {
                    store.removeUpload(upload)
                    outcome = .sent
                    continue
                }
            }
            var marked = upload
            marked.attempted = true
            store.updateUpload(marked)
            do {
                _ = try await submissions.uploadAttachment(id, file: file, fileName: upload.fileName, mimeType: upload.mimeType,
                                                           sectionKey: upload.sectionKey, kind: upload.kind,
                                                           capture: upload.capture)
                store.removeUpload(upload)
                outcome = .sent
            } catch let error as APIError where error.isUnreachable {
                return .unreachable
            } catch let error as APIError {
                marked.problem = error.refusal
                store.updateUpload(marked)
                if case .nothing = outcome { outcome = .refused(error.refusal) }
            } catch {
                return .unreachable
            }
        }
        return outcome
    }
}
