import Foundation

/// Ported from mobile/src/arcgis/offlineScene.ts. The rules for offline 3D
/// scene packages: what the server offers, the downloaded record kept on the
/// iPhone, when it needs refreshing, how a download recovers after a crash, and
/// the words shown for each state. File I/O and the viewer live in the app.
public enum OfflineScene {
    /// A downloaded package's lifecycle.
    public enum Status: String, Codable, Sendable, CaseIterable {
        case pending = "PENDING", downloading = "DOWNLOADING", paused = "PAUSED", ready = "READY", failed = "FAILED"
    }

    public struct Center: Codable, Equatable, Sendable {
        public var lat: Double
        public var lon: Double

        public init(lat: Double, lon: Double) {
            self.lat = lat
            self.lon = lon
        }
    }

    /// The area's bounds as the local record stores them (camelCase).
    public struct Bounds: Codable, Equatable, Sendable {
        public var minLat: Double
        public var minLon: Double
        public var maxLat: Double
        public var maxLon: Double

        public init(minLat: Double, minLon: Double, maxLat: Double, maxLon: Double) {
            self.minLat = minLat
            self.minLon = minLon
            self.maxLat = maxLat
            self.maxLon = maxLon
        }
    }

    /// The record kept on the iPhone for one downloaded scene area. Its keys
    /// are camelCase, as the Expo app's registry writes them.
    public struct PackageMeta: Codable, Equatable, Sendable {
        public var submissionId: Int
        public var incidentId: Int?
        /// A bounded area, never statewide.
        public var center: Center
        public var radiusM: Double
        public var bounds: Bounds
        /// The server's content version at download time.
        public var contentSignature: String
        public var packageVersion: String
        /// "eristerrain" (the automatic USGS 3DEP bundle) or "mspk".
        public var packageFormat: String
        /// The catalog SHA-256 and size, checked before READY.
        public var expectedSha256: String
        public var expectedSizeBytes: Int
        public var elevationSource: String?
        public var elevationDataset: String?
        public var elevationResolution: String?
        public var basemapSource: String?
        public var status: Status
        /// Bytes on disk once READY.
        public var sizeBytes: Int
        /// The checked package file, once READY.
        public var localPath: String?
        /// The unpacked eristerrain folder (manifest, grid, hillshade).
        public var extractedDir: String?
        /// The temporary .part file while downloading.
        public var partPath: String?
        /// What the downloader needs to resume after a restart.
        public var resumeSnapshot: JSONValue?
        public var downloadedAt: String?
        public var requestedAt: String
        public var error: String?

        public init(submissionId: Int, incidentId: Int?, center: Center, radiusM: Double, bounds: Bounds,
                    contentSignature: String, packageVersion: String, packageFormat: String, expectedSha256: String,
                    expectedSizeBytes: Int, elevationSource: String?, elevationDataset: String?, elevationResolution: String?,
                    basemapSource: String?, status: Status, sizeBytes: Int, localPath: String?, extractedDir: String?,
                    partPath: String?, resumeSnapshot: JSONValue?, downloadedAt: String?, requestedAt: String, error: String?) {
            self.submissionId = submissionId
            self.incidentId = incidentId
            self.center = center
            self.radiusM = radiusM
            self.bounds = bounds
            self.contentSignature = contentSignature
            self.packageVersion = packageVersion
            self.packageFormat = packageFormat
            self.expectedSha256 = expectedSha256
            self.expectedSizeBytes = expectedSizeBytes
            self.elevationSource = elevationSource
            self.elevationDataset = elevationDataset
            self.elevationResolution = elevationResolution
            self.basemapSource = basemapSource
            self.status = status
            self.sizeBytes = sizeBytes
            self.localPath = localPath
            self.extractedDir = extractedDir
            self.partPath = partPath
            self.resumeSnapshot = resumeSnapshot
            self.downloadedAt = downloadedAt
            self.requestedAt = requestedAt
            self.error = error
        }
    }

    /// `GET /submissions/{id}/gisa/offline-scene-package`: the prepared package, if any.
    public struct SceneAreaDescriptor: Decodable, Equatable, Sendable {
        public struct Area: Decodable, Equatable, Sendable {
            public let center: Center
            public let radiusM: Double
            public let bounds: TerrainBundle.Bounds

            enum CodingKeys: String, CodingKey {
                case center, bounds
                case radiusM = "radius_m"
            }

            public init(center: Center, radiusM: Double, bounds: TerrainBundle.Bounds) {
                self.center = center
                self.radiusM = radiusM
                self.bounds = bounds
            }
        }

        public struct Elevation: Decodable, Equatable, Sendable {
            public let dataset: String?
            public let version: String?
            public let resolution: String?

            public init(dataset: String?, version: String?, resolution: String?) {
                self.dataset = dataset
                self.version = version
                self.resolution = resolution
            }
        }

        public struct Package: Decodable, Equatable, Sendable {
            public let format: String
            public let version: String
            public let sizeBytes: Int
            public let sha256: String
            public let elevationSource: String?
            public let elevation: Elevation
            public let basemapOrImagerySource: String?
            public let createdAt: String?
            public let uploadedAt: String?
            /// The protected ERIS download path (not a raw storage URL).
            public let downloadPath: String?

            enum CodingKeys: String, CodingKey {
                case format, version, sha256, elevation
                case sizeBytes = "size_bytes", elevationSource = "elevation_source"
                case basemapOrImagerySource = "basemap_or_imagery_source", createdAt = "created_at"
                case uploadedAt = "uploaded_at", downloadPath = "download_path"
            }

            public init(format: String, version: String, sizeBytes: Int, sha256: String, elevationSource: String?,
                        elevation: Elevation, basemapOrImagerySource: String?, createdAt: String?, uploadedAt: String?,
                        downloadPath: String?) {
                self.format = format
                self.version = version
                self.sizeBytes = sizeBytes
                self.sha256 = sha256
                self.elevationSource = elevationSource
                self.elevation = elevation
                self.basemapOrImagerySource = basemapOrImagerySource
                self.createdAt = createdAt
                self.uploadedAt = uploadedAt
                self.downloadPath = downloadPath
            }
        }

        public let submissionId: Int
        public let available: Bool
        public let reason: String?
        public let area: Area?
        public let package: Package?
        public let contentSignature: String?

        enum CodingKeys: String, CodingKey {
            case available, reason, area, package
            case submissionId = "submission_id", contentSignature = "content_signature"
        }

        public init(submissionId: Int, available: Bool, reason: String?, area: Area?, package: Package?,
                    contentSignature: String?) {
            self.submissionId = submissionId
            self.available = available
            self.reason = reason
            self.area = area
            self.package = package
            self.contentSignature = contentSignature
        }
    }

    /// The protected download response: a short-lived presigned URL and what to check the file against.
    public struct SceneDownloadGrant: Decodable, Equatable, Sendable {
        public let submissionId: Int
        public let url: String
        public let expiresInSeconds: Int
        public let objectKey: String
        public let sha256: String
        public let sizeBytes: Int
        public let packageVersion: String
        public let packageFormat: String
        public let contentSignature: String

        enum CodingKeys: String, CodingKey {
            case url, sha256
            case submissionId = "submission_id", expiresInSeconds = "expires_in_seconds", objectKey = "object_key"
            case sizeBytes = "size_bytes", packageVersion = "package_version", packageFormat = "package_format"
            case contentSignature = "content_signature"
        }
    }

    /// The temporary file a download writes before it is checked.
    public static func partPathFor(_ finalPath: String) -> String { "\(finalPath).part" }

    // MARK: - Context layers shown to the user

    /// Which surface and overlays a downloaded package holds (see
    /// `TerrainBundle.summarizeContextLayers`), for the status pill, the package
    /// details and the Layers control.
    public struct ContextLayersSummary: Equatable, Sendable {
        public var hillshade: Bool
        public var roads: Bool
        public var imagery: Bool
        public var overview: Bool
        public var roadsReason: String?
        public var imageryReason: String?
        public var elevationSource: String?
        public var imagerySource: String?
        public var roadSource: String?
        /// A truthful description of the road context (see `describeRoadContext`).
        public var roadContext: String?
        public var roadFeatureCount: Int?
        public var attribution: [String]?
        public var imageryMode: TerrainBundle.ImageryMode?
        public var imageryTileCount: Int?
        public var imageryEffectiveMpp: Double?

        public init(hillshade: Bool, roads: Bool, imagery: Bool, overview: Bool, roadsReason: String? = nil,
                    imageryReason: String? = nil, elevationSource: String? = nil, imagerySource: String? = nil,
                    roadSource: String? = nil, roadContext: String? = nil, roadFeatureCount: Int? = nil,
                    attribution: [String]? = nil, imageryMode: TerrainBundle.ImageryMode? = nil,
                    imageryTileCount: Int? = nil, imageryEffectiveMpp: Double? = nil) {
            self.hillshade = hillshade
            self.roads = roads
            self.imagery = imagery
            self.overview = overview
            self.roadsReason = roadsReason
            self.imageryReason = imageryReason
            self.elevationSource = elevationSource
            self.imagerySource = imagerySource
            self.roadSource = roadSource
            self.roadContext = roadContext
            self.roadFeatureCount = roadFeatureCount
            self.attribution = attribution
            self.imageryMode = imageryMode
            self.imageryTileCount = imageryTileCount
            self.imageryEffectiveMpp = imageryEffectiveMpp
        }
    }

    /// One line on the packaged road context, by the richest kind present
    /// (feature-service centerlines, road-inventory geometry, a bearing line).
    /// Never says "roads" for a bearing line alone.
    public static func describeRoadContext(available: Bool?, roadKinds: [String]?) -> String {
        guard available == true else { return "No road context packaged" }
        let kinds = roadKinds ?? []
        if kinds.contains("road_centerline") { return "Feature service road network" }
        if kinds.contains("road_inventory") { return "Road inventory geometry" }
        if kinds.contains("road_bearing") { return "Road bearing context" }
        return "Road context packaged"
    }

    /// `describeRoadContext` for a manifest's roads layer.
    public static func describeRoadContext(_ roads: TerrainBundle.ContextLayer?) -> String {
        describeRoadContext(available: roads?.available, roadKinds: roads?.roadKinds)
    }

    public enum BaseSurface: String, Sendable, CaseIterable {
        case terrain, satellite, hybrid
    }

    /// The base surfaces a package can show: Satellite and Hybrid need real imagery.
    public static func availableBaseSurfaces(imagery: Bool) -> [BaseSurface] {
        imagery ? [.terrain, .satellite, .hybrid] : [.terrain]
    }

    public static func baseSurfaceAvailable(imagery: Bool, _ surface: BaseSurface) -> Bool {
        surface == .terrain ? true : imagery
    }

    /// The pill line for what the user is looking at. Never claims aerial
    /// imagery when the package only has hillshade.
    public static func describePackagedLayers(_ s: ContextLayersSummary) -> String {
        var parts = ["\(TerrainJS.nonEmpty(s.elevationSource) ?? "USGS 3DEP") elevation"]
        if s.roads { parts.append(TerrainJS.nonEmpty(s.roadContext) ?? describeRoadContext(available: true, roadKinds: [])) }
        if s.imagery {
            parts.append("Aerial imagery")
        } else if s.hillshade {
            parts.append("Hillshade relief")
        }
        return parts.joined(separator: " · ")
    }

    /// "Included", or why a layer is not.
    public static func layerAvailabilityLabel(_ available: Bool, reason: String? = nil) -> String {
        if available { return "Included" }
        switch reason {
        case "not_configured", "provider_not_configured": return "Not available (not configured)"
        case "source_error": return "Not available (source error)"
        case "incomplete_source": return "Not available (incomplete)"
        case "too_large": return "Not available (size limit)"
        case "no_data": return "Not available (no data)"
        case "no_centerline_features_in_area": return "Not available (none in area)"
        case "disabled": return "Not available (disabled)"
        default: return "Not available"
        }
    }

    // MARK: - Package files

    /// The file extension for a package format; eristerrain unless it is "mspk".
    public static func packageExt(_ format: String?) -> String {
        format == "mspk" ? "mspk" : "eristerrain"
    }

    /// `<id>.<ext>` for a package.
    public static func packageFileName(_ submissionId: Int, _ format: String?) -> String {
        "\(submissionId).\(packageExt(format))"
    }

    /// The `<id>.mspk` name older builds wrote whatever the format.
    public static func legacyPackageFileName(_ submissionId: Int) -> String { "\(submissionId).mspk" }

    /// A READY eristerrain package still under the legacy `.mspk` name, to be renamed.
    public static func needsLegacyPathMigration(_ meta: PackageMeta) -> Bool {
        guard meta.status == .ready, let path = TerrainJS.nonEmpty(meta.localPath) else { return false }
        if packageExt(meta.packageFormat) == "mspk" { return false }
        return path.hasSuffix(".mspk")
    }

    /// True when the package opens through the ArcGIS Runtime .mspk path; an
    /// eristerrain bundle must never be opened as a mobile scene package.
    public static func usesMspkRuntime(_ format: String?) -> Bool { packageExt(format) == "mspk" }

    // MARK: - Server generation jobs

    /// A server-side generation job. `status` stays a string so a new server value
    /// never breaks decoding: QUEUED, FETCHING_USGS_3DEP, BUILDING_TERRAIN,
    /// BUILDING_BASEMAP, PACKAGING, VERIFYING, UPLOADING, REGISTERING, READY,
    /// FAILED or CANCELLED.
    public struct Job: Decodable, Equatable, Sendable {
        public let id: Int
        public let submissionId: Int
        public let status: String
        public let progressPct: Double?
        public let statusMessage: String?
        public let retryCount: Int
        public let errorDetails: String?
        public let resultPackageVersion: String?
        public let area: SceneAreaDescriptor.Area?
        public let createdAt: String?
        public let updatedAt: String?

        enum CodingKeys: String, CodingKey {
            case id, status, area
            case submissionId = "submission_id", progressPct = "progress_pct", statusMessage = "status_message"
            case retryCount = "retry_count", errorDetails = "error_details", resultPackageVersion = "result_package_version"
            case createdAt = "created_at", updatedAt = "updated_at"
        }
    }

    static let terminalJobStatuses: Set<String> = ["READY", "FAILED", "CANCELLED"]

    public static func jobIsTerminal(_ status: String?) -> Bool {
        guard let status, !status.isEmpty else { return false }
        return terminalJobStatuses.contains(status)
    }

    /// A job is still running and the screen should keep polling.
    public static func jobIsActive(_ status: String?) -> Bool {
        guard let status, !status.isEmpty else { return false }
        return !terminalJobStatuses.contains(status)
    }

    /// "Packaging aerial imagery: 7 of 16 tiles", shown as the worker sent it.
    static func isTileProgressMessage(_ message: String?) -> Bool {
        guard let message else { return false }
        return message.range(of: #"aerial imagery:\s*[0-9]+\s+of\s+[0-9]+\s+tiles"#,
                             options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The progress line for a generation job.
    public static func jobStatusLine(status: String, progressPct: Double?, errorDetails: String?,
                                     statusMessage: String? = nil) -> String {
        let p = max(0, min(100, progressPct ?? 0))
        let pct = JS.numberText(p)
        if status == "PACKAGING" || status == "BUILDING_BASEMAP", isTileProgressMessage(statusMessage), let statusMessage {
            return statusMessage
        }
        switch status {
        case "QUEUED": return "Queued — preparing terrain…"
        case "FETCHING_USGS_3DEP": return "Preparing terrain: \(pct)% — downloading USGS 3DEP"
        case "BUILDING_TERRAIN": return "Preparing terrain: \(pct)% — building terrain relief"
        case "BUILDING_BASEMAP", "PACKAGING": return "Building offline terrain package: \(pct)%"
        case "VERIFYING": return "Verifying package: \(pct)%"
        case "UPLOADING": return "Uploading package: \(pct)%"
        case "REGISTERING": return "Finalizing: \(pct)%"
        case "READY": return "Ready to download"
        case "CANCELLED": return "Preparation cancelled"
        case "FAILED":
            if let details = TerrainJS.nonEmpty(errorDetails) { return "Failed — \(details)" }
            return "Preparation failed"
        default: return "Preparing offline 3D area…"
        }
    }

    /// `jobStatusLine` for a job, or the prompt to prepare one when there is none.
    public static func jobStatusLine(_ job: Job?) -> String {
        guard let job else { return "Prepare offline 3D area" }
        return jobStatusLine(status: job.status, progressPct: job.progressPct, errorDetails: job.errorDetails,
                             statusMessage: job.statusMessage)
    }

    // MARK: - Registry

    /// Runs operations one at a time, in the order they were started, even when
    /// each one awaits; keeps registry read-modify-writes from losing each other.
    public final class SerialMutex: @unchecked Sendable {
        private let lock = NSLock()
        private var tail: Task<Void, Never>?

        public init() {}

        /// Queues `operation` behind every earlier one; a failure does not stop later ones.
        @discardableResult
        public func runExclusive<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) -> Task<T, Error> {
            lock.lock()
            defer { lock.unlock() }
            let previous = tail
            let run = Task { () async throws -> T in
                await previous?.value
                return try await operation()
            }
            tail = Task { _ = await run.result }
            return run
        }
    }

    /// True when a parsed registry is well formed and at the expected version.
    public static func isValidRegistry(_ parsed: JSONValue?, version: Int) -> Bool {
        guard let o = TerrainJS.object(parsed), o["version"] == .number(Double(version)) else { return false }
        if case .array? = o["items"] { return true }
        return false
    }

    /// Which registry file to trust after a crash, and whether to delete the temporary one.
    public struct RegistryChoice: Equatable, Sendable {
        public enum Source: String, Sendable {
            case main, tmp, empty
        }

        public let use: Source
        public let cleanupTmp: Bool

        public init(use: Source, cleanupTmp: Bool) {
            self.use = use
            self.cleanupTmp = cleanupTmp
        }
    }

    /// Writes go temp then rename, so a valid main file wins; a valid temp file
    /// alone means a crash mid-rename; otherwise start empty.
    public static func chooseRegistrySource(mainValid: Bool, tmpValid: Bool) -> RegistryChoice {
        if mainValid { return RegistryChoice(use: .main, cleanupTmp: true) }
        if tmpValid { return RegistryChoice(use: .tmp, cleanupTmp: false) }
        return RegistryChoice(use: .empty, cleanupTmp: true)
    }

    // MARK: - Download state

    /// What is on disk and running for one record.
    public struct ReconcileContext: Equatable, Sendable {
        /// The checked package file is on disk.
        public var finalExists: Bool
        /// The temporary .part file is on disk.
        public var partExists: Bool
        /// A usable resume snapshot was kept.
        public var hasResumeData: Bool
        /// A download task exists in this session.
        public var hasActiveTask: Bool

        public init(finalExists: Bool, partExists: Bool, hasResumeData: Bool, hasActiveTask: Bool) {
            self.finalExists = finalExists
            self.partExists = partExists
            self.hasResumeData = hasResumeData
            self.hasActiveTask = hasActiveTask
        }
    }

    public struct Reconciled: Equatable, Sendable {
        public let status: Status
        public let error: String?

        public init(status: Status, error: String?) {
            self.status = status
            self.error = error
        }
    }

    /// A kept record checked against what is on disk (at launch and when the
    /// panel opens): READY needs its file; a DOWNLOADING record with no task
    /// pauses if it can resume; a PAUSED one that cannot resume fails.
    public static func reconcileRecord(_ status: Status, _ ctx: ReconcileContext) -> Reconciled {
        switch status {
        case .ready:
            return ctx.finalExists ? Reconciled(status: .ready, error: nil)
                : Reconciled(status: .failed, error: "Downloaded package file is missing; re-download required.")
        case .downloading:
            if ctx.hasActiveTask { return Reconciled(status: .downloading, error: nil) }
            if ctx.partExists && ctx.hasResumeData { return Reconciled(status: .paused, error: nil) }
            return Reconciled(status: .failed, error: "Download interrupted; retry required.")
        case .paused:
            if ctx.partExists && ctx.hasResumeData { return Reconciled(status: .paused, error: nil) }
            return Reconciled(status: .failed, error: "Download cannot be resumed; retry required.")
        default:
            return Reconciled(status: status, error: nil)
        }
    }

    /// Only the download generation that is current may finish, fail or clean up a record.
    public static func shouldApplyWorkerResult(currentGen: Int, workerGen: Int) -> Bool { currentGen == workerGen }

    public enum ResumeDecision: String, Sendable {
        case resume, restart
    }

    /// Resume in place when the .part file and a usable snapshot exist; otherwise start over.
    public static func resumeDecision(_ meta: PackageMeta, partExists: Bool) -> ResumeDecision {
        guard partExists, let snap = TerrainJS.object(meta.resumeSnapshot),
              TerrainJS.truthy(snap["url"]), TerrainJS.truthy(snap["fileUri"]) else { return .restart }
        return .resume
    }

    /// The files to delete with a package: the final file and its .part.
    public static func cleanupTargets(_ finalPath: String?, _ partPath: String?) -> [String] {
        var out: [String] = []
        if let finalPath = TerrainJS.nonEmpty(finalPath) { out.append(finalPath) }
        if let partPath = TerrainJS.nonEmpty(partPath), partPath != finalPath { out.append(partPath) }
        return out
    }

    /// A non-2xx download is an error page, not a package: report the HTTP
    /// status before any size or SHA check. Nil for 2xx or no status.
    public static func downloadHttpError(_ status: Int?) -> String? {
        guard let status else { return nil }
        if status >= 200 && status < 300 { return nil }
        return "Offline terrain download failed: HTTP \(status)"
    }

    public static func sizeMatches(_ expected: Int, _ actual: Int) -> Bool { expected > 0 && expected == actual }

    /// Case-insensitive, ignoring surrounding spaces; never true for a missing value.
    public static func shaMatches(_ expected: String?, _ actual: String?) -> Bool {
        guard let expected = TerrainJS.nonEmpty(expected), let actual = TerrainJS.nonEmpty(actual) else { return false }
        return expected.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            == actual.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// "500 KB", "42 MB", "2.50 GB".
    public static func formatBytes(_ n: Double?) -> String {
        guard let n, n.isFinite, n > 0 else { return "0 MB" }
        let mb = n / (1024 * 1024)
        if mb < 1 { return "\(JS.numberText(max(1, TerrainJS.mathRound(n / 1024)))) KB" }
        if mb < 1024 { return "\(TerrainJS.toFixed(mb, mb < 10 ? 1 : 0)) MB" }
        return "\(TerrainJS.toFixed(mb / 1024, 2)) GB"
    }

    /// "just now", "3h ago", "1 day ago", "6 days ago".
    public static func formatPackageAge(_ downloadedAtISO: String?, now: Date = Date()) -> String {
        guard let iso = TerrainJS.nonEmpty(downloadedAtISO) else { return "not downloaded" }
        guard let t = ServerDate.parse(iso) else { return "unknown" }
        let elapsedMs = now.timeIntervalSince(t) * 1000
        let days = (elapsedMs / 86_400_000).rounded(.down)
        if days <= 0 {
            let hours = (elapsedMs / 3_600_000).rounded(.down)
            if hours <= 0 { return "just now" }
            return "\(JS.numberText(hours))h ago"
        }
        if days == 1 { return "1 day ago" }
        return "\(JS.numberText(days)) days ago"
    }

    /// A READY package needs refreshing when the server, still offering one,
    /// has a different content signature (the incident's area changed).
    public static func needsRefresh(_ local: PackageMeta?, _ server: SceneAreaDescriptor?) -> Bool {
        guard let local, local.status == .ready else { return false }
        guard let server, server.available else { return false }
        guard let signature = TerrainJS.nonEmpty(server.contentSignature) else { return false }
        return local.contentSignature != signature
    }

    /// A READY package downloaded more than `maxAgeDays` ago.
    public static func isStale(_ meta: PackageMeta, maxAgeDays: Double, now: Date = Date()) -> Bool {
        guard meta.status == .ready, let downloadedAt = TerrainJS.nonEmpty(meta.downloadedAt),
              let t = ServerDate.parse(downloadedAt) else { return false }
        return now.timeIntervalSince(t) * 1000 > maxAgeDays * 86_400_000
    }

    public struct StorageSummary: Equatable, Sendable {
        public let count: Int
        public let readyCount: Int
        public let totalBytes: Int
    }

    public static func summarizeStorage(_ metas: [PackageMeta]) -> StorageSummary {
        StorageSummary(count: metas.count, readyCount: metas.filter { $0.status == .ready }.count,
                       totalBytes: metas.reduce(0) { $0 + $1.sizeBytes })
    }

    /// "1.5 km radius · 42 MB · USGS_3DEP": the real catalog size, before downloading.
    public static func describeScope(_ descriptor: SceneAreaDescriptor?) -> String {
        guard let descriptor, let area = descriptor.area, let package = descriptor.package else { return "No package prepared" }
        let km = TerrainJS.toFixed(area.radiusM / 1000, area.radiusM < 1000 ? 2 : 1)
        let size = formatBytes(Double(package.sizeBytes))
        return "\(km) km radius · \(size) · \(package.elevationSource ?? "elevation")"
    }

    /// The first local record for a package, made when the download is requested.
    public static func metaFromDescriptor(_ descriptor: SceneAreaDescriptor, incidentId: Int?, nowISO: String) -> PackageMeta? {
        guard descriptor.available, let area = descriptor.area, let package = descriptor.package else { return nil }
        return PackageMeta(
            submissionId: descriptor.submissionId, incidentId: incidentId, center: area.center, radiusM: area.radiusM,
            bounds: Bounds(minLat: area.bounds.minLat, minLon: area.bounds.minLon, maxLat: area.bounds.maxLat, maxLon: area.bounds.maxLon),
            contentSignature: descriptor.contentSignature ?? package.version, packageVersion: package.version,
            packageFormat: TerrainJS.nonEmpty(package.format) ?? "eristerrain", expectedSha256: package.sha256,
            expectedSizeBytes: package.sizeBytes, elevationSource: package.elevationSource,
            elevationDataset: package.elevation.dataset, elevationResolution: package.elevation.resolution,
            basemapSource: package.basemapOrImagerySource, status: .pending, sizeBytes: 0, localPath: nil,
            extractedDir: nil, partPath: nil, resumeSnapshot: nil, downloadedAt: nil, requestedAt: nowISO, error: nil)
    }
}
