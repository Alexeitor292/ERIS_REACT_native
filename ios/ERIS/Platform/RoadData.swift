import ERISKit
import Foundation
import Network

/// The road inventory and Caltrans postmile reference kept on this iPhone, so
/// a location can be turned into a highway post mile (and back) without a
/// connection. Checked once a day; a new package downloads on Wi-Fi, or on any
/// network when the iPhone has none yet. Highway reference data, not anyone's
/// work, so it stays across sign-outs.
@MainActor
final class RoadData: ObservableObject {
    @Published private(set) var meta: RoadInventoryMeta?
    @Published private(set) var reference: RoadReference?
    @Published private(set) var updating = false
    @Published private(set) var problem: String?
    let store: RoadInventoryStore
    private let monitor = NWPathMonitor()
    private var expensive = false

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let folder = base.appendingPathComponent("RoadInventory", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var url = folder
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        store = RoadInventoryStore(directory: folder)
        meta = store.meta
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in self?.expensive = path.isExpensive || path.isConstrained }
        }
        monitor.start(queue: DispatchQueue(label: "eris.roads.network"))
        let store = store
        Task.detached(priority: .utility) {
            let loaded = store.loaded()
            await MainActor.run { self.reference = loaded }
        }
    }

    /// Looks for a newer package when a day has passed (or `force`).
    func refresh(api: APIClient, force: Bool = false) {
        guard !updating, force || store.due() else { return }
        // A large download waits for Wi-Fi unless there is nothing here yet.
        guard force || meta == nil || !expensive else { return }
        updating = true
        let store = store
        Task {
            do {
                let next = try await store.update(api: api)
                meta = next
                problem = nil
                reference = await Task.detached(priority: .utility) { store.loaded() }.value
            } catch APIError.forbidden {
                problem = nil  // Not for this account; the online lookup serves.
            } catch let error as RoadInventoryError {
                problem = error.errorDescription
            } catch let error as APIError where error.isUnreachable {
                if force { problem = "ERIS can't be reached. Try again when connected." }
            } catch {
                problem = "The road data could not be updated. Try again later."
            }
            updating = false
        }
    }

    /// Where a coordinate is on the state highway: from the data on this
    /// iPhone first, as the Expo app did, then the online Caltrans service.
    func locate(latitude: Double, longitude: Double) async -> RoadLookup? {
        if let fix = reference?.locate(latitude: latitude, longitude: longitude) {
            return RoadLookup(district: fix.district ?? "", county: fix.county, route: fix.route, postMile: fix.postMile,
                              distanceMeters: fix.distanceMeters, onDevice: true)
        }
        let url = CaltransPostmile.queryURL(latitude: latitude, longitude: longitude)
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let road = CaltransPostmile.nearest(in: data, latitude: latitude, longitude: longitude) else { return nil }
        return RoadLookup(district: road.district, county: road.county, route: road.route, postMile: road.postMile,
                          distanceMeters: road.distanceMeters, onDevice: false)
    }
}

/// A highway post mile found for a location.
struct RoadLookup {
    let district: String
    let county: String
    let route: String
    let postMile: String
    let distanceMeters: Double?
    /// Found in the road data on this iPhone, not online.
    let onDevice: Bool

    /// "Nearest post mile is 12 m away (road data on this iPhone)."
    var note: String {
        let distance = distanceMeters.map { "Nearest post mile is \(Int($0.rounded())) m away" } ?? "Post mile found"
        return "\(distance)\(onDevice ? " (road data on this iPhone)" : "")."
    }
}
