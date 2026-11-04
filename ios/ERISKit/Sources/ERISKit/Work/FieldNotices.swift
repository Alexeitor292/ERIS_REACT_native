import Foundation

/// Who can be named District Contact on a hand-off to GeoTech, and the district's
/// default (`GET /district-contacts/{district}`). The contact is kept informed and
/// pre-fills the form's District Contact section; it gives no access to a draft.
public struct DistrictContacts: Decodable, Equatable, Sendable {
    public struct Person: Decodable, Equatable, Identifiable, Sendable {
        public let id: Int
        public let fullName: String
    }

    public let defaultUserId: Int?
    public let candidates: [Person]

    public init(defaultUserId: Int?, candidates: [Person]) {
        self.defaultUserId = defaultUserId
        self.candidates = candidates
    }
}

extension IncidentsAPI {
    public func districtContacts(_ district: String) async throws -> DistrictContacts {
        let code = district.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? district
        return try await api.get("/district-contacts/\(code)", as: DistrictContacts.self)
    }
}

/// Immediate actions told to the supervisor and the District Contact from a form
/// still in draft: the one thing a draft may send. Those told can't open the form.
public struct QueuedDelivery: Codable, Equatable, Identifiable, Sendable {
    public let clientUuid: String
    public let submissionId: Int
    public let actions: [String]
    public let description: String
    public let writtenAt: Date
    /// Why ERIS refused it; it is kept to show the person, and not sent again.
    public var problem: String?

    public var id: String { clientUuid }

    public init(clientUuid: String = UUID().uuidString.lowercased(), submissionId: Int, actions: [String], description: String,
                writtenAt: Date = Date(), problem: String? = nil) {
        self.clientUuid = clientUuid
        self.submissionId = submissionId
        self.actions = actions
        self.description = description
        self.writtenAt = writtenAt
        self.problem = problem
    }
}

extension OfflineStore {
    public func keepDelivery(_ queued: QueuedDelivery) {
        guard let data = try? JSONEncoder().encode(queued) else { return }
        writeFile(data, to: "deliveries/\(queued.id).json")
    }

    public func deliveries(for submissionId: Int? = nil) -> [QueuedDelivery] {
        folders(in: "deliveries").compactMap { name in
            readFile("deliveries/\(name)").flatMap { try? JSONDecoder().decode(QueuedDelivery.self, from: $0) }
        }
        .filter { submissionId == nil || $0.submissionId == submissionId }
        .sorted { $0.writtenAt < $1.writtenAt }
    }

    public func removeDelivery(_ queued: QueuedDelivery) {
        removeFile("deliveries/\(queued.id).json")
    }
}

/// Delivering: at once when ERIS can be reached, otherwise kept and sent with the
/// rest of the waiting work. Its own id means a resend after a lost answer tells nobody twice.
public struct ImmediateDeliveries: Sendable {
    public enum Result: Equatable, Sendable {
        case delivered(supervisor: Bool, contact: Bool)
        case kept
    }

    let api: APIClient
    let store: OfflineStore

    public init(api: APIClient, store: OfflineStore) {
        self.api = api
        self.store = store
    }

    /// Why this can't be delivered yet, or nil. The server checks it all again.
    public static func problem(actions: [String], description: String) -> String? {
        if actions.isEmpty { return "Select the immediate actions first." }
        if description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Say what happened." }
        return nil
    }

    /// Who heard, in a sentence.
    public static func outcome(supervisor: Bool, contact: Bool) -> String {
        switch (supervisor, contact) {
        case (true, true): return "Delivered to the supervisor and the District Contact."
        case (true, false): return "Delivered to the supervisor."
        case (false, true): return "Delivered to the District Contact."
        case (false, false): return "Saved, but this assessment has no supervisor or District Contact to tell yet."
        }
    }

    private struct Answer: Decodable {
        let supervisorTold: Bool?
        let contactTold: Bool?
    }

    private func send(_ queued: QueuedDelivery) async throws -> Answer {
        let body: [String: JSONValue] = [
            "actions": .array(queued.actions.map(JSONValue.string)),
            "description": .string(queued.description),
            "client_uuid": .string(queued.clientUuid),
            "written_at": .string(ISO8601DateFormatter().string(from: queued.writtenAt)),
        ]
        return try await api.request("POST", "/submissions/\(queued.submissionId)/immediate-actions/deliver",
                                     body: try JSONEncoder().encode(body), as: Answer.self)
    }

    /// Kept first, so nothing is lost if the app stops part way. Throws when ERIS refuses it.
    public func deliver(_ submissionId: Int, actions: [String], description: String) async throws -> Result {
        let queued = QueuedDelivery(submissionId: submissionId, actions: actions,
                                    description: description.trimmingCharacters(in: .whitespacesAndNewlines))
        store.keepDelivery(queued)
        do {
            let answer = try await send(queued)
            store.removeDelivery(queued)
            return .delivered(supervisor: answer.supervisorTold ?? false, contact: answer.contactTold ?? false)
        } catch let error as APIError where error.isUnreachable {
            return .kept
        } catch {
            store.removeDelivery(queued)
            throw error
        }
    }

    /// Sends what is waiting; a refused one is kept with the reason. False when ERIS can't be reached.
    @discardableResult
    public func sendAll() async -> Bool {
        for queued in store.deliveries() where queued.problem == nil {
            do {
                _ = try await send(queued)
                store.removeDelivery(queued)
            } catch let error as APIError where error.isUnreachable {
                return false
            } catch {
                var refused = queued
                refused.problem = "ERIS refused this. Tell your supervisor directly."
                store.keepDelivery(refused)
            }
        }
        return true
    }
}
