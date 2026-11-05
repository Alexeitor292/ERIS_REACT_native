import Foundation

/// The offline 3D terrain of a form's site (`/submissions/{id}/gisa/offline-scene-package`),
/// kept on the iPhone with the work assigned: asked for when the server has none
/// yet, downloaded once ready, checked (SHA-256, then every entry's CRC) and
/// unpacked. Only the ERIS terrain bundle is used; the older ArcGIS scene
/// package format is not.
public struct AssignedTerrain: Sendable {
    public enum Outcome: Equatable, Sendable {
        /// Already on this iPhone, as the server has it.
        case kept
        case downloaded
        /// The server is preparing it (asked now or before).
        case preparing
        /// Not available for this form, and why.
        case unavailable(String)
        case unreachable
    }

    let api: APIClient
    let store: OfflineStore
    let download: @Sendable (URL) async throws -> Data

    public init(api: APIClient, store: OfflineStore,
                download: @escaping @Sendable (URL) async throws -> Data = AssignedWork.fetch) {
        self.api = api
        self.store = store
        self.download = download
    }

    /// The kept terrain of a form: its folder of unpacked files, if any.
    public static func folder(_ submissionId: Int) -> String { "terrain/\(submissionId)" }

    /// Keeps the form's terrain. `byHand` marks one asked for on a form not
    /// assigned, which `prune` leaves until sign-out.
    public func keep(_ submissionId: Int, byHand: Bool = false) async -> Outcome {
        let path = "/submissions/\(submissionId)/gisa/offline-scene-package"
        let descriptor: OfflineScene.SceneAreaDescriptor
        do {
            descriptor = try await api.get(path, preservingKeys: true, as: OfflineScene.SceneAreaDescriptor.self)
        } catch let error as APIError where error.isUnreachable {
            return .unreachable
        } catch {
            return .unavailable("The site's terrain could not be looked up.")
        }
        guard descriptor.available, let package = descriptor.package else {
            // Ask the server to prepare it; a job already running is fine.
            do {
                _ = try await api.request("POST", "\(path)/generate", as: EmptyResponse.self)
                return .preparing
            } catch APIError.http(409, _) {
                return .preparing
            } catch let error as APIError where error.isUnreachable {
                return .unreachable
            } catch let error as APIError {
                return .unavailable(error.refusal)
            } catch {
                return .unavailable(descriptor.reason ?? "No terrain is prepared for this site.")
            }
        }
        guard !OfflineScene.usesMspkRuntime(package.format) else {
            return .unavailable("This site's terrain is in a format the app does not open.")
        }
        if let kept = keptSHA(submissionId), kept == package.sha256.lowercased() { return .kept }
        do {
            let grant = try await api.get("\(path)/download", preservingKeys: true, as: OfflineScene.SceneDownloadGrant.self)
            guard let url = URL(string: grant.url) else { return .unavailable("The terrain download link is not valid.") }
            let data = try await download(url)
            guard OfflineScene.sizeMatches(grant.sizeBytes, data.count),
                  OfflineScene.shaMatches(grant.sha256, SHA256.hex(data)) else {
                return .unavailable("The terrain download was damaged; it will be tried again.")
            }
            let extracted = try TerrainBundle.extractAndValidateBundle(data)
            let folder = Self.folder(submissionId)
            store.removeFile(folder)
            for (name, bytes) in extracted.files { store.writeFile(Data(bytes), to: "\(folder)/\(name)") }
            if byHand { store.writeFile(Data("1".utf8), to: "\(folder)/.by-hand") }
            store.writeFile(Data(grant.sha256.lowercased().utf8), to: "\(folder)/.sha256")
            return .downloaded
        } catch let error as APIError where error.isUnreachable {
            return .unreachable
        } catch let error as TerrainBundle.BundleError {
            return .unavailable("The terrain package could not be opened: \(error.message)")
        } catch {
            return .unreachable
        }
    }

    /// Removes the terrain that came with work no longer assigned; `forms` are
    /// those still needed (assigned, or with changes waiting).
    public func prune(keeping forms: Set<Int>) {
        for name in store.folders(in: "terrain") {
            guard let id = Int(name), !forms.contains(id) else { continue }
            if store.readFile("\(Self.folder(id))/.by-hand") != nil { continue }
            store.removeFile(Self.folder(id))
        }
    }

    private func keptSHA(_ submissionId: Int) -> String? {
        store.readFile("\(Self.folder(submissionId))/.sha256").map { String(decoding: $0, as: UTF8.self) }
    }
}

extension OfflineStore {
    /// The folder holding a form's kept terrain, when it is complete.
    public func terrainFolder(_ submissionId: Int) -> URL? {
        let folder = directory.appendingPathComponent(AssignedTerrain.folder(submissionId))
        let marker = folder.appendingPathComponent(".sha256")
        return FileManager.default.fileExists(atPath: marker.path) ? folder : nil
    }
}
