import ERISKit
import Foundation
import Network
import UIKit

/// Keeps this person's work up to date on this iPhone without their asking:
/// sends what was kept while offline, refreshes My Work, and keeps everything
/// assigned to them (forms, photos, the incident) ready to work on offline.
/// Runs when the network comes back, when the app comes to the front, every
/// minute while it is open, when a notice arrives (in the background too), and
/// when iOS gives the app background time.
@MainActor
final class OfflineSync: ObservableObject {
    let store: OfflineStore
    private let api: APIClient
    private let userId: Int
    private let me: Me
    /// My Work, as last loaded (from the kept copy when offline).
    @Published private(set) var work = MyWork.Loaded()
    @Published private(set) var workLoaded = false
    private var catchingUp = false
    private var lastCatchUp: Date?
    @Published private(set) var waiting: OfflineStore.Waiting
    @Published private(set) var sending = false
    /// Whether the iPhone has a network path (not whether ERIS answers).
    @Published private(set) var networkUp = true
    /// The form on screen, which saves its own changes.
    var openForm: Int?
    /// Raised after each round, so open screens can refresh.
    @Published private(set) var rounds = 0

    private let monitor = NWPathMonitor()
    private var timer: Timer?
    private var foreground: NSObjectProtocol?

    init(api: APIClient, me: Me) {
        self.api = api
        self.me = me
        let userId = me.id
        self.userId = userId
        store = OfflineStore(directory: Self.folder(for: userId), protect: { url in
            // Encrypted until the iPhone is first unlocked after a restart, so work
            // can arrive in the background while it is locked; never in backups.
            try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                                   ofItemAtPath: url.path)
        })
        Self.excludeFromBackup(Self.folder(for: userId))
        waiting = store.waiting
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                let up = path.status == .satisfied
                let cameBack = up && !self.networkUp
                self.networkUp = up
                if cameBack { Task { await self.catchUp() } }
            }
        }
        monitor.start(queue: DispatchQueue(label: "eris.offline.network"))
        foreground = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil,
                                                            queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.catchUp() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, UIApplication.shared.applicationState == .active else { return }
                await self.catchUp()
            }
        }
        Task { await catchUp() }
    }

    /// One round: send what is waiting, refresh My Work, keep what is
    /// assigned. Rounds do not overlap; one asked for during another is skipped.
    func catchUp() async {
        guard !catchingUp else { return }
        catchingUp = true
        defer { catchingUp = false }
        await send()
        let loaded = await MyWork.load(api: api, roles: me.roles, maintenanceDuties: me.hasMaintenanceDistricts, store: store)
        work = loaded
        workLoaded = true
        if RoleModel.isAssessmentAuthor(me.roles), loaded.keptAt == nil {
            _ = await AssignedWork(api: api, store: store, me: userId).prepare(loaded.assessments)
        }
        lastCatchUp = Date()
        rounds += 1
    }

    /// For a notice or background time, where iOS waits for the answer.
    func catchUpInBackground() async -> Bool {
        await catchUp()
        return work.keptAt == nil
    }

    /// One folder per person, under Application Support.
    static func folder(for userId: Int) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Offline/\(userId)", isDirectory: true)
    }

    private static func excludeFromBackup(_ folder: URL) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var url = folder
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    /// Looks again at what is waiting (after a screen keeps or sends something).
    func refresh() {
        waiting = store.waiting
    }

    /// Sends what is waiting now (Send Now, pull to refresh).
    func kick() {
        Task { await catchUp() }
    }

    /// Sends what is waiting, unless a send is already running.
    private func send() async {
        refresh()
        guard !sending, !waiting.isEmpty else { return }
        sending = true
        defer { sending = false }
        let sync = FormSync(api: api, store: store), reports = IncidentSync(api: api, store: store, me: userId)
        // Reports first: they are the newest news from the field.
        if await reports.sendAll() != .unreachable { _ = await sync.sendAll(except: openForm) }
        refresh()
    }

    /// A report to file: kept on this iPhone first, so nothing is lost if the
    /// connection drops part way, then sent at once.
    func file(_ report: QueuedIncident, files: [UUID: Data]) async -> (IncidentSync.Outcome, QueuedIncident?) {
        // One sender at a time, so a background round cannot file it too.
        while sending { try? await Task.sleep(nanoseconds: 200_000_000) }
        sending = true
        defer { sending = false }
        store.queueIncident(report, files: files)
        let outcome = await IncidentSync(api: api, store: store, me: userId).send(report)
        let kept = store.queuedIncidents().first { $0.id == report.id }
        refresh()
        return (outcome, kept)
    }

    /// Stops, and deletes everything kept (on signing out).
    func stop(wiping: Bool) {
        monitor.cancel()
        timer?.invalidate()
        if let foreground { NotificationCenter.default.removeObserver(foreground) }
        if wiping { store.wipe() }
    }
}
