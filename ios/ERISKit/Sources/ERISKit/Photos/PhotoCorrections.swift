import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A photo correction made on this iPhone, kept until ERIS has it. Only the
/// latest for a photo is kept: a correction is the photo's whole corrected state.
public struct QueuedCorrection: Codable, Equatable, Identifiable, Sendable {
    public let submissionId: Int
    public let attachmentId: Int
    public let correction: PhotoCorrection
    public let savedAt: Date
    /// Why ERIS refused it; it is not tried again.
    public var problem: String?

    public var id: String { "\(submissionId)-\(attachmentId)" }

    public init(submissionId: Int, attachmentId: Int, correction: PhotoCorrection, savedAt: Date = Date(), problem: String? = nil) {
        self.submissionId = submissionId
        self.attachmentId = attachmentId
        self.correction = correction
        self.savedAt = savedAt
        self.problem = problem
    }
}

extension OfflineStore {
    public func keepCorrection(_ queued: QueuedCorrection) {
        guard let data = try? JSONEncoder().encode(queued) else { return }
        writeFile(data, to: "corrections/\(queued.id).json")
    }

    public func corrections(for submissionId: Int? = nil) -> [QueuedCorrection] {
        folders(in: "corrections").compactMap { name in
            readFile("corrections/\(name)").flatMap { try? JSONDecoder().decode(QueuedCorrection.self, from: $0) }
        }
        .filter { submissionId == nil || $0.submissionId == submissionId }
        .sorted { $0.savedAt < $1.savedAt }
    }

    /// Removes this correction, unless a newer one for the photo replaced it meanwhile.
    public func removeCorrection(_ queued: QueuedCorrection) {
        let current = corrections(for: queued.submissionId).first { $0.attachmentId == queued.attachmentId }
        guard current?.correction.clientCorrectionUuid == queued.correction.clientCorrectionUuid else { return }
        removeFile("corrections/\(queued.id).json")
    }
}

/// Saving photo corrections: sent at once when ERIS can be reached, otherwise
/// kept and sent with the rest of the waiting work. A correction carries its
/// own id, so one sent again after a lost answer is recognised, not recorded twice.
public struct PhotoCorrections: Sendable {
    public enum Outcome: Equatable, Sendable {
        case nothing, sent, unreachable
    }

    let api: APIClient
    let store: OfflineStore

    public init(api: APIClient, store: OfflineStore) {
        self.api = api
        self.store = store
    }

    /// True when ERIS has it; false when it is kept on this iPhone to send.
    /// Throws when ERIS refuses it.
    public func save(_ submissionId: Int, attachmentId: Int, _ correction: PhotoCorrection) async throws -> Bool {
        let queued = QueuedCorrection(submissionId: submissionId, attachmentId: attachmentId, correction: correction)
        // Kept first, so nothing is lost if the app stops part way.
        store.keepCorrection(queued)
        do {
            try await SubmissionsAPI(api: api).correctPhoto(submissionId, attachmentId: attachmentId, correction)
            store.removeCorrection(queued)
            _ = try? await SubmissionsAPI(api: api).photoMap(submissionId, keepingIn: store)
            return true
        } catch let error as APIError where error.isUnreachable {
            return false
        } catch {
            store.removeCorrection(queued)
            throw error
        }
    }

    /// Sends what is waiting; a refused one is kept with the reason, for the person to see.
    public func sendAll() async -> Outcome {
        var outcome = Outcome.nothing
        var sentForms = Set<Int>()
        for queued in store.corrections() where queued.problem == nil {
            do {
                try await SubmissionsAPI(api: api).correctPhoto(queued.submissionId, attachmentId: queued.attachmentId,
                                                               queued.correction)
                store.removeCorrection(queued)
                sentForms.insert(queued.submissionId)
                outcome = .sent
            } catch let error as APIError where error.isUnreachable {
                return .unreachable
            } catch let error as APIError {
                var refused = queued
                refused.problem = Self.refusal(error)
                store.keepCorrection(refused)
            } catch {
                var refused = queued
                refused.problem = "ERIS answered in a way this app does not understand."
                store.keepCorrection(refused)
            }
        }
        // The kept photo maps follow what is now saved.
        for id in sentForms { _ = try? await SubmissionsAPI(api: api).photoMap(id, keepingIn: store) }
        return outcome
    }

    static func refusal(_ error: APIError) -> String {
        if case .notFound = error { return "This photo is no longer on the form." }
        if case .forbidden(let detail) = error { return detail ?? "You can no longer correct this photo." }
        return error.refusal
    }
}

extension SubmissionsAPI {
    /// The photo map, or the copy kept on this iPhone when ERIS cannot be
    /// reached; corrections waiting to send are shown as made (refused ones are not).
    public func photoMap(_ id: Int, keepingIn store: OfflineStore) async throws -> Kept<PhotoMap> {
        let (map, keptAt) = try await api.kept("/submissions/\(id)/photo-map", store: store, name: "forms/\(id)-photo-map",
                                               as: PhotoMap.self)
        return Kept(value: map.applying(store.corrections(for: id).filter { $0.problem == nil }), keptAt: keptAt)
    }
}

extension PhotoMap {
    /// The map with these corrections made, as ERIS will show it once it has them.
    public func applying(_ corrections: [QueuedCorrection]) -> PhotoMap {
        guard !corrections.isEmpty else { return self }
        let byPhoto = Dictionary(corrections.map { ($0.attachmentId, $0.correction) }, uniquingKeysWith: { _, latest in latest })
        return PhotoMap(submissionId: submissionId, canEditCorrections: canEditCorrections, summary: summary,
                        photos: photos.map { photo in byPhoto[photo.attachmentId].map(photo.corrected) ?? photo })
    }
}

extension MappedPhoto {
    /// Largest location error, in metres, a photo is mapped with (the server's rule).
    static let maxMappedAccuracyM = 20.0
    /// Lowest heading accuracy code a direction is shown with (the server's rule).
    static let minMappedHeadingAccuracyCode = 2

    /// The photo with this correction made: a corrected value replaces the
    /// camera's, and nil restores what the camera recorded (where good enough to map).
    public func corrected(_ correction: PhotoCorrection) -> MappedPhoto {
        var location = (latitude: latitude, longitude: longitude, accuracy: horizontalAccuracyM, source: locationSource)
        var heading = (degrees: cameraHeadingDeg, accuracy: cameraHeadingAccuracyCode, source: headingSource)
        if let new = correction.locationOverride {
            location = (new.latitude, new.longitude, nil, "MANUAL")
        } else if self.correction?.locationOverridden == true {
            location = cameraLocation
        }
        if let new = correction.headingOverrideDeg {
            heading = (new, nil, "MANUAL")
        } else if self.correction?.headingOverridden == true {
            heading = cameraHeading
        }
        let made = Correction(hasHistory: true, locationOverridden: correction.locationOverride != nil,
                              headingOverridden: correction.headingOverrideDeg != nil,
                              locationOverride: correction.locationOverride.map { .init(latitude: $0.latitude, longitude: $0.longitude) },
                              headingOverrideDeg: correction.headingOverrideDeg, correctedAt: nil, waitingToSend: true)
        return MappedPhoto(attachmentId: attachmentId, fileName: fileName, mimeType: mimeType, sectionKey: sectionKey,
                           sourceScope: sourceScope, canEditCorrection: canEditCorrection, capturedAt: capturedAt,
                           latitude: location.latitude, longitude: location.longitude, horizontalAccuracyM: location.accuracy,
                           cameraHeadingDeg: heading.degrees, cameraHeadingAccuracyCode: heading.accuracy,
                           locationSource: location.source, headingSource: heading.source, correction: made,
                           capturedMetadata: capturedMetadata, downloadUrl: downloadUrl)
    }

    private var cameraLocation: (latitude: Double?, longitude: Double?, accuracy: Double?, source: String?) {
        guard let m = capturedMetadata, let latitude = m.latitude, let longitude = m.longitude,
              let accuracy = m.horizontalAccuracyM, accuracy >= 0, accuracy <= Self.maxMappedAccuracyM
        else { return (nil, nil, capturedMetadata?.horizontalAccuracyM, nil) }
        return (latitude, longitude, accuracy, m.locationSource)
    }

    private var cameraHeading: (degrees: Double?, accuracy: Int?, source: String?) {
        guard let m = capturedMetadata, let degrees = m.cameraHeadingDeg, let accuracy = m.cameraHeadingAccuracyCode,
              accuracy >= Self.minMappedHeadingAccuracyCode, m.headingReference == "TRUE_NORTH"
        else { return (nil, capturedMetadata?.cameraHeadingAccuracyCode, nil) }
        return (degrees, accuracy, m.headingSource)
    }
}
