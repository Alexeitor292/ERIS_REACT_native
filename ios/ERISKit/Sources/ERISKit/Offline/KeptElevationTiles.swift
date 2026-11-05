import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// USGS elevation tiles from ERIS, each kept once read, so a site measures the same with no
/// signal as with one, and the same as on the website. USGS data is public domain, and a
/// tile never changes under the same name, so what is kept is used before asking again.
public struct KeptElevationTiles: Sendable {
    let api: APIClient
    let store: OfflineStore

    public init(api: APIClient, store: OfflineStore) {
        self.api = api
        self.store = store
    }

    private func name(_ row: Int, _ col: Int) -> String { "usgs-elevation-\(row)-\(col)" }

    func tile(row: Int, col: Int) async throws -> Data? {
        if let copy = store.copy(named: name(row, col)) { return copy.data }
        do {
            let data = try await api.bytes("GET", "/elevation-tiles/\(row)/\(col)")
            _ = try ElevationTile(data: data)
            store.keep(data, as: name(row, col))
            return data
        } catch APIError.notFound {
            return nil
        }
    }

    public var elevation: UsgsElevation {
        UsgsElevation { row, col in try await tile(row: row, col: col) }
    }

    /// Keeps what measuring this form needs: the ground around its site, so an area drawn
    /// there with no signal can be measured, and under any areas already drawn. Whatever
    /// could not be read now is read next time.
    public func keep(form: GisaForm) async {
        var spots = [SiteTerrain.Spot]()
        if let site = form.coordinate {
            spots += SiteTerrain.spotsAround(latitude: site.latitude, longitude: site.longitude)
        }
        for area in SiteAreas.areas(fromText: form["geometry_json"]) {
            let rings = SiteTerrain.rings(area)
            if let outer = rings.first, outer.count >= 3 { spots += SiteTerrain.spotsToKeep(rings) }
        }
        _ = try? await elevation.heights(at: spots)
    }
}
