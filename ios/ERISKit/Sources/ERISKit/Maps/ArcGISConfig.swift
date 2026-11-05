import Foundation

/// `GET /arcgis/runtime-config`: what the maps need from ERIS — the API key
/// for Esri basemaps and the deployment license — handed out at run time so
/// no secret is built into the app. Kept on the iPhone for maps offline, until
/// the server's offline window (`offline_ttl_hours`) runs out.
public struct ArcGISConfig: Decodable, Equatable, Sendable {
    public let runtimeEnabled: Bool
    public let apiKey: String?
    public let licenseKey: String?
    public let licenseExpiresAt: String?
    /// A mobile map package (.mmpk) for an offline basemap, if one is published.
    public let mmpkUrl: String?
    public let offlineTtlHours: Int
    public let issuedAt: String

    enum CodingKeys: String, CodingKey {
        case runtimeEnabled = "runtime_enabled", apiKey = "api_key", licenseKey = "license_key"
        case licenseExpiresAt = "license_expires_at", mmpkUrl = "mmpk_url", offlineTtlHours = "offline_ttl_hours"
        case issuedAt = "issued_at"
    }

    /// Whether a kept copy may still be used.
    public func usable(now: Date = Date()) -> Bool {
        guard let issued = ServerDate.parse(issuedAt) else { return true }
        return now.timeIntervalSince(issued) <= Double(max(1, offlineTtlHours)) * 3600
    }
}

extension APIClient {
    /// The maps' configuration, or the kept copy within its offline window.
    public func arcGISConfig(keepingIn store: OfflineStore?, now: Date = Date()) async throws -> ArcGISConfig? {
        let (config, keptAt) = try await kept("/arcgis/runtime-config", preservingKeys: true, store: store, name: "arcgis-config",
                                              as: ArcGISConfig.self)
        if keptAt != nil && !config.usable(now: now) { return nil }
        return config
    }
}
