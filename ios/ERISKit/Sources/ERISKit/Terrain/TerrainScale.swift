import Foundation

/// Ported from mobile/src/arcgis/terrainScale.ts. Physical scale for the 3D
/// terrain renderer: 1.0x is true scale (a metre of elevation looks like a metre
/// of ground), vertical exaggeration is a display multiplier on top, and the
/// elevation grid itself is never changed.
public enum TerrainScale {
    static let metersPerDegreeLat = 111_320.0

    /// The parts of the terrain block that fix the package's size on the ground.
    public struct Grid: Equatable, Sendable {
        public var rows: Int
        public var columns: Int
        public var bounds: TerrainBundle.Bounds?
        public var localTransform: TerrainBundle.LocalTransform?

        public init(rows: Int, columns: Int, bounds: TerrainBundle.Bounds?, localTransform: TerrainBundle.LocalTransform?) {
            self.rows = rows
            self.columns = columns
            self.bounds = bounds
            self.localTransform = localTransform
        }

        public init(_ meta: TerrainBundle.TerrainMeta) {
            self.init(rows: meta.rows, columns: meta.columns, bounds: meta.bounds, localTransform: meta.localTransform)
        }
    }

    /// The package's width (east-west) and height (north-south) in metres.
    public struct Footprint: Equatable, Sendable {
        public let widthM: Double
        public let heightM: Double
    }

    public struct SceneScale: Equatable, Sendable {
        /// Horizontal scene units per metre, and the vertical factor at 1.0x.
        public let sceneUnitsPerMeter: Double
        /// The mesh's half-extent east-west (X), in scene units.
        public let halfWidthUnits: Double
        /// The mesh's half-extent north-south (Z), in scene units.
        public let halfDepthUnits: Double
        public let widthM: Double
        public let heightM: Double
    }

    /// The package's footprint in metres, from the local transform when it is
    /// sound and otherwise the bounds; longitude scaled by cos(mid-latitude).
    /// Nil for degenerate metadata, so callers fail safe.
    public static func physicalFootprintMeters(_ meta: Grid?) -> Footprint? {
        guard let meta, meta.rows >= 2, meta.columns >= 2 else { return nil }
        let rows = Double(meta.rows)
        let cols = Double(meta.columns)
        let minLat: Double, minLon: Double, maxLat: Double, maxLon: Double
        if let lt = meta.localTransform, lt.originLon.isFinite, lt.originLat.isFinite, lt.lonPerCol.isFinite,
           lt.latPerRow.isFinite, lt.lonPerCol > 0, lt.latPerRow < 0 {
            // The origin is the NW corner: columns step east, rows step south.
            minLon = lt.originLon
            maxLon = lt.originLon + lt.lonPerCol * (cols - 1)
            maxLat = lt.originLat
            minLat = lt.originLat + lt.latPerRow * (rows - 1)
        } else {
            guard let b = meta.bounds, b.minLat.isFinite, b.minLon.isFinite, b.maxLat.isFinite, b.maxLon.isFinite,
                  !(b.maxLat <= b.minLat), !(b.maxLon <= b.minLon) else { return nil }
            minLat = b.minLat
            minLon = b.minLon
            maxLat = b.maxLat
            maxLon = b.maxLon
        }
        let midLat = (minLat + maxLat) / 2
        let cosine = cos((midLat * Double.pi) / 180)
        let cosLat = (cosine == 0 || cosine.isNaN) ? 1e-6 : cosine
        let widthM = (maxLon - minLon) * metersPerDegreeLat * abs(cosLat)
        let heightM = (maxLat - minLat) * metersPerDegreeLat
        guard widthM > 0, heightM > 0 else { return nil }
        return Footprint(widthM: widthM, heightM: heightM)
    }

    /// The scene scale for a package: the longer side spans 2·worldSize scene
    /// units and the shorter keeps the true aspect ratio. Nil for degenerate metadata.
    public static func sceneScale(_ meta: Grid?, worldSize: Double) -> SceneScale? {
        guard let fp = physicalFootprintMeters(meta), worldSize > 0 else { return nil }
        let maxDim = max(fp.widthM, fp.heightM)
        let sceneUnitsPerMeter = (2 * worldSize) / maxDim
        return SceneScale(sceneUnitsPerMeter: sceneUnitsPerMeter, halfWidthUnits: (fp.widthM * sceneUnitsPerMeter) / 2,
                          halfDepthUnits: (fp.heightM * sceneUnitsPerMeter) / 2, widthM: fp.widthM, heightM: fp.heightM)
    }

    /// Overlays draped on the terrain, lowest first. Each hugs the imagery a few
    /// decimetres up, so perspective never shifts a road off its true place.
    public enum DrapeLayer: String, CaseIterable, Sendable {
        case imagery, road, submitted, boundary, selectedRoad, sliceIndicator

        /// Metres above the mesh.
        public var liftMeters: Double {
            switch self {
            case .imagery: return 0.05
            case .road: return 0.3
            case .submitted: return 0.35
            case .boundary: return 0.4
            case .selectedRoad: return 0.55
            case .sliceIndicator: return 0.65
            }
        }
    }

    /// The old road lift (a share of worldSize, ~27 m on a 3 km area); kept only
    /// so tests can show the new lifts are far smaller.
    public static let legacyRoadLiftWorldSizeFactor = 0.018
    /// The incident's ground ring (8–12 m), not the old 75 m sphere.
    public static let incidentRingDiameterM = 10.0

    /// A layer's lift in scene units.
    public static func drapeLiftSceneUnits(_ scale: SceneScale, _ layer: DrapeLayer) -> Double {
        layer.liftMeters * scale.sceneUnitsPerMeter
    }

    /// The metres a scene-unit height stands for (NaN without a scale).
    public static func sceneUnitsToMeters(_ scale: SceneScale, _ sceneUnits: Double) -> Double {
        scale.sceneUnitsPerMeter > 0 ? sceneUnits / scale.sceneUnitsPerMeter : .nan
    }

    /// The mesh height for an elevation: (elevation − minimum) × units per metre × exaggeration.
    public static func elevationToSceneY(_ elevationMeters: Double, _ minElevationMeters: Double,
                                         _ sceneUnitsPerMeter: Double, _ exaggeration: Double) -> Double {
        (elevationMeters - minElevationMeters) * sceneUnitsPerMeter * exaggeration
    }

    /// The vertical-exaggeration slider: 0.5 to 3.0 in steps of 0.1, true scale by default.
    public static let vertExagMin = 0.5
    public static let vertExagMax = 3.0
    public static let vertExagStep = 0.1
    public static let vertExagDefault = 1.0

    /// A slider value snapped to the 0.1 step and kept within 0.5–3.0.
    public static func snapExaggeration(_ value: Double) -> Double {
        guard value.isFinite else { return vertExagDefault }
        let clamped = max(vertExagMin, min(vertExagMax, value))
        return TerrainJS.mathRound(clamped / vertExagStep) * vertExagStep
    }

    /// "1.0× True scale", as the slider shows it.
    public static func exaggerationLabel(_ value: Double) -> String {
        let x = snapExaggeration(value)
        let tag: String
        if x <= 0.6 {
            tag = "Flattened"
        } else if x < 1.0 {
            tag = "Reduced relief"
        } else if x == 1.0 {
            tag = "True scale"
        } else if x <= 1.5 {
            tag = "Field relief"
        } else if x <= 2.0 {
            tag = "Enhanced relief"
        } else {
            tag = "High relief"
        }
        return "\(TerrainJS.toFixed(x, 1))× \(tag)"
    }
}
