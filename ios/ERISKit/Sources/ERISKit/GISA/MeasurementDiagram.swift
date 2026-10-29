import Foundation

/// The measurement diagram's model, ported from mobile/src/measurements
/// (measurementDiagramModel.ts, roadCrossSectionModel.ts,
/// buildRoadSectionFromInventory.ts, buildTerrainAppearance.ts,
/// buildMeasurementDiagramData.ts).
///
/// Orientation is always upstation: facing increasing postmile, LT is on the
/// left of the drawing and RT on the right. There is no mirrored view.

public enum MedianCategory: String, Sendable {
    case none = "NONE", painted = "PAINTED", raised = "RAISED", barrier = "BARRIER", depressed = "DEPRESSED"
}

/// A road cross-section in feet, from the road inventory or, failing that,
/// from the form's roadway width or Caltrans defaults.
public struct RoadCrossSection: Equatable, Sendable {
    /// Segment details, present only when the section came from the road inventory.
    public struct Segment: Equatable, Sendable {
        public var beginPm: Double?
        public var endPm: Double?
        public var lengthMiles: Double?
        public var routeName: String?
        public var countyCode: String?
        public var terrainCode: String?
        public var designSpeed: Double?
        public var adt: Double?
        public var landmark: String?
    }

    public enum Source: String, Sendable { case roadInventory = "ROAD_INVENTORY", formFields = "FORM_FIELDS", standard = "DEFAULT" }

    public var ltLaneCount: Int
    public var rtLaneCount: Int
    public var ltLaneWidthFt: Double
    public var rtLaneWidthFt: Double
    public var ltOutsideShoulderFt: Double
    public var ltInsideShoulderFt: Double
    public var rtInsideShoulderFt: Double
    public var rtOutsideShoulderFt: Double
    public var medianWidthFt: Double
    public var medianCategory: MedianCategory
    public var totalWidthFt: Double
    public var segment: Segment?
    public var source: Source

    static let defaultLaneFt = 12.0, freewayShoulderFt = 8.0, highwayShoulderFt = 4.0, minimumTotalFt = 20.0

    /// `buildRoadSectionFromInventory`: each width from the snapshot, else
    /// derived from a related field, else the Caltrans standard.
    public init(snapshot: [String: JSONValue]?, fallbackRoadwayWidth: Double?) {
        guard let sn = snapshot, !sn.isEmpty else {
            self = RoadCrossSection.fallback(fallbackRoadwayWidth)
            return
        }
        func num(_ value: JSONValue?) -> Double? { RoadCrossSection.number(value) }
        func pick(_ keys: String...) -> Double? { keys.lazy.compactMap { num(sn[$0]) }.first }
        func first(_ keys: String...) -> JSONValue? {
            keys.lazy.compactMap { key in sn[key].flatMap { $0 == .null ? nil : $0 } }.first
        }
        func int(_ value: JSONValue?) -> Int? { num(value).map { max(1, Int(($0 + 0.5).rounded(.down))) } }

        ltLaneCount = int(first("left_lanes", "lt_lane_count", "lt_lanes")) ?? 1
        rtLaneCount = int(first("right_lanes", "rt_lane_count", "rt_lanes")) ?? 1
        if let tww = pick("left_traveled_way_width", "lt_traveled_way_width", "lt_tww") {
            ltLaneWidthFt = tww / Double(ltLaneCount)
        } else {
            ltLaneWidthFt = pick("lt_lane_width", "left_lane_width") ?? Self.defaultLaneFt
        }
        if let tww = pick("right_traveled_way_width", "rt_traveled_way_width", "rt_tww") {
            rtLaneWidthFt = tww / Double(rtLaneCount)
        } else {
            rtLaneWidthFt = pick("rt_lane_width", "right_lane_width") ?? Self.defaultLaneFt
        }
        medianWidthFt = pick("median_width", "median_width_ft", "median_width_amt") ?? 0
        medianCategory = Self.classifyMedian(first("median_type", "median_type_code"))
        let divided = medianCategory != .none && medianWidthFt > 0
        let outside = ltLaneCount + rtLaneCount >= 4 ? Self.freewayShoulderFt : Self.highwayShoulderFt
        let inside = divided ? 4.0 : 0
        ltOutsideShoulderFt = pick("left_outside_shoulder_width", "lt_outside_shoulder_width", "lt_o_shd_tot_width",
                                   "left_outside_shoulder") ?? outside
        ltInsideShoulderFt = divided ? (pick("left_inside_shoulder_width", "lt_inside_shoulder_width", "lt_i_shd_tot_width",
                                             "left_inside_shoulder") ?? inside) : 0
        rtInsideShoulderFt = divided ? (pick("right_inside_shoulder_width", "rt_inside_shoulder_width", "rt_i_shd_tot_width",
                                             "right_inside_shoulder") ?? inside) : 0
        rtOutsideShoulderFt = pick("right_outside_shoulder_width", "rt_outside_shoulder_width", "rt_o_shd_tot_width",
                                   "right_outside_shoulder") ?? outside
        totalWidthFt = max(Self.minimumTotalFt,
                           ltOutsideShoulderFt + ltInsideShoulderFt + Double(ltLaneCount) * ltLaneWidthFt + medianWidthFt
                           + Double(rtLaneCount) * rtLaneWidthFt + rtInsideShoulderFt + rtOutsideShoulderFt)
        func text(_ key: String) -> String? { sn[key].flatMap { $0 == .null ? nil : JS.string($0) } }
        segment = Segment(beginPm: num(sn["begin_pm"]), endPm: num(sn["end_pm"]), lengthMiles: num(sn["length_miles"]),
                          routeName: text("route_name"), countyCode: text("county_code"), terrainCode: text("terrain_code"),
                          designSpeed: num(sn["design_speed"]), adt: num(sn["adt"]), landmark: text("landmark_short_desc"))
        source = .roadInventory
    }

    init(ltLaneCount: Int, rtLaneCount: Int, ltLaneWidthFt: Double, rtLaneWidthFt: Double, ltOutsideShoulderFt: Double,
         rtOutsideShoulderFt: Double, totalWidthFt: Double, source: Source) {
        self.ltLaneCount = ltLaneCount
        self.rtLaneCount = rtLaneCount
        self.ltLaneWidthFt = ltLaneWidthFt
        self.rtLaneWidthFt = rtLaneWidthFt
        self.ltOutsideShoulderFt = ltOutsideShoulderFt
        ltInsideShoulderFt = 0
        rtInsideShoulderFt = 0
        self.rtOutsideShoulderFt = rtOutsideShoulderFt
        medianWidthFt = 0
        medianCategory = .none
        self.totalWidthFt = totalWidthFt
        segment = nil
        self.source = source
    }

    static func fallback(_ roadwayWidth: Double?) -> RoadCrossSection {
        if let width = roadwayWidth, width.isFinite, width > 0 {
            // Best estimate from the total roadway encroachment width.
            let half = width / 2
            let lanes = max(1, Int((half / defaultLaneFt + 0.5).rounded(.down)))
            let laneWidth = half / Double(lanes)
            return RoadCrossSection(ltLaneCount: lanes, rtLaneCount: lanes, ltLaneWidthFt: laneWidth, rtLaneWidthFt: laneWidth,
                                    ltOutsideShoulderFt: 0, rtOutsideShoulderFt: 0, totalWidthFt: max(minimumTotalFt, width),
                                    source: .formFields)
        }
        // A two-lane undivided highway.
        return RoadCrossSection(ltLaneCount: 1, rtLaneCount: 1, ltLaneWidthFt: defaultLaneFt, rtLaneWidthFt: defaultLaneFt,
                                ltOutsideShoulderFt: highwayShoulderFt, rtOutsideShoulderFt: highwayShoulderFt,
                                totalWidthFt: 2 * (defaultLaneFt + highwayShoulderFt), source: .standard)
    }

    /// A non-negative number, as `toNum` reads it (`Number(v)`).
    static func number(_ value: JSONValue?) -> Double? {
        let out: Double?
        switch value {
        case .number(let n)?: out = n
        case .string(let s)?: out = s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : JS.number(s)
        case .bool(let b)?: out = b ? 1 : 0
        default: out = nil
        }
        guard let out, out.isFinite, out >= 0 else { return nil }
        if case .string(let s)? = value, s.isEmpty { return nil }
        return out
    }

    static func classifyMedian(_ code: JSONValue?) -> MedianCategory {
        let s = JS.string(code).trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        switch s {
        case "", "0", "N", "NONE": return .none
        case "P", "C", "1", "M": return .painted
        case "R", "K", "2", "RAISED": return .raised
        case "B", "3", "BARRIER": return .barrier
        case "D", "4", "DEPRESSED": return .depressed
        default: return .raised // an unknown, non-zero code
        }
    }
}

// MARK: - Terrain appearance

public enum TerrainMaterial: String, Sendable { case soil = "SOIL", rock = "ROCK", mixed = "MIXED" }
public enum TerrainMoisture: String, Sendable { case dry = "DRY", moist = "MOIST", wet = "WET", flowing = "FLOWING" }

/// How the ground in the diagram should look, from the form's material,
/// water and vegetation.
public struct TerrainAppearance: Equatable, Sendable {
    public var dominantMaterial: TerrainMaterial
    public var moisture: TerrainMoisture
    public var moistureLevel: Double
    public var vegetationDensity: Double
    public var rockiness: Double
    public var soilPct, rockPct, clayPct, siltPct, sandPct, gravelPct, boulderPct: Double
    public var treesPct, shrubsPct, groundcoverPct: Double
    public var seep, spring, bedding, joints, fractures: Bool
    public var pavementType: String?

    /// `buildTerrainAppearance`.
    public init(form: GisaForm) {
        func yes(_ key: String) -> Bool { form[key].trimmingCharacters(in: .whitespaces).uppercased() == "YES" }
        func pct(_ key: String) -> Double? {
            guard !form[key].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let n = JS.number(form[key]),
                  n.isFinite else { return nil }
            return min(100, max(0, n))
        }
        let rock = yes("material_rock"), soil = yes("material_soil")
        soilPct = pct("est_soil_pct") ?? (soil && !rock ? 72 : soil ? 58 : 38)
        rockPct = pct("est_rock_pct") ?? (rock && !soil ? 72 : rock ? 54 : 24)
        clayPct = pct("est_clay_pct") ?? 0
        siltPct = pct("est_silt_pct") ?? 0
        sandPct = pct("est_sand_pct") ?? 0
        gravelPct = pct("est_gravel_pct") ?? 0
        boulderPct = pct("est_boulder_pct") ?? 0
        treesPct = pct("vegetation_trees") ?? 0
        shrubsPct = pct("vegetation_bushes_shrubs") ?? 0
        groundcoverPct = pct("vegetation_groundcover") ?? 0
        moisture = yes("water_flowing") ? .flowing : yes("water_wet") ? .wet : yes("water_moist") ? .moist : .dry
        moistureLevel = [TerrainMoisture.flowing: 0.95, .wet: 0.72, .moist: 0.4, .dry: 0.1][moisture]!
        vegetationDensity = Palette.clamp01((treesPct * 0.9 + shrubsPct * 0.65 + groundcoverPct * 0.45) / 100)
        var rockiness = Palette.clamp01((rockPct * 0.7 + gravelPct * 0.18 + boulderPct * 0.55 + (rock ? 18 : 0)
                                         + (yes("material_bedding") ? 4 : 0) + (yes("material_joints") ? 7 : 0)
                                         + (yes("material_fractures") ? 10 : 0)) / 100)
        if soil && !rock { rockiness *= 0.7 }
        if rock && !soil { rockiness = max(rockiness, 0.58) }
        if !rock && !soil && rockiness < 0.32 { rockiness = 0.34 }
        self.rockiness = rockiness
        dominantMaterial = rockiness >= 0.62 ? .rock : rockiness <= 0.34 ? .soil : .mixed
        seep = yes("water_seep")
        spring = yes("water_spring")
        bedding = yes("material_bedding")
        joints = yes("material_joints")
        fractures = yes("material_fractures")
        let pavement = form["material_pavement_type"].trimmingCharacters(in: .whitespaces).uppercased()
        pavementType = pavement == "CONCRETE" || pavement == "ASPHALT" ? pavement : nil
    }
}

/// The diagram's colours as #rrggbb, from `buildTerrainPalette`.
public struct TerrainPalette: Equatable, Sendable {
    public let skyTop, skyBottom, top, mid, deep, texture, crack, moisture, vegetation, vegetationDark: String
    public let stone, stoneShade, road, roadEdge, shoulder, shoulderEdge: String

    public init(_ a: TerrainAppearance) {
        typealias P = Palette
        let clayBias = P.clamp01(a.clayPct / 100)
        let sandBias = P.clamp01(a.sandPct / 100)
        let gravelBias = P.clamp01((a.gravelPct + a.boulderPct * 0.45) / 100)
        let soilWarm = P.mix("#6f4f34", "#b08a58", sandBias)
        let soilTone = P.mix(soilWarm, "#8a4f43", clayBias * 0.45)
        let rockTone = P.mix("#59616a", "#8c8478", gravelBias * 0.55)
        let material = P.mix(soilTone, rockTone, a.rockiness)
        top = P.shade(material, 0.12 - a.rockiness * 0.03)
        mid = P.shade(material, -0.03 - a.moistureLevel * 0.04)
        deep = P.shade(material, -0.18 - a.moistureLevel * 0.1)
        texture = P.mix(top, P.shade(material, -0.28), 0.52)
        crack = P.mix("#30251d", "#1f2937", a.rockiness * 0.75)
        moisture = P.mix("#25667d", deep, 0.46)
        vegetation = P.mix(P.mix("#456c36", "#76a25b", P.clamp01(a.groundcoverPct / 100)), "#7dc46a",
                           P.clamp01(a.moistureLevel * 0.45 + a.vegetationDensity * 0.25))
        vegetationDark = P.shade(vegetation, -0.18)
        stone = P.mix("#7f7a70", "#9ea4a8", P.clamp01(a.boulderPct / 100))
        stoneShade = P.shade(stone, -0.28)
        road = a.pavementType == "CONCRETE" ? "#7c8795" : a.pavementType == "ASPHALT" ? "#384353" : "#435064"
        roadEdge = P.shade(road, 0.25)
        shoulder = P.mix(road, top, 0.25)
        shoulderEdge = P.shade(shoulder, 0.2)
        skyTop = P.mix("#07111f", "#0d1628", a.moistureLevel * 0.3)
        skyBottom = P.mix("#132338", "#0f172a", a.rockiness * 0.2)
    }
}

/// Hex colour arithmetic as buildTerrainAppearance.ts does it.
enum Palette {
    static func clamp01(_ n: Double) -> Double { min(1, max(0, n)) }

    static func rgb(_ hex: String) -> [Double] {
        var clean = hex.replacingOccurrences(of: "#", with: "")
        if clean.count == 3 { clean = clean.map { "\($0)\($0)" }.joined() }
        let chars = Array(clean)
        return stride(from: 0, to: 6, by: 2).map { Double(Int(String(chars[$0..<$0 + 2]), radix: 16) ?? 0) }
    }

    static func hex(_ rgb: [Double]) -> String {
        "#" + rgb.map { String(format: "%02x", Int(min(255, max(0, ($0 + 0.5).rounded(.down))))) }.joined()
    }

    static func mix(_ a: String, _ b: String, _ amount: Double) -> String {
        let t = clamp01(amount)
        let (x, y) = (rgb(a), rgb(b))
        return hex(zip(x, y).map { $0 + ($1 - $0) * t })
    }

    static func shade(_ hex: String, _ amount: Double) -> String {
        amount >= 0 ? mix(hex, "#ffffff", amount) : mix(hex, "#000000", abs(amount))
    }
}

// MARK: - Diagram data

/// Which Caltrans field-measurement scenario the diagram shows.
public enum DiagramTemplate: String, CaseIterable, Identifiable, Sendable {
    case throughRoad = "LANDSLIDE_THROUGH_ROAD", aboveRoad = "LANDSLIDE_ABOVE_ROAD"
    /// The internal key keeps a legacy synonym; users see "Landslide Below Road".
    case belowRoad = "LANDSLIDE_BELOW_ROAD_SLIPOUT"

    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .throughRoad: return "Landslide Through Road"
        case .aboveRoad: return "Landslide Above Road"
        case .belowRoad: return "Landslide Below Road"
        }
    }
}

/// Which side of the road (facing upstation) the landslide comes from.
public enum FailureSide: String, CaseIterable, Identifiable, Sendable {
    case lt = "LT", rt = "RT", both = "BOTH"
    public var id: String { rawValue }
}

/// The ground on each side of the road: which side rises above it.
public enum TerrainShape: String, CaseIterable, Identifiable, Sendable {
    case leftHigh = "LEFT_HIGH", rightHigh = "RIGHT_HIGH", bowl = "BOWL", crown = "CROWN", flat = "FLAT"
    public var id: String { rawValue }
}

public struct MeasurementValues: Equatable, Sendable {
    public var slopeHeightFt, originalSlopeDeg, landslideWidthFt, landslideLengthFt: Double?
    public var mainScarpHeightFt, landslideSlopeDeg, roadwayLengthFt, roadwayWidthFt: Double?
}

/// Everything the diagram draws (`buildMeasurementDiagramData`).
public struct MeasurementDiagramData: Equatable, Sendable {
    public let template: DiagramTemplate
    public let failureSide: FailureSide
    public let terrainShape: TerrainShape
    public let appearance: TerrainAppearance
    public let crossSection: RoadCrossSection
    public let measurements: MeasurementValues

    /// `template` and `terrainShape` nil mean AUTO: a through-road landslide
    /// (the form's failure boxes are deliberately not used), and the shape the
    /// elevation profile classified, or flat when it did not.
    public init(form: GisaForm, snapshot: [String: JSONValue]?, template: DiagramTemplate?, failureSide: FailureSide,
                terrainShape: TerrainShape?, profile: ElevationProfile?) {
        func value(_ key: String) -> Double? {
            let raw = form[key].trimmingCharacters(in: .whitespacesAndNewlines)
            return raw.isEmpty ? nil : JSParse.float(raw)
        }
        measurements = MeasurementValues(
            slopeHeightFt: value("measure_slope_height_ft"), originalSlopeDeg: value("measure_original_slope_deg"),
            landslideWidthFt: value("measure_landslide_width_ft"), landslideLengthFt: value("measure_landslide_length_ft"),
            mainScarpHeightFt: value("measure_main_scarp_height_ft"), landslideSlopeDeg: value("measure_landslide_slope_deg"),
            roadwayLengthFt: value("measure_roadway_length_ft"), roadwayWidthFt: value("measure_roadway_width_ft"))
        crossSection = RoadCrossSection(snapshot: snapshot, fallbackRoadwayWidth: measurements.roadwayWidthFt)
        appearance = TerrainAppearance(form: form)
        self.template = template ?? .throughRoad
        self.failureSide = failureSide
        self.terrainShape = terrainShape ?? profile?.classification.flatMap(TerrainShape.init(rawValue:)) ?? .flat
    }
}

/// JavaScript's `parseFloat`: the longest leading decimal number, ignoring
/// what follows ("12 ft" is 12). Infinity is not a measurement, so it is nil.
enum JSParse {
    static func float(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = trimmed.range(of: #"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?"#, options: .regularExpression),
              let value = Double(trimmed[match]), value.isFinite else { return nil }
        return value
    }
}
