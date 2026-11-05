import Foundation

/// Where elevations come from when measuring: online, or the terrain kept on the iPhone.
public protocol ElevationSampling: Sendable {
    /// In the order asked, nil where there is no data.
    func heights(at spots: [SiteTerrain.Spot]) async throws -> [Double?]
    /// In words, for saying where a value came from.
    var sourceName: String { get }
}

/// A drone survey ready to measure with: its heights lined up with the terrain model.
public struct SurveyGround: Sendable {
    public let survey: DroneSurvey
    let grid: DroneGrid
    let sea: DroneGrid

    public init(survey: DroneSurvey, grid: DroneGrid) {
        self.survey = survey
        self.grid = grid
        sea = grid.seaFilled(offsetM: survey.verticalOffsetM)
    }

    func height(at spot: SiteTerrain.Spot) -> Double? {
        grid.height(at: spot).map { $0 + survey.verticalOffsetM }
    }

    /// The ground for a reader: its height, or sea level where it saw the sea it could not map.
    func ground(at spot: SiteTerrain.Spot) -> (z: Double, sea: Bool)? {
        if let z = height(at: spot) { return (z, false) }
        return sea.height(at: spot) == nil ? nil : (DroneGrid.seaLevelM, true)
    }
}

/// One measurement of an area, the way the website's workspace makes it.
public struct SiteMeasureResult: Sendable {
    public struct Drone: Sendable {
        public let comparison: SiteTerrain.Comparison
        public let beforeTitle: String
        public let nowTitle: String
        /// Share of the compared area the earlier survey saw as sea: gains there are a lower bound.
        public let seaShare: Double
    }

    public let measurement: SiteTerrain.Measurement
    public let suggestions: [String: String]
    public let section: [SiteTerrain.SectionSpot]
    public let scarp: SiteTerrain.ScarpSuggestion?
    public let drone: Drone?
    /// A survey is loaded but covers too little of the area to measure it.
    public let droneCoverage: Double?
    public let terrainSource: String
    public let missing: Int

    /// Where a field's suggestion came from, in words.
    public func from(_ key: String) -> String {
        guard let drone else { return terrainSource }
        let before = key == "measure_slope_height_ft" || key == "measure_original_slope_deg"
        return before ? "Before: \(drone.beforeTitle)" : "Now: \(drone.nowTitle)"
    }

    public static func measure(area: SiteAreas.Area, terrain: ElevationSampling, now: SurveyGround?, before: SurveyGround?) async throws -> SiteMeasureResult {
        let rings = SiteTerrain.rings(area)
        guard let outer = rings.first, outer.count >= 3 else { throw Problem(message: "That area has no outline to measure.") }
        let plan = SiteTerrain.samplePlan(rings)
        let all = plan.inside + plan.around
        let z = try await terrain.heights(at: all)
        func samples(_ points: [SiteTerrain.Spot], offset: Int) -> [SiteTerrain.Sample] {
            points.enumerated().compactMap { i, spot in z[offset + i].map { SiteTerrain.Sample(spot: spot, z: $0) } }
        }
        let inside = samples(plan.inside, offset: 0)
        let around = samples(plan.around, offset: plan.inside.count)
        guard let measurement = SiteTerrain.measure(rings, inside: inside, around: around) else {
            throw Problem(message: "The terrain model has no usable data under this area.")
        }

        var drone: Drone?
        var coverage: Double?
        if let now {
            let actual = all.map(now.height)
            let beforeGround = before.map { ground in all.map(ground.ground) }
            let historical: [Double?] = beforeGround.map { $0.map { $0?.z } } ?? z
            let withSea = SiteTerrain.compare(rings, plan: plan, before: historical, now: actual)
            // Slope, height and length describe ground: water is not slope, so they come from what
            // the earlier survey mapped; the volumes and the change count the sea as its surface.
            let onLand = beforeGround.flatMap { ground in
                SiteTerrain.compare(rings, plan: plan, before: ground.map { $0?.sea == false ? $0?.z : nil }, now: actual)
            }
            let comparison: SiteTerrain.Comparison? = withSea.map { c in
                guard let onLand else { return c }
                return SiteTerrain.Comparison(original: onLand.original, updated: c.updated, paired: c.paired, coverage: c.coverage,
                                              maxLossM: c.maxLossM, maxGainM: c.maxGainM, meanChangeM: c.meanChangeM,
                                              lossVolumeM3: c.lossVolumeM3, gainVolumeM3: c.gainVolumeM3, netVolumeM3: c.netVolumeM3)
            }
            let insideCount = plan.inside.count
            let bothHere = (0..<insideCount).filter { actual[$0] != nil && historical[$0] != nil }.count
            coverage = comparison?.coverage ?? Double(bothHere) / Double(max(1, insideCount))
            if let comparison, comparison.coverage >= 0.5 {
                let sea = beforeGround.map { ground in (0..<insideCount).filter { ground[$0]?.sea == true && actual[$0] != nil }.count } ?? 0
                drone = Drone(comparison: comparison, beforeTitle: before?.survey.title ?? "terrain model", nowTitle: now.survey.title,
                              seaShare: comparison.paired > 0 ? Double(sea) / Double(comparison.paired) : 0)
            }
        }

        // The section down the fall line, for the graph and for looking for the scarp.
        let bearing = drone?.comparison.original.downslopeBearingDeg ?? measurement.downslopeBearingDeg
        let line = SiteTerrain.profileLine(rings, bearingDeg: bearing, marginM: max(10, plan.bufferM))
        let along = SiteTerrain.spots(from: line.top, to: line.bottom, count: 90)
        let terrainLine = before == nil ? try await terrain.heights(at: along.map(\.spot)) : []
        let section: [SiteTerrain.SectionSpot] = along.enumerated().map { i, point in
            let ground = before?.ground(at: point.spot)
            return SiteTerrain.SectionSpot(distanceM: point.distanceM, spot: point.spot,
                                           before: before == nil ? terrainLine[i] : ground?.z,
                                           beforeIsSea: ground?.sea ?? false,
                                           now: now?.height(at: point.spot))
        }
        return SiteMeasureResult(
            measurement: measurement,
            suggestions: drone.map { SiteTerrain.fieldValues($0.comparison) } ?? SiteTerrain.fieldValues(measurement),
            section: section,
            scarp: drone == nil ? nil : SiteTerrain.scarpSuggestion(rings, section: section),
            drone: drone,
            droneCoverage: coverage,
            terrainSource: terrain.sourceName,
            missing: all.count - inside.count - around.count
        )
    }

    public struct Problem: LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }
}

/// Heights from the terrain package kept on the iPhone, which works with no signal.
public struct PackagedElevation: ElevationSampling {
    let meta: TerrainBundle.TerrainMeta
    let grid: [Float]
    public static let name = "Terrain kept on this iPhone"
    public var sourceName: String { Self.name }

    public init(meta: TerrainBundle.TerrainMeta, grid: [Float]) {
        self.meta = meta
        self.grid = grid
    }

    public init?(folder: URL) {
        guard let manifestData = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")),
              let json = try? JSONDecoder().decode(JSONValue.self, from: manifestData),
              let terrain = TerrainBundle.Manifest(json: json).terrain,
              let bytes = try? Data(contentsOf: folder.appendingPathComponent(terrain.file.isEmpty ? "elevation-grid.bin" : terrain.file)),
              let grid = try? TerrainBundle.decodeHeightGrid([UInt8](bytes), rows: terrain.rows, cols: terrain.columns) else { return nil }
        self.init(meta: terrain, grid: grid)
    }

    public func heights(at spots: [SiteTerrain.Spot]) async throws -> [Double?] { spots.map(height) }

    /// Bilinear between the four cells around a spot; nil outside the package or over no data.
    func height(_ spot: SiteTerrain.Spot) -> Double? {
        let t = meta.localTransform
        guard t.lonPerCol != 0, t.latPerRow != 0 else { return nil }
        let col = (spot.lon - t.originLon) / t.lonPerCol
        let row = (spot.lat - t.originLat) / t.latPerRow
        guard col >= 0, row >= 0, col <= Double(meta.columns - 1), row <= Double(meta.rows - 1) else { return nil }
        let (c0, r0) = (Int(col), Int(row))
        let (c1, r1) = (min(meta.columns - 1, c0 + 1), min(meta.rows - 1, r0 + 1))
        let (tx, ty) = (col - Double(c0), row - Double(r0))
        func at(_ c: Int, _ r: Int) -> Double? {
            let value = Double(grid[r * meta.columns + c])
            return value.isFinite && value != meta.noDataValue ? value : nil
        }
        guard let a = at(c0, r0), let b = at(c1, r0), let d = at(c0, r1), let e = at(c1, r1) else { return nil }
        return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + d * (1 - tx) * ty + e * tx * ty
    }
}
