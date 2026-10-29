import XCTest
@testable import ERISKit

/// Ported from mobile/src/arcgis/offlineScene.test.ts.
final class OfflineSceneTests: XCTestCase {
    typealias OS = OfflineScene

    private let mib = 1024 * 1024

    private func descriptor(available: Bool = true, area: Bool = true, package: Bool = true) -> OS.SceneAreaDescriptor {
        OS.SceneAreaDescriptor(
            submissionId: 7, available: available, reason: nil,
            area: area ? OS.SceneAreaDescriptor.Area(
                center: OS.Center(lat: 38.5, lon: -121.5), radiusM: 1500,
                bounds: TerrainBundle.Bounds(minLat: 38.48, minLon: -121.52, maxLat: 38.52, maxLon: -121.48)) : nil,
            package: package ? OS.SceneAreaDescriptor.Package(
                format: "mspk", version: "abc123", sizeBytes: 42 * mib, sha256: String(repeating: "a", count: 64),
                elevationSource: "USGS_3DEP",
                elevation: OS.SceneAreaDescriptor.Elevation(dataset: "3DEP 1m", version: "2024", resolution: "1m"),
                basemapOrImagerySource: "Caltrans imagery", createdAt: "2026-06-27T00:00:00", uploadedAt: "2026-06-27T01:00:00",
                downloadPath: "/submissions/7/gisa/offline-scene-package/download") : nil,
            contentSignature: "abc123")
    }

    /// A record to vary field by field (the TypeScript tests pass partial records).
    private func meta(_ change: (inout OS.PackageMeta) -> Void = { _ in }) -> OS.PackageMeta {
        var m = OS.metaFromDescriptor(descriptor(), incidentId: nil, nowISO: "2026-06-26T00:00:00Z")!
        change(&m)
        return m
    }

    private func date(_ iso: String) -> Date { ServerDate.parse(iso)! }

    /// A server descriptor carrying only availability and a signature.
    private func server(available: Bool, signature: String?) -> OS.SceneAreaDescriptor {
        OS.SceneAreaDescriptor(submissionId: 7, available: available, reason: nil, area: nil, package: nil, contentSignature: signature)
    }

    func testFormatBytesIsHumanReadable() {
        XCTAssertEqual(OS.formatBytes(0), "0 MB")
        XCTAssertEqual(OS.formatBytes(nil), "0 MB")
        XCTAssertEqual(OS.formatBytes(500 * 1024), "500 KB")
        XCTAssertEqual(OS.formatBytes(Double(42 * mib)), "42 MB")
        let gib: Double = 1024 * 1024 * 1024
        XCTAssertEqual(OS.formatBytes(2.5 * gib), "2.50 GB")
    }

    func testFormatPackageAgeHandlesAbsentRecentOld() {
        XCTAssertEqual(OS.formatPackageAge(nil), "not downloaded")
        let now = date("2026-06-26T12:00:00Z")
        XCTAssertEqual(OS.formatPackageAge("2026-06-26T11:30:00Z", now: now), "just now")
        XCTAssertEqual(OS.formatPackageAge("2026-06-26T09:00:00Z", now: now), "3h ago")
        XCTAssertEqual(OS.formatPackageAge("2026-06-25T12:00:00Z", now: now), "1 day ago")
        XCTAssertEqual(OS.formatPackageAge("2026-06-20T12:00:00Z", now: now), "6 days ago")
    }

    func testNeedsRefreshOnlyWhenREADYLocalSignatureDiffersFromAnAvailableServerOne() {
        let ready = meta { $0.contentSignature = "abc123"; $0.status = .ready }
        // same signature -> no refresh
        XCTAssertFalse(OS.needsRefresh(ready, server(available: true, signature: "abc123")))
        // changed signature -> refresh
        XCTAssertTrue(OS.needsRefresh(ready, server(available: true, signature: "zzz999")))
        // server can't offer a package now -> keep local, no refresh churn
        XCTAssertFalse(OS.needsRefresh(ready, server(available: false, signature: nil)))
        // offline (no server descriptor) -> keep local
        XCTAssertFalse(OS.needsRefresh(ready, nil))
        // not downloaded -> not "stale"
        let pending = meta { $0.contentSignature = "abc123"; $0.status = .pending }
        XCTAssertFalse(OS.needsRefresh(pending, server(available: true, signature: "zzz")))
    }

    func testIsStaleUsesDownloadedAtMaxAge() {
        let now = date("2026-06-26T00:00:00Z")
        let old = meta { $0.downloadedAt = "2026-05-01T00:00:00Z"; $0.status = .ready }
        let fresh = meta { $0.downloadedAt = "2026-06-25T00:00:00Z"; $0.status = .ready }
        XCTAssertTrue(OS.isStale(old, maxAgeDays: 30, now: now))
        XCTAssertFalse(OS.isStale(fresh, maxAgeDays: 30, now: now))
        // non-ready / missing date is never "stale"
        XCTAssertFalse(OS.isStale(meta { $0.downloadedAt = nil; $0.status = .ready }, maxAgeDays: 30, now: now))
        XCTAssertFalse(OS.isStale(meta { $0.downloadedAt = "2020-01-01T00:00:00Z"; $0.status = .failed }, maxAgeDays: 30, now: now))
    }

    func testSummarizeStorageTotalsBytesAndCountsReadyPackages() {
        let metas = [
            meta { $0.sizeBytes = 10 * self.mib; $0.status = .ready },
            meta { $0.sizeBytes = 5 * self.mib; $0.status = .ready },
            meta { $0.sizeBytes = 0; $0.status = .failed },
        ]
        let s = OS.summarizeStorage(metas)
        XCTAssertEqual(s.count, 3)
        XCTAssertEqual(s.readyCount, 2)
        XCTAssertEqual(s.totalBytes, 15 * mib)
    }

    func testDescribeScopeShowsBoundedRadiusREALCatalogSizeElevationSource() {
        XCTAssertNotNil(OS.describeScope(descriptor()).range(of: #"1\.5 km radius · 42 MB · USGS_3DEP"#, options: .regularExpression))
        XCTAssertEqual(OS.describeScope(descriptor(area: false)), "No package prepared")
    }

    func testMetaFromDescriptorMapsAnAvailableDescriptorInclIntegrityAttribution() throws {
        let m = try XCTUnwrap(OS.metaFromDescriptor(descriptor(), incidentId: 99, nowISO: "2026-06-26T00:00:00Z"))
        XCTAssertEqual(m.submissionId, 7)
        XCTAssertEqual(m.status, .pending)
        XCTAssertEqual(m.expectedSha256, String(repeating: "a", count: 64))
        XCTAssertEqual(m.expectedSizeBytes, 42 * mib)
        XCTAssertEqual(m.elevationSource, "USGS_3DEP")
        XCTAssertEqual(m.elevationResolution, "1m")
        XCTAssertEqual(m.basemapSource, "Caltrans imagery")
        XCTAssertNil(m.localPath)
        // unavailable -> nil (no package to track)
        XCTAssertNil(OS.metaFromDescriptor(descriptor(available: false, area: false, package: false), incidentId: 99,
                                           nowISO: "2026-06-26T00:00:00Z"))
    }

    func testIntegrityHelpersPartPathSizeShaMatching() {
        XCTAssertEqual(OS.partPathFor("/docs/offline-scenes/7.mspk"), "/docs/offline-scenes/7.mspk.part")
        XCTAssertTrue(OS.sizeMatches(500, 500))
        XCTAssertFalse(OS.sizeMatches(500, 499))
        XCTAssertFalse(OS.sizeMatches(0, 0)) // zero is never a valid match
        XCTAssertTrue(OS.shaMatches("ABCdef", "abcdef")) // case-insensitive
        XCTAssertFalse(OS.shaMatches("abc", "abd"))
        XCTAssertFalse(OS.shaMatches(nil, "abc"))
    }

    private func ctx(_ finalExists: Bool, _ partExists: Bool, _ hasResumeData: Bool, _ hasActiveTask: Bool) -> OS.ReconcileContext {
        OS.ReconcileContext(finalExists: finalExists, partExists: partExists, hasResumeData: hasResumeData, hasActiveTask: hasActiveTask)
    }

    func testStateMachineAppRestartDuringDOWNLOADINGReconcilesSafely() {
        // No in-memory task after restart, no resume data, no .part -> FAILED retry.
        XCTAssertEqual(OS.reconcileRecord(.downloading, ctx(false, false, false, false)),
                       OS.Reconciled(status: .failed, error: "Download interrupted; retry required."))
        // Crash mid-download but a .part + persisted resume data exist -> PAUSED (Resume).
        XCTAssertEqual(OS.reconcileRecord(.downloading, ctx(false, true, true, false)), OS.Reconciled(status: .paused, error: nil))
        // Still actively downloading this session -> stays DOWNLOADING.
        XCTAssertEqual(OS.reconcileRecord(.downloading, ctx(false, true, true, true)), OS.Reconciled(status: .downloading, error: nil))
    }

    func testStateMachineExplicitPauseYieldsAResumablePAUSEDRecord() {
        // After Pause the record is PAUSED with .part + resume data; reconcile keeps it PAUSED.
        XCTAssertEqual(OS.reconcileRecord(.paused, ctx(false, true, true, false)), OS.Reconciled(status: .paused, error: nil))
        // PAUSED that can no longer resume -> FAILED retry.
        XCTAssertEqual(OS.reconcileRecord(.paused, ctx(false, false, false, false)),
                       OS.Reconciled(status: .failed, error: "Download cannot be resumed; retry required."))
    }

    func testStateMachineREADYWithoutItsFileFailsToAClearRecoveryState() {
        XCTAssertEqual(OS.reconcileRecord(.ready, ctx(true, false, false, false)), OS.Reconciled(status: .ready, error: nil))
        XCTAssertEqual(OS.reconcileRecord(.ready, ctx(false, false, false, false)),
                       OS.Reconciled(status: .failed, error: "Downloaded package file is missing; re-download required."))
    }

    func testResumeAfterRestartDecisionResumeVsRestartExpiredGrant() {
        let withSnap = meta {
            $0.resumeSnapshot = .object(["url": .string("https://x/y?sig=1"), "fileUri": .string("file:///p.part")])
        }
        XCTAssertEqual(OS.resumeDecision(withSnap, partExists: true), .resume) // usable state + .part
        XCTAssertEqual(OS.resumeDecision(withSnap, partExists: false), .restart) // .part gone
        // No usable snapshot (e.g. expired/cleared) -> restart from a fresh grant.
        XCTAssertEqual(OS.resumeDecision(meta { $0.resumeSnapshot = nil }, partExists: true), .restart)
    }

    func testDeleteWhilePAUSEDRemovesBothFinalAndPart() {
        XCTAssertEqual(OS.cleanupTargets("/p/7.mspk", "/p/7.mspk.part"), ["/p/7.mspk", "/p/7.mspk.part"])
        XCTAssertEqual(OS.cleanupTargets("/p/7.mspk", nil), ["/p/7.mspk"])
        XCTAssertEqual(OS.cleanupTargets(nil, "/p/7.mspk.part"), ["/p/7.mspk.part"])
    }

    func testSingleAuthoritativeCompletionPathOnlyCurrentGenerationApplies() {
        XCTAssertTrue(OS.shouldApplyWorkerResult(currentGen: 3, workerGen: 3)) // current worker
        XCTAssertFalse(OS.shouldApplyWorkerResult(currentGen: 4, workerGen: 3)) // superseded by Pause/Delete/new start
        XCTAssertFalse(OS.shouldApplyWorkerResult(currentGen: 3, workerGen: 2)) // older generation never promotes/fails
    }

    func testGenerationJobStateActiveTerminalClassification() {
        XCTAssertTrue(OS.jobIsActive("QUEUED"))
        XCTAssertTrue(OS.jobIsActive("FETCHING_USGS_3DEP"))
        XCTAssertFalse(OS.jobIsActive("READY"))
        XCTAssertFalse(OS.jobIsActive("FAILED"))
        XCTAssertFalse(OS.jobIsActive(nil))
        XCTAssertTrue(OS.jobIsTerminal("READY"))
        XCTAssertTrue(OS.jobIsTerminal("CANCELLED"))
        XCTAssertFalse(OS.jobIsTerminal("PACKAGING"))
    }

    private func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }

    func testGenerationJobStatusLinesDriveTheMobileUXCopy() {
        XCTAssertEqual(OS.jobStatusLine(nil), "Prepare offline 3D area")
        XCTAssertTrue(matches(OS.jobStatusLine(status: "FETCHING_USGS_3DEP", progressPct: 35, errorDetails: nil),
                              "Preparing terrain: 35% — downloading USGS 3DEP"))
        XCTAssertTrue(matches(OS.jobStatusLine(status: "PACKAGING", progressPct: 70, errorDetails: nil), "Building offline terrain package"))
        XCTAssertEqual(OS.jobStatusLine(status: "READY", progressPct: 100, errorDetails: nil), "Ready to download")
        XCTAssertTrue(matches(OS.jobStatusLine(status: "FAILED", progressPct: 0, errorDetails: "USGS 3DEP coverage unavailable"),
                              "Failed — USGS 3DEP coverage unavailable"))
    }

    func testPackagingSurfacesTheLivePerTileImageryProgressLineVerbatim() {
        // The worker streams a durable "Packaging aerial imagery: 7 of 16 tiles" message;
        // the status line shows it verbatim so field users see real progress.
        XCTAssertEqual(OS.jobStatusLine(status: "PACKAGING", progressPct: 72, errorDetails: nil,
                                        statusMessage: "Packaging aerial imagery: 7 of 16 tiles"),
                       "Packaging aerial imagery: 7 of 16 tiles")
        // A non-tile packaging message falls back to the generic percentage copy.
        XCTAssertTrue(matches(OS.jobStatusLine(status: "PACKAGING", progressPct: 70, errorDetails: nil,
                                               statusMessage: "Assembling offline terrain package"),
                              "Building offline terrain package: 70%"))
    }

    func testDownloadHTTPStatusIsInspectedBeforeSizeSHA403SizeMismatch() {
        // A presigned-URL 403 used to write a 535-byte error body that was then reported as
        // "size mismatch". A non-2xx status is now a clear HTTP error.
        XCTAssertEqual(OS.downloadHttpError(403), "Offline terrain download failed: HTTP 403")
        XCTAssertEqual(OS.downloadHttpError(401), "Offline terrain download failed: HTTP 401")
        XCTAssertEqual(OS.downloadHttpError(404), "Offline terrain download failed: HTTP 404")
        XCTAssertEqual(OS.downloadHttpError(500), "Offline terrain download failed: HTTP 500")
        // Success statuses (and an absent status) pass through to size + SHA validation.
        XCTAssertNil(OS.downloadHttpError(200))
        XCTAssertNil(OS.downloadHttpError(206))
        XCTAssertNil(OS.downloadHttpError(nil))
        let undefined: Int? = nil
        XCTAssertNil(OS.downloadHttpError(undefined))
    }

    func testFormatAwarePackagePathsEristerrainVsMspkNeverMspkForABundle() {
        XCTAssertEqual(OS.packageExt("eristerrain"), "eristerrain")
        XCTAssertEqual(OS.packageExt("mspk"), "mspk")
        XCTAssertEqual(OS.packageExt(nil), "eristerrain") // default
        XCTAssertEqual(OS.packageExt("weird"), "eristerrain") // unknown -> safe default
        XCTAssertEqual(OS.packageFileName(7, "eristerrain"), "7.eristerrain")
        XCTAssertEqual(OS.packageFileName(7, "mspk"), "7.mspk")
        XCTAssertEqual(OS.packageFileName(7, nil), "7.eristerrain")
        XCTAssertEqual(OS.legacyPackageFileName(7), "7.mspk")
    }

    func testOpenRoutingEristerrainUsesTheNativeRendererMspkUsesArcGISRuntime() {
        XCTAssertTrue(OS.usesMspkRuntime("mspk"))
        XCTAssertFalse(OS.usesMspkRuntime("eristerrain"))
        XCTAssertFalse(OS.usesMspkRuntime(nil)) // default bundle never loads as AGSMobileScenePackage
    }

    func testLegacyPathMigrationAREADYMspkNamedEristerrainPackageIsMigrated() {
        func record(_ status: OS.Status, _ format: String, _ path: String?) -> OS.PackageMeta {
            meta { $0.status = status; $0.packageFormat = format; $0.localPath = path }
        }
        // eristerrain package saved under the legacy `.mspk` name -> migrate.
        XCTAssertTrue(OS.needsLegacyPathMigration(record(.ready, "eristerrain", "/docs/offline-scenes/7.mspk")))
        // A real mspk package keeps `.mspk` -> no migration.
        XCTAssertFalse(OS.needsLegacyPathMigration(record(.ready, "mspk", "/docs/offline-scenes/7.mspk")))
        // Already on the canonical name -> no migration.
        XCTAssertFalse(OS.needsLegacyPathMigration(record(.ready, "eristerrain", "/docs/offline-scenes/7.eristerrain")))
        // Not READY / no localPath -> never migrate mid-flight.
        XCTAssertFalse(OS.needsLegacyPathMigration(record(.downloading, "eristerrain", "/docs/7.mspk")))
        XCTAssertFalse(OS.needsLegacyPathMigration(record(.ready, "eristerrain", nil)))
    }

    func testCleanupTargetsWorksForBothFormats() {
        XCTAssertEqual(OS.cleanupTargets("/p/7.eristerrain", "/p/7.eristerrain.part"), ["/p/7.eristerrain", "/p/7.eristerrain.part"])
    }

    // MARK: - Durable registry serialization + recovery

    private final class Box<T>: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: T
        init(_ value: T) { stored = value }
        var value: T {
            get { lock.lock(); defer { lock.unlock() }; return stored }
            set { lock.lock(); defer { lock.unlock() }; stored = newValue }
        }
    }

    private static func delay(_ ms: UInt64) async throws { try await Task.sleep(nanoseconds: ms * 1_000_000) }

    func testSerialMutexConcurrentReadModifyWriteNeverLosesRecords() async throws {
        let mutex = OS.SerialMutex()
        // The racy registry pattern: read snapshot -> await -> write back. Without the
        // mutex later writers would clobber earlier ones (lost update).
        let store = Box<[Int]>([])
        func addRecord(_ id: Int) -> Task<Void, Error> {
            mutex.runExclusive {
                let snapshot = store.value // read
                try await OfflineSceneTests.delay(5) // yield (would interleave without the lock)
                store.value = snapshot + [id] // modify + write
            }
        }
        let tasks = [addRecord(1), addRecord(2), addRecord(3), addRecord(4)]
        for task in tasks { try await task.value }
        XCTAssertEqual(store.value.sorted(), [1, 2, 3, 4]) // all present
    }

    func testSerialMutexRunsOperationsInCallOrderPauseDuringProgressPersist() async throws {
        let mutex = OS.SerialMutex()
        let order = Box<[Int]>([])
        // A slow "progress snapshot" started first, then a fast "pause": pause must wait.
        let progress = mutex.runExclusive {
            try await OfflineSceneTests.delay(15)
            order.value.append(1)
        }
        let pause = mutex.runExclusive {
            try await OfflineSceneTests.delay(1)
            order.value.append(2)
        }
        try await progress.value
        try await pause.value
        XCTAssertEqual(order.value, [1, 2])
    }

    func testSerialMutexIsolatesARejectingOpDeleteWhileCompletingKeepsTheChainAlive() async throws {
        struct Superseded: Error {}
        let mutex = OS.SerialMutex()
        let done = Box<[String]>([])
        let failing = mutex.runExclusive { () async throws -> Void in throw Superseded() }
        do {
            try await failing.value
            XCTFail("expected the operation to fail")
        } catch {
            XCTAssertTrue(error is Superseded)
        }
        try await mutex.runExclusive { done.value.append("delete-applied") }.value
        XCTAssertEqual(done.value, ["delete-applied"])
    }

    func testRegistryValidityCrashRecoverySourceSelection() {
        XCTAssertTrue(OS.isValidRegistry(.object(["version": .number(1), "items": .array([])]), version: 1))
        XCTAssertFalse(OS.isValidRegistry(.object(["version": .number(2), "items": .array([])]), version: 1)) // wrong version
        XCTAssertFalse(OS.isValidRegistry(.object(["version": .number(1), "items": .string("nope")]), version: 1)) // items not array
        XCTAssertFalse(OS.isValidRegistry(.null, version: 1))
        XCTAssertFalse(OS.isValidRegistry(.string("garbage"), version: 1))
        // main valid -> use main, clean up any stale temp.
        XCTAssertEqual(OS.chooseRegistrySource(mainValid: true, tmpValid: true), OS.RegistryChoice(use: .main, cleanupTmp: true))
        // main corrupt but temp valid -> recover temp (crash mid-rename).
        XCTAssertEqual(OS.chooseRegistrySource(mainValid: false, tmpValid: true), OS.RegistryChoice(use: .tmp, cleanupTmp: false))
        // neither -> empty, clean up garbage temp.
        XCTAssertEqual(OS.chooseRegistrySource(mainValid: false, tmpValid: false), OS.RegistryChoice(use: .empty, cleanupTmp: true))
    }

    // MARK: - Context-layer display strings + availability

    func testDescribeRoadContextIsTruthfulNeverClaimsRoadsForABearingLine() {
        XCTAssertEqual(OS.describeRoadContext(nil), "No road context packaged")
        XCTAssertEqual(OS.describeRoadContext(available: false, roadKinds: nil), "No road context packaged")
        XCTAssertEqual(OS.describeRoadContext(available: true, roadKinds: ["road_bearing"]), "Road bearing context")
        XCTAssertEqual(OS.describeRoadContext(available: true, roadKinds: ["road_bearing", "road_inventory"]), "Road inventory geometry")
        XCTAssertEqual(OS.describeRoadContext(available: true, roadKinds: ["road_bearing", "road_inventory", "road_centerline"]),
                       "Feature service road network")
        XCTAssertEqual(OS.describeRoadContext(available: true, roadKinds: []), "Road context packaged")
    }

    func testDescribePackagedLayersDistinguishesHillshadeReliefFromAerialImageryTruthfulRoadContext() {
        // Imagery present -> "Aerial imagery"; roads described truthfully (bearing-only).
        XCTAssertEqual(
            OS.describePackagedLayers(OS.ContextLayersSummary(hillshade: true, roads: true, imagery: true, overview: true,
                                                              elevationSource: "USGS_3DEP", roadContext: "Road bearing context")),
            "USGS_3DEP elevation · Road bearing context · Aerial imagery")
        // Only hillshade -> "Hillshade relief", NOT imagery; road inventory geometry.
        XCTAssertEqual(
            OS.describePackagedLayers(OS.ContextLayersSummary(hillshade: true, roads: true, imagery: false, overview: true,
                                                              elevationSource: "USGS_3DEP", roadContext: "Road inventory geometry")),
            "USGS_3DEP elevation · Road inventory geometry · Hillshade relief")
        // No roads, no imagery, no hillshade -> just elevation.
        XCTAssertEqual(OS.describePackagedLayers(OS.ContextLayersSummary(hillshade: false, roads: false, imagery: false, overview: false)),
                       "USGS 3DEP elevation")
    }

    func testBaseSurfaceAvailabilityIsImageryGatedSatelliteHybridNeedImagery() {
        XCTAssertEqual(OS.availableBaseSurfaces(imagery: false), [.terrain])
        XCTAssertEqual(OS.availableBaseSurfaces(imagery: true), [.terrain, .satellite, .hybrid])
        XCTAssertTrue(OS.baseSurfaceAvailable(imagery: false, .terrain))
        XCTAssertFalse(OS.baseSurfaceAvailable(imagery: false, .satellite))
        XCTAssertFalse(OS.baseSurfaceAvailable(imagery: false, .hybrid))
        XCTAssertTrue(OS.baseSurfaceAvailable(imagery: true, .satellite))
    }

    func testLayerAvailabilityLabelMapsReasonsToClearCopy() {
        XCTAssertEqual(OS.layerAvailabilityLabel(true), "Included")
        XCTAssertTrue(matches(OS.layerAvailabilityLabel(false, reason: "not_configured"), "not configured"))
        XCTAssertTrue(matches(OS.layerAvailabilityLabel(false, reason: "too_large"), "size limit"))
        XCTAssertTrue(matches(OS.layerAvailabilityLabel(false, reason: "source_error"), "source error"))
        XCTAssertEqual(OS.layerAvailabilityLabel(false), "Not available")
    }
}
