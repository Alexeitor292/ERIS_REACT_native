import Foundation

/// Measuring a landslide from its outline and the terrain, the same way the
/// website does (web/src/features/submissions/siteTerrainModel.ts); the tests
/// hold the two to the same numbers.
///
/// The outline is a site area drawn on the location map. Elevations are sampled on
/// a grid inside it and in a band around it, then:
/// - a plane fitted inside gives the slide's slope (β) and fall line;
/// - a plane fitted to the band gives the original slope (α);
/// - the outline projected on the fall line gives length (Ld) and width (Wd);
/// - the relief of inside and band gives the slope height (H).
public enum SiteTerrain {
    public static let feetPerMetre = 3.280839895
    static let metresPerDegreeLat = 110_540.0
    static let metresPerDegreeLonAtEquator = 111_320.0

    /// A place, as a drawn area's positions hold it.
    public struct Spot: Equatable, Sendable {
        public var lon: Double
        public var lat: Double
        public init(lon: Double, lat: Double) { self.lon = lon; self.lat = lat }
    }

    public struct Sample: Equatable, Sendable {
        public var spot: Spot
        public var z: Double
        public init(spot: Spot, z: Double) { self.spot = spot; self.z = z }
    }

    /// A flat frame in metres around a point, accurate over a site.
    struct Frame {
        let lon0: Double, lat0: Double, kx: Double
        init(_ origin: Spot) {
            lon0 = origin.lon
            lat0 = origin.lat
            kx = metresPerDegreeLonAtEquator * cos(origin.lat * .pi / 180)
        }
        func xy(_ spot: Spot) -> (x: Double, y: Double) { ((spot.lon - lon0) * kx, (spot.lat - lat0) * metresPerDegreeLat) }
        func spot(_ x: Double, _ y: Double) -> Spot { Spot(lon: lon0 + x / kx, lat: lat0 + y / metresPerDegreeLat) }
    }

    public static func rings(_ area: SiteAreas.Area) -> [[Spot]] {
        area.map { ring in ring.compactMap { $0.count >= 2 ? Spot(lon: $0[0], lat: $0[1]) : nil } }
    }

    static func centroid(_ ring: [Spot]) -> Spot {
        let closed = ring.count > 1 && ring.first == ring.last
        let points = closed ? Array(ring.dropLast()) : ring
        let count = Double(max(1, points.count))
        return Spot(lon: points.reduce(0) { $0 + $1.lon } / count, lat: points.reduce(0) { $0 + $1.lat } / count)
    }

    /// Even-odd: inside the outer ring and out of any holes.
    static func inRings(_ p: (x: Double, y: Double), _ rings: [[(x: Double, y: Double)]]) -> Bool {
        var inside = false
        for ring in rings {
            var j = ring.count - 1
            for i in ring.indices {
                let (a, b) = (ring[i], ring[j])
                if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x { inside.toggle() }
                j = i
            }
        }
        return inside
    }

    static func distanceToSegment(_ p: (x: Double, y: Double), _ a: (x: Double, y: Double), _ b: (x: Double, y: Double)) -> Double {
        let (dx, dy) = (b.x - a.x, b.y - a.y)
        let lengthSquared = dx * dx + dy * dy
        let t = lengthSquared > 0 ? max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0
        return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    }

    static func distanceToRings(_ p: (x: Double, y: Double), _ rings: [[(x: Double, y: Double)]]) -> Double {
        var best = Double.infinity
        for ring in rings where ring.count > 1 {
            for i in 1..<ring.count { best = min(best, distanceToSegment(p, ring[i - 1], ring[i])) }
        }
        return best
    }

    static func shoelace(_ ring: [(x: Double, y: Double)]) -> Double {
        var total = 0.0
        var j = ring.count - 1
        for i in ring.indices {
            total += ring[j].x * ring[i].y - ring[i].x * ring[j].y
            j = i
        }
        return abs(total) / 2
    }

    public struct SamplePlan: Equatable, Sendable {
        public let inside: [Spot]
        public let around: [Spot]
        public let spacingM: Double
        public let bufferM: Double
    }

    /// Grid points inside the outline (about `targetInside`, never closer than
    /// `minSpacingM`) and in a band around it, scaled to the outline's size.
    public static func samplePlan(_ rings: [[Spot]], targetInside: Double = 600, minSpacingM: Double = 1.5) -> SamplePlan {
        let frame = Frame(centroid(rings[0]))
        let xyRings = rings.map { $0.map(frame.xy) }
        let area = max(1, shoelace(xyRings[0]))
        let spacing = max(minSpacingM, (area / targetInside).squareRoot())
        let buffer = min(60, max(15, 0.25 * area.squareRoot()))
        let xs = xyRings[0].map(\.x), ys = xyRings[0].map(\.y)
        let (minX, maxX) = (xs.min()! - buffer, xs.max()! + buffer)
        let (minY, maxY) = (ys.min()! - buffer, ys.max()! + buffer)
        var inside: [Spot] = [], around: [Spot] = []
        var y = minY
        while y <= maxY {
            var x = minX
            while x <= maxX {
                if inRings((x, y), xyRings) {
                    inside.append(frame.spot(x, y))
                } else if distanceToRings((x, y), xyRings) <= buffer {
                    around.append(frame.spot(x, y))
                }
                x += spacing
            }
            y += spacing
        }
        return SamplePlan(inside: inside, around: around, spacingM: spacing, bufferM: buffer)
    }

    struct Plane { let a: Double, b: Double, c: Double }

    /// Least-squares plane z = a·x + b·y + c.
    static func fitPlane(_ points: [(x: Double, y: Double, z: Double)]) -> Plane? {
        guard points.count >= 3 else { return nil }
        var (sx, sy, sz, sxx, syy, sxy, sxz, syz) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        for p in points {
            sx += p.x; sy += p.y; sz += p.z
            sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y
            sxz += p.x * p.z; syz += p.y * p.z
        }
        let m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, Double(points.count)]]
        let r = [sxz, syz, sz]
        func det(_ q: [[Double]]) -> Double {
            q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1])
                - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0])
                + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0])
        }
        let d = det(m)
        guard abs(d) >= 1e-9 else { return nil }
        func column(_ c: Int) -> [[Double]] { m.enumerated().map { i, row in row.enumerated().map { j, v in j == c ? r[i] : v } } }
        return Plane(a: det(column(0)) / d, b: det(column(1)) / d, c: det(column(2)) / d)
    }

    static func degrees(_ radians: Double) -> Double { radians * 180 / .pi }

    static func percentile(_ sorted: [Double], _ p: Double) -> Double {
        guard !sorted.isEmpty else { return .nan }
        let index = Double(sorted.count - 1) * p
        let (lo, hi) = (Int(index.rounded(.down)), Int(index.rounded(.up)))
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - Double(lo))
    }

    public struct Measurement: Equatable, Sendable {
        public let landslideSlopeDeg: Double
        public let originalSlopeDeg: Double?
        /// The compass bearing the slope faces, degrees clockwise from north.
        public let downslopeBearingDeg: Double
        public let horizontalLengthM: Double
        public let slopeLengthM: Double
        public let widthM: Double
        public let slopeHeightM: Double
        public let lowElevationM: Double
        public let highElevationM: Double
        public let insideSamples: Int
        public let aroundSamples: Int
        /// The slope is too gentle for a reliable fall line: length follows the outline's long axis.
        public let directionFromOutline: Bool
    }

    public static func measure(_ rings: [[Spot]], inside: [Sample], around: [Sample]) -> Measurement? {
        guard inside.count >= 6 else { return nil }
        let frame = Frame(centroid(rings[0]))
        func local(_ s: Sample) -> (x: Double, y: Double, z: Double) {
            let p = frame.xy(s.spot)
            return (p.x, p.y, s.z)
        }
        let points = inside.map(local)
        guard let insidePlane = fitPlane(points) else { return nil }
        let aroundPlane = around.count >= 12 ? fitPlane(around.map(local)) : nil
        let gradient = hypot(insidePlane.a, insidePlane.b)
        let slope = degrees(atan(gradient))
        let outline = rings[0].map(frame.xy)
        // The fall line runs down the gradient. On near-flat ground that is noise, so
        // use the long axis of the samples inside (a grid: it weighs the area, not the corners).
        let fromOutline = slope < 2
        var ux: Double, uy: Double
        if fromOutline {
            let count = Double(points.count)
            let (mx, my) = (points.reduce(0) { $0 + $1.x } / count, points.reduce(0) { $0 + $1.y } / count)
            var (cxx, cyy, cxy) = (0.0, 0.0, 0.0)
            for p in points {
                cxx += (p.x - mx) * (p.x - mx); cyy += (p.y - my) * (p.y - my); cxy += (p.x - mx) * (p.y - my)
            }
            let angle = 0.5 * atan2(2 * cxy, cxx - cyy)
            ux = cos(angle); uy = sin(angle)
        } else {
            ux = -insidePlane.a / gradient; uy = -insidePlane.b / gradient
        }
        let along = outline.map { $0.x * ux + $0.y * uy }
        let across = outline.map { -$0.x * uy + $0.y * ux }
        let horizontal = along.max()! - along.min()!
        let width = across.max()! - across.min()!
        let elevations = (inside + around).map(\.z).sorted()
        let (low, high) = (percentile(elevations, 0.02), percentile(elevations, 0.98))
        let bearing = degrees(atan2(ux, uy)) + 360
        return Measurement(
            landslideSlopeDeg: slope,
            originalSlopeDeg: aroundPlane.map { degrees(atan(hypot($0.a, $0.b))) },
            downslopeBearingDeg: bearing.truncatingRemainder(dividingBy: 360),
            horizontalLengthM: horizontal,
            slopeLengthM: horizontal / cos(atan(gradient)),
            widthM: width,
            slopeHeightM: high - low,
            lowElevationM: low,
            highElevationM: high,
            insideSamples: inside.count,
            aroundSamples: around.count,
            directionFromOutline: fromOutline
        )
    }

    private static func feet(_ metres: Double) -> String { String(format: "%.0f", metres * feetPerMetre) }
    private static func angle(_ value: Double) -> String { String(format: "%.1f", value) }

    /// The form fields a measurement suggests, rounded as an engineer would write them.
    public static func fieldValues(_ m: Measurement) -> [String: String] {
        var values = [
            "measure_slope_height_ft": feet(m.slopeHeightM),
            "measure_landslide_width_ft": feet(m.widthM),
            "measure_landslide_length_ft": feet(m.slopeLengthM),
            "measure_landslide_slope_deg": angle(m.landslideSlopeDeg),
        ]
        if let original = m.originalSlopeDeg { values["measure_original_slope_deg"] = angle(original) }
        return values
    }

    /// "212° (SSW)".
    public static func bearingLabel(_ bearing: Double) -> String {
        let compass = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        return "\(Int(bearing.rounded()))° (\(compass[Int((bearing / 22.5).rounded()) % 16]))"
    }

    // MARK: Before and after

    public struct Comparison: Equatable, Sendable {
        public let original: Measurement
        public let updated: Measurement
        public let paired: Int
        public let coverage: Double
        public let maxLossM: Double
        public let maxGainM: Double
        public let meanChangeM: Double
        public let lossVolumeM3: Double
        public let gainVolumeM3: Double
        public let netVolumeM3: Double
    }

    /// The same outline on both grounds, sampled at the same points (`plan.inside`
    /// then `plan.around`), and the change inside it: each sample stands for a cell.
    public static func compare(_ rings: [[Spot]], plan: SamplePlan, before: [Double?], now: [Double?]) -> Comparison? {
        let n = plan.inside.count
        func samples(_ z: [Double?], _ points: [Spot], offset: Int) -> [Sample] {
            points.enumerated().compactMap { i, spot in z[offset + i].map { Sample(spot: spot, z: $0) } }
        }
        guard let original = measure(rings, inside: samples(before, plan.inside, offset: 0), around: samples(before, plan.around, offset: n)),
              let updated = measure(rings, inside: samples(now, plan.inside, offset: 0), around: samples(now, plan.around, offset: n)) else { return nil }
        let cell = plan.spacingM * plan.spacingM
        var (paired, loss, gain, sum, maxLoss, maxGain) = (0, 0.0, 0.0, 0.0, 0.0, 0.0)
        for i in 0..<n {
            guard let b = before[i], let a = now[i] else { continue }
            let d = a - b
            paired += 1
            sum += d
            if d < 0 {
                loss -= d * cell
                maxLoss = max(maxLoss, -d)
            } else {
                gain += d * cell
                maxGain = max(maxGain, d)
            }
        }
        return Comparison(original: original, updated: updated, paired: paired, coverage: n > 0 ? Double(paired) / Double(n) : 0,
                          maxLossM: maxLoss, maxGainM: maxGain, meanChangeM: paired > 0 ? sum / Double(paired) : 0,
                          lossVolumeM3: loss, gainVolumeM3: gain, netVolumeM3: gain - loss)
    }

    /// α and H describe the ground as it was; β, length and width the ground now.
    public static func fieldValues(_ c: Comparison) -> [String: String] {
        [
            "measure_slope_height_ft": feet(c.original.slopeHeightM),
            "measure_original_slope_deg": angle(c.original.landslideSlopeDeg),
            "measure_landslide_slope_deg": angle(c.updated.landslideSlopeDeg),
            "measure_landslide_length_ft": feet(c.updated.slopeLengthM),
            "measure_landslide_width_ft": feet(c.updated.widthM),
        ]
    }

    // MARK: The section down the slope

    /// Down the fall line through the outline, `marginM` past it at each end: top, then bottom.
    public static func profileLine(_ rings: [[Spot]], bearingDeg: Double, marginM: Double = 10) -> (top: Spot, bottom: Spot) {
        let frame = Frame(centroid(rings[0]))
        let radians = bearingDeg * .pi / 180
        let (ux, uy) = (sin(radians), cos(radians))
        let along = rings[0].map { spot -> Double in
            let p = frame.xy(spot)
            return p.x * ux + p.y * uy
        }
        let (from, to) = (along.min()! - marginM, along.max()! + marginM)
        return (frame.spot(from * ux, from * uy), frame.spot(to * ux, to * uy))
    }

    /// `count` evenly spaced spots from a to b, and how far along each is.
    public static func spots(from a: Spot, to b: Spot, count: Int) -> [(spot: Spot, distanceM: Double)] {
        let frame = Frame(a)
        let end = frame.xy(b)
        let length = hypot(end.x, end.y)
        return (0..<count).map { i in
            let t = count == 1 ? 0 : Double(i) / Double(count - 1)
            return (frame.spot(end.x * t, end.y * t), length * t)
        }
    }

    public struct SectionSpot: Equatable, Sendable {
        public var distanceM: Double
        public var spot: Spot
        public var before: Double?
        public var beforeIsSea: Bool
        public var now: Double?
        public init(distanceM: Double, spot: Spot, before: Double?, beforeIsSea: Bool = false, now: Double?) {
            self.distanceM = distanceM
            self.spot = spot
            self.before = before
            self.beforeIsSea = beforeIsSea
            self.now = now
        }
        /// How far the ground moved here, metres.
        public var changeM: Double? {
            guard let before, let now else { return nil }
            return now - before
        }
    }

    public struct ScarpSuggestion: Equatable, Sendable {
        public let heightM: Double
        public let spot: Spot
        /// As it goes in the field: "27.7".
        public var feetText: String { String(format: "%.1f", heightM * feetPerMetre) }
    }

    /// Drops smaller than this are within what two elevation models disagree by anyway.
    static let minimumScarpM = 0.3

    /// A suggestion for the main scarp height: the largest drop from the ground before
    /// to the ground now in the upper third of the outline, down a section running top
    /// to bottom. Only a suggestion, for someone to check in the field.
    public static func scarpSuggestion(_ rings: [[Spot]], section: [SectionSpot]) -> ScarpSuggestion? {
        let frame = Frame(centroid(rings[0]))
        let xyRings = rings.map { $0.map(frame.xy) }
        let inside = section.filter { inRings(frame.xy($0.spot), xyRings) }
        guard inside.count >= 3 else { return nil }
        var best: ScarpSuggestion?
        for spot in inside.prefix(Int((Double(inside.count) / 3).rounded(.up))) {
            guard let before = spot.before, let now = spot.now, !spot.beforeIsSea else { continue }
            let drop = before - now
            if drop >= minimumScarpM, drop > (best?.heightM ?? 0) { best = ScarpSuggestion(heightM: drop, spot: spot.spot) }
        }
        return best
    }
}
