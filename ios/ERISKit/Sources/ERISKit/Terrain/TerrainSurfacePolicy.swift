import Foundation

/// Ported from mobile/src/arcgis/terrainSurfacePolicy.ts. Exactly one terrain
/// surface is visible per base mode: the base mesh and the tiled imagery are
/// never shown together (the base mesh used to poke through the imagery as
/// white facets), and aerial imagery is drawn unlit so no light can whiten it.
public struct TerrainSurfacePolicy: Equatable, Sendable {
    public enum BaseMode: String, Sendable, CaseIterable {
        case relief, satellite, hybrid
    }

    public struct Inputs: Equatable, Sendable {
        /// Every declared tile loaded, checked and built into a patch.
        public var tiledImageryReady: Bool
        /// A legacy single aerial image is available (older packages).
        public var singleImageAvailable: Bool

        public init(tiledImageryReady: Bool, singleImageAvailable: Bool) {
            self.tiledImageryReady = tiledImageryReady
            self.singleImageAvailable = singleImageAvailable
        }
    }

    /// Why this policy was chosen, for diagnostics and the package details.
    public enum Reason: String, Sendable {
        case relief
        case tiledSatellite = "tiled_satellite"
        case tiledHybrid = "tiled_hybrid"
        case legacySingle = "legacy_single"
        case reliefFallback = "relief_fallback"
    }

    /// The base triangular terrain mesh is the visible surface.
    public let baseTerrainVisible: Bool
    /// The tiled imagery surface is the visible surface.
    public let tiledImageryVisible: Bool
    /// Imagery is drawn with a constant (unlit) material.
    public let imageryUnlit: Bool
    /// Hybrid: hillshade is multiplied onto the same imagery surface, never a second mesh.
    public let hillshadeOnImagery: Bool
    /// Legacy single image: the base mesh's own texture is repainted (still one surface).
    public let legacySingleImageOnBase: Bool
    public let reason: Reason

    public init(baseTerrainVisible: Bool, tiledImageryVisible: Bool, imageryUnlit: Bool, hillshadeOnImagery: Bool,
                legacySingleImageOnBase: Bool, reason: Reason) {
        self.baseTerrainVisible = baseTerrainVisible
        self.tiledImageryVisible = tiledImageryVisible
        self.imageryUnlit = imageryUnlit
        self.hillshadeOnImagery = hillshadeOnImagery
        self.legacySingleImageOnBase = legacySingleImageOnBase
        self.reason = reason
    }

    /// The one visible surface and its material for a base mode. Relief always
    /// uses the base mesh; Satellite and Hybrid use ready tiles, else a legacy
    /// single image on the base mesh, else fall back to relief rather than show
    /// a partial tiled surface.
    public static func resolve(_ mode: BaseMode, _ inputs: Inputs) -> TerrainSurfacePolicy {
        let relief = TerrainSurfacePolicy(baseTerrainVisible: true, tiledImageryVisible: false, imageryUnlit: false,
                                          hillshadeOnImagery: false, legacySingleImageOnBase: false, reason: .relief)
        if mode == .relief { return relief }
        if inputs.tiledImageryReady {
            return TerrainSurfacePolicy(baseTerrainVisible: false, tiledImageryVisible: true, imageryUnlit: true,
                                        hillshadeOnImagery: mode == .hybrid, legacySingleImageOnBase: false,
                                        reason: mode == .hybrid ? .tiledHybrid : .tiledSatellite)
        }
        if inputs.singleImageAvailable {
            return TerrainSurfacePolicy(baseTerrainVisible: true, tiledImageryVisible: false, imageryUnlit: true,
                                        hillshadeOnImagery: mode == .hybrid, legacySingleImageOnBase: true,
                                        reason: .legacySingle)
        }
        return TerrainSurfacePolicy(baseTerrainVisible: true, tiledImageryVisible: false, imageryUnlit: false,
                                    hillshadeOnImagery: false, legacySingleImageOnBase: false, reason: .reliefFallback)
    }

    /// The base mesh and the tiled imagery are never both visible.
    public static func surfacesAreMutuallyExclusive(_ p: TerrainSurfacePolicy) -> Bool {
        !(p.baseTerrainVisible && p.tiledImageryVisible)
    }
}
