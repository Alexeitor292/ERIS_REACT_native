import ERISKit
import Foundation

/// Esri's elevation tiles for the iPhone: each kept once read, so an area measures the
/// same with no signal as it did with one, and the same as on the website.
struct KeptEsriTiles: Sendable {
    let store: OfflineStore

    private func name(_ level: Int, _ row: Int, _ col: Int) -> String { "esri-elevation-\(level)-\(row)-\(col)" }

    func fetch(level: Int, row: Int, col: Int) async throws -> Data? {
        let url = URL(string: "\(EsriElevation.serviceURL)/\(level)/\(row)/\(col)")!
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 200
            if status == 404 { return nil }
            guard (200..<300).contains(status) else { throw URLError(.badServerResponse) }
            store.keep(data, as: name(level, row, col))
            return data
        } catch {
            guard let copy = store.copy(named: name(level, row, col)) else { throw error }
            return copy.data
        }
    }

    var elevation: EsriElevation {
        EsriElevation { level, row, col in try await fetch(level: level, row: row, col: col) }
    }
}

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
