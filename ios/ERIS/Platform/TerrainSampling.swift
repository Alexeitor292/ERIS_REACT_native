import ERISKit
import Foundation

#if DEBUG
/// The demo's ground, so tests get the same answer with no network: a slope falling south.
struct DemoElevation: ElevationSampling {
    var sourceName: String { "Demo terrain" }

    func heights(at spots: [SiteTerrain.Spot]) async throws -> [Double?] {
        try await Task.sleep(nanoseconds: 100_000_000)
        return spots.map { DemoGround.before($0) }
    }
}
#endif

/// Whether this is the demo. Always false outside debug builds, where the demo does not exist.
enum DemoMode {
    static var isOn: Bool {
        #if DEBUG
        return DemoServer.isEnabled
        #else
        return false
        #endif
    }
}
