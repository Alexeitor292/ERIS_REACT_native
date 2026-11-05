import Foundation

/// Which ERIS a build of the app is for, from the `ERIS_DEPLOYMENT` build
/// setting. Staging builds run the maps under ArcGIS developer licensing;
/// production builds license them with the deployment's ArcGIS Maps SDK 200.x
/// license, which the production ERIS serves (`ARCGIS_LICENSE_KEY`).
public enum Deployment: String, Sendable, Equatable {
    case staging, production

    /// From the build's Info.plist value. Anything but "staging" is production,
    /// so a build missing the setting says so when its maps go unlicensed
    /// rather than quietly running under developer licensing.
    public init(_ value: String?) {
        self = value?.trimmingCharacters(in: .whitespaces).lowercased() == "staging" ? .staging : .production
    }
}

/// How the maps are licensed for a deployment, and whether that worked.
public enum MapsLicensing: Equatable, Sendable {
    /// Staging: ArcGIS developer licensing; a license ERIS sends is not used.
    case developer
    /// Production: this license string, from ERIS.
    case license(String)
    /// Production, but ERIS sends no license.
    case missing

    /// What the ArcGIS SDK said of the license once set.
    public enum Outcome: Equatable, Sendable {
        case valid, expired
        /// Not accepted: not a license string, or not one for this SDK (a 100.x
        /// Runtime license does not license 200.x).
        case invalid
    }

    public init(_ deployment: Deployment, config: ArcGISConfig) {
        let key = config.runtimeEnabled ? config.licenseKey?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        switch (deployment, key) {
        case (.staging, _): self = .developer
        case (.production, let key?) where !key.isEmpty: self = .license(key)
        case (.production, _): self = .missing
        }
    }

    /// What to tell the person when the maps are not licensed as this build
    /// needs; nil when they are. `outcome` is nil when the license could not be set.
    public func problem(_ outcome: Outcome?) -> String? {
        switch (self, outcome) {
        case (.developer, _), (.license, .valid?): return nil
        case (.missing, _):
            return "Maps aren't licensed: this ERIS server sends no ArcGIS license. Tell the ERIS administrator."
        case (.license, .expired?):
            return "Maps aren't licensed: the ArcGIS license from ERIS has expired. Tell the ERIS administrator."
        case (.license, _):
            return "Maps aren't licensed: the ArcGIS license from ERIS isn't one for this app (it needs an ArcGIS Maps SDK 200.x license). Tell the ERIS administrator."
        }
    }

    /// One line for the Account screen; `level` is the SDK's license level once set.
    public func summary(_ outcome: Outcome?, level: String?) -> String {
        if self == .developer { return "Developer licensing (staging build)" }
        guard problem(outcome) == nil else { return "Not licensed" }
        return level.map { "Licensed (\($0))" } ?? "Licensed"
    }
}
