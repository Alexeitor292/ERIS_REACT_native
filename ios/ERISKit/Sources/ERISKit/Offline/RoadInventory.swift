import Foundation

/// A stretch of state highway from the road inventory (HICOMP-derived).
public struct RoadSegment: Codable, Equatable, Sendable {
    public let id: Int
    public let districtCode: String?
    public let countyCode: String
    public let routeName: String
    public let beginPm: Double
    public let endPm: Double
    public let leftLanes: Int?
    public let rightLanes: Int?
    public let leftSurfaceType: String?
    public let rightSurfaceType: String?
    public let medianType: String?
    public let medianWidth: Double?
    public let terrainCode: String?
    public let designSpeed: Double?
    public let adt: Double?
    public let landmarkShortDesc: String?

    enum CodingKeys: String, CodingKey {
        case id, adt
        case districtCode = "district_code", countyCode = "county_code", routeName = "route_name", beginPm = "begin_pm"
        case endPm = "end_pm", leftLanes = "left_lanes", rightLanes = "right_lanes", leftSurfaceType = "left_surface_type"
        case rightSurfaceType = "right_surface_type", medianType = "median_type", medianWidth = "median_width"
        case terrainCode = "terrain_code", designSpeed = "design_speed", landmarkShortDesc = "landmark_short_desc"
    }

    public init(id: Int, districtCode: String?, countyCode: String, routeName: String, beginPm: Double, endPm: Double,
                leftLanes: Int? = nil, rightLanes: Int? = nil, leftSurfaceType: String? = nil, rightSurfaceType: String? = nil,
                medianType: String? = nil, medianWidth: Double? = nil, terrainCode: String? = nil, designSpeed: Double? = nil,
                adt: Double? = nil, landmarkShortDesc: String? = nil) {
        self.id = id
        self.districtCode = districtCode
        self.countyCode = countyCode
        self.routeName = routeName
        self.beginPm = beginPm
        self.endPm = endPm
        self.leftLanes = leftLanes
        self.rightLanes = rightLanes
        self.leftSurfaceType = leftSurfaceType
        self.rightSurfaceType = rightSurfaceType
        self.medianType = medianType
        self.medianWidth = medianWidth
        self.terrainCode = terrainCode
        self.designSpeed = designSpeed
        self.adt = adt
        self.landmarkShortDesc = landmarkShortDesc
    }

    /// "2 + 2 lanes · AC / AC · 45 mph", for the report screen.
    public var summary: String {
        var parts: [String] = []
        if leftLanes != nil || rightLanes != nil { parts.append("\(leftLanes ?? 0) + \(rightLanes ?? 0) lanes") }
        let surfaces = [leftSurfaceType, rightSurfaceType].compactMap { $0 }.filter { !$0.isEmpty }
        if !surfaces.isEmpty { parts.append(surfaces.joined(separator: " / ")) }
        if let speed = designSpeed { parts.append("\(Int(speed)) mph") }
        if let landmark = landmarkShortDesc, !landmark.isEmpty { parts.append(landmark) }
        return parts.joined(separator: " · ")
    }
}

/// A Caltrans SHN postmile reference point (tenth-mile), with where it is.
public struct PostmilePoint: Codable, Equatable, Sendable {
    public let districtCode: String?
    public let countyCode: String
    public let routeName: String
    public let pmRouteId: String?
    public let pmPrefixCode: String?
    public let postmile: Double
    public let pmSuffixCode: String?
    public let alignCode: String?
    public let latitude: Double
    public let longitude: Double

    enum CodingKeys: String, CodingKey {
        case postmile, latitude, longitude
        case districtCode = "district_code", countyCode = "county_code", routeName = "route_name", pmRouteId = "pm_route_id"
        case pmPrefixCode = "pm_prefix_code", pmSuffixCode = "pm_suffix_code", alignCode = "align_code"
    }

    public init(districtCode: String?, countyCode: String, routeName: String, pmRouteId: String? = nil, pmPrefixCode: String? = nil,
                postmile: Double, pmSuffixCode: String? = nil, alignCode: String? = nil, latitude: Double, longitude: Double) {
        self.districtCode = districtCode
        self.countyCode = countyCode
        self.routeName = routeName
        self.pmRouteId = pmRouteId
        self.pmPrefixCode = pmPrefixCode
        self.postmile = postmile
        self.pmSuffixCode = pmSuffixCode
        self.alignCode = alignCode
        self.latitude = latitude
        self.longitude = longitude
    }
}

/// Where a coordinate is on the state highway, or where a post mile is.
public struct RoadFix: Equatable, Sendable {
    public enum Method: String, Sendable {
        case nearestReference = "NEAREST_REFERENCE", projectedReference = "PROJECTED_REFERENCE"
        case exactPostmile = "EXACT_POSTMILE", interpolatedPostmile = "INTERPOLATED_POSTMILE"
    }

    public let district: String?
    public let county: String
    /// Three digits, as the forms store it ("001").
    public let route: String
    public let postMile: String
    public let latitude: Double
    public let longitude: Double
    public let alignCode: String?
    public let method: Method
    public let distanceMeters: Double?
}

/// The road inventory and postmile reference kept on this iPhone, indexed for
/// lookups without a connection. Ported from mobile/src/services/roadInventoryOffline.ts.
public final class RoadReference: @unchecked Sendable {
    public let segments: [RoadSegment]
    public let points: [PostmilePoint]
    private let grid: [String: [PostmilePoint]]
    private let routes: [String: [PostmilePoint]]
    static let gridDegrees = 0.05

    public init(segments: [RoadSegment], points: [PostmilePoint]) {
        self.segments = segments
        self.points = points
        var grid: [String: [PostmilePoint]] = [:]
        var routes: [String: [PostmilePoint]] = [:]
        for point in points {
            grid[Self.gridKey(point.latitude, point.longitude), default: []].append(point)
            routes[Self.routeKey(point.countyCode, point.routeName), default: []].append(point)
        }
        self.grid = grid
        self.routes = routes.mapValues { $0.sorted { $0.postmile < $1.postmile } }
    }

    public var hasLocations: Bool { !points.isEmpty }

    // MARK: Segments

    /// The road segments covering a post mile, those in the district first, then the shortest.
    public func segments(county: String, route: String, postMile: Double, district: String? = nil) -> [RoadSegment] {
        let county = county.trimmingCharacters(in: .whitespaces).uppercased(), route = Self.normalizeRoute(route)
        let wanted = Self.normalizeDistrict(district)
        return segments.filter {
            $0.countyCode.uppercased() == county && Self.normalizeRoute($0.routeName) == route && $0.beginPm <= postMile && $0.endPm >= postMile
        }.sorted { a, b in
            let am = !wanted.isEmpty && Self.normalizeDistrict(a.districtCode) == wanted ? 0 : 1
            let bm = !wanted.isEmpty && Self.normalizeDistrict(b.districtCode) == wanted ? 0 : 1
            if am != bm { return am < bm }
            return (a.endPm - a.beginPm) < (b.endPm - b.beginPm)
        }
    }

    // MARK: Coordinates to post mile

    /// The nearest highway post mile, projected between reference points when
    /// it can be; nil when no highway is within `maxDistance`.
    public func locate(latitude lat: Double, longitude lon: Double, maxDistance: Double = 3000) -> RoadFix? {
        guard lat.isFinite, lon.isFinite, (-90...90).contains(lat), (-180...180).contains(lon), !points.isEmpty else { return nil }
        let nearby = nearbyPoints(lat, lon)
        let pool = nearby.isEmpty ? points : nearby
        var nearest: PostmilePoint?
        var nearestDistance = Double.infinity
        for point in pool {
            let distance = Self.distanceMeters(lat, lon, point.latitude, point.longitude)
            if distance < nearestDistance {
                nearest = point
                nearestDistance = distance
            }
        }
        guard let nearest, nearestDistance <= maxDistance else { return nil }
        let line = routes[Self.routeKey(nearest.countyCode, nearest.routeName)] ?? []
        if let projected = project(lat, lon, nearest: nearest, along: line) {
            return RoadFix(district: projected.anchor.districtCode, county: projected.anchor.countyCode,
                           route: Self.paddedRoute(projected.anchor.routeName),
                           postMile: Self.formatPostmile(projected.postmile, projected.anchor.pmPrefixCode, projected.anchor.pmSuffixCode),
                           latitude: lat, longitude: lon, alignCode: projected.anchor.alignCode, method: .projectedReference,
                           distanceMeters: projected.distance)
        }
        return RoadFix(district: nearest.districtCode, county: nearest.countyCode, route: Self.paddedRoute(nearest.routeName),
                       postMile: Self.formatPostmile(nearest.postmile, nearest.pmPrefixCode, nearest.pmSuffixCode),
                       latitude: lat, longitude: lon, alignCode: nearest.alignCode, method: .nearestReference,
                       distanceMeters: nearestDistance)
    }

    // MARK: Post mile to coordinates

    /// Where a post mile is: a reference point, between two, or the nearest within 0.12 mile.
    public func position(district: String?, county: String, route: String, postMile: String) -> RoadFix? {
        let county = county.trimmingCharacters(in: .whitespaces).uppercased()
        guard !county.isEmpty, let pm = Self.parsePostmile(postMile) else { return nil }
        var candidates = routes[Self.routeKey(county, route)] ?? []
        guard !candidates.isEmpty else { return nil }
        let wanted = Self.normalizeDistrict(district)
        if !wanted.isEmpty {
            let inDistrict = candidates.filter { Self.normalizeDistrict($0.districtCode) == wanted }
            if !inDistrict.isEmpty { candidates = inDistrict }
        }
        if !pm.prefix.isEmpty {
            candidates = candidates.filter { Self.code($0.pmPrefixCode) == pm.prefix }
        } else {
            let plain = candidates.filter { Self.code($0.pmPrefixCode).isEmpty }
            if !plain.isEmpty { candidates = plain }
        }
        if !pm.suffix.isEmpty { candidates = candidates.filter { Self.code($0.pmSuffixCode) == pm.suffix } }
        guard !candidates.isEmpty else { return nil }

        let exact = candidates.filter { abs($0.postmile - pm.value) <= 0.0005 }
        if !exact.isEmpty {
            let point = Self.midpoint(exact)
            return fix(point, pm.value, point.latitude, point.longitude, .exactPostmile)
        }
        if let between = interpolate(candidates, pm.value) {
            return fix(between.anchor, pm.value, between.latitude, between.longitude, .interpolatedPostmile)
        }
        guard let nearest = candidates.min(by: { abs($0.postmile - pm.value) < abs($1.postmile - pm.value) }),
              abs(nearest.postmile - pm.value) <= 0.12 else { return nil }
        return fix(nearest, pm.value, nearest.latitude, nearest.longitude, .nearestReference)
    }

    private func fix(_ anchor: PostmilePoint, _ value: Double, _ lat: Double, _ lon: Double, _ method: RoadFix.Method) -> RoadFix {
        RoadFix(district: anchor.districtCode, county: anchor.countyCode, route: Self.paddedRoute(anchor.routeName),
                postMile: Self.formatPostmile(value, anchor.pmPrefixCode, anchor.pmSuffixCode), latitude: lat, longitude: lon,
                alignCode: anchor.alignCode, method: method, distanceMeters: nil)
    }

    // MARK: Geometry

    private func nearbyPoints(_ lat: Double, _ lon: Double) -> [PostmilePoint] {
        let latCell = Int((lat / Self.gridDegrees).rounded(.down)), lonCell = Int((lon / Self.gridDegrees).rounded(.down))
        var out: [PostmilePoint] = []
        for dy in -1...1 {
            for dx in -1...1 { out += grid["\(latCell + dy):\(lonCell + dx)"] ?? [] }
        }
        return out
    }

    private func project(_ lat: Double, _ lon: Double, nearest: PostmilePoint,
                         along line: [PostmilePoint]) -> (postmile: Double, distance: Double, anchor: PostmilePoint)? {
        let compatible = line.filter { Self.sameReference(nearest, $0) && abs($0.postmile - nearest.postmile) <= 0.25 }
        guard compatible.count >= 2 else { return nil }
        var best: (postmile: Double, distance: Double, anchor: PostmilePoint)?
        for (a, b) in zip(compatible, compatible.dropFirst()) {
            let gap = b.postmile - a.postmile
            guard gap > 0, gap <= 0.25 else { continue }
            let (t, distance) = Self.projectPoint(lat, lon, a, b)
            if best == nil || distance < best!.distance { best = (a.postmile + gap * t, distance, a) }
        }
        return best
    }

    private func interpolate(_ candidates: [PostmilePoint], _ target: Double) -> (latitude: Double, longitude: Double, anchor: PostmilePoint)? {
        let sorted = candidates.sorted { $0.postmile < $1.postmile }
        var best: (latitude: Double, longitude: Double, anchor: PostmilePoint, gap: Double)?
        for (a, b) in zip(sorted, sorted.dropFirst()) where Self.sameReference(a, b) {
            guard target >= a.postmile, target <= b.postmile else { continue }
            let gap = b.postmile - a.postmile
            guard gap > 0, gap <= 0.25 else { continue }
            let t = (target - a.postmile) / gap
            let candidate = (a.latitude + (b.latitude - a.latitude) * t, a.longitude + (b.longitude - a.longitude) * t, a, gap)
            if best == nil || candidate.3 < best!.gap { best = candidate }
        }
        return best.map { ($0.latitude, $0.longitude, $0.anchor) }
    }

    static func projectPoint(_ lat: Double, _ lon: Double, _ a: PostmilePoint, _ b: PostmilePoint) -> (t: Double, distance: Double) {
        let latRef = (lat + a.latitude + b.latitude) / 3
        let perLat = 111_320.0, perLon = 111_320.0 * cos(latRef * .pi / 180)
        let px = lon * perLon, py = lat * perLat
        let ax = a.longitude * perLon, ay = a.latitude * perLat
        let abx = b.longitude * perLon - ax, aby = b.latitude * perLat - ay
        let denom = abx * abx + aby * aby
        if denom <= 0.0001 { return (0, hypot(px - ax, py - ay)) }
        let t = max(0, min(1, ((px - ax) * abx + (py - ay) * aby) / denom))
        return (t, hypot(px - (ax + abx * t), py - (ay + aby * t)))
    }

    static func distanceMeters(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
        let p1 = lat1 * .pi / 180, p2 = lat2 * .pi / 180
        let dp = (lat2 - lat1) * .pi / 180, dl = (lon2 - lon1) * .pi / 180
        let a = pow(sin(dp / 2), 2) + cos(p1) * cos(p2) * pow(sin(dl / 2), 2)
        return 2 * 6_371_000 * atan2(a.squareRoot(), (1 - a).squareRoot())
    }

    static func sameReference(_ a: PostmilePoint, _ b: PostmilePoint) -> Bool {
        a.countyCode == b.countyCode && normalizeRoute(a.routeName) == normalizeRoute(b.routeName)
            && normalizeDistrict(a.districtCode) == normalizeDistrict(b.districtCode)
            && code(a.pmPrefixCode) == code(b.pmPrefixCode) && code(a.pmSuffixCode) == code(b.pmSuffixCode)
            && (a.pmRouteId ?? "") == (b.pmRouteId ?? "") && (a.alignCode ?? "") == (b.alignCode ?? "")
    }

    /// Several points at one post mile (both carriageways): their middle, named after the centerline one.
    static func midpoint(_ points: [PostmilePoint]) -> PostmilePoint {
        guard points.count > 1 else { return points[0] }
        let preferred = points.min { alignRank($0.alignCode) < alignRank($1.alignCode) }!
        let lat = points.map(\.latitude).reduce(0, +) / Double(points.count)
        let lon = points.map(\.longitude).reduce(0, +) / Double(points.count)
        return PostmilePoint(districtCode: preferred.districtCode, countyCode: preferred.countyCode, routeName: preferred.routeName,
                             pmRouteId: preferred.pmRouteId, pmPrefixCode: preferred.pmPrefixCode, postmile: preferred.postmile,
                             pmSuffixCode: preferred.pmSuffixCode, alignCode: preferred.alignCode, latitude: lat, longitude: lon)
    }

    static func alignRank(_ value: String?) -> Int {
        let code = (value ?? "").trimmingCharacters(in: .whitespaces).uppercased()
        if code.isEmpty || code == "C" || code == "CL" { return 0 }
        if code.hasPrefix("R") { return 1 }
        if code.hasPrefix("L") { return 2 }
        return 3
    }

    // MARK: Text

    static func gridKey(_ lat: Double, _ lon: Double) -> String {
        "\(Int((lat / gridDegrees).rounded(.down))):\(Int((lon / gridDegrees).rounded(.down)))"
    }

    static func routeKey(_ county: String, _ route: String) -> String {
        "\(county.trimmingCharacters(in: .whitespaces).uppercased())|\(normalizeRoute(route))"
    }

    /// "SR 001" -> "1"; "880" stays.
    public static func normalizeRoute(_ route: String) -> String {
        var r = route.trimmingCharacters(in: .whitespaces)
        r = r.replacingOccurrences(of: #"^(US|SR|CA|HWY|HIGHWAY)\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
        if let match = r.range(of: #"^0+(\d+)$"#, options: .regularExpression), match == r.startIndex..<r.endIndex {
            r = String(r.drop { $0 == "0" })
        }
        return r
    }

    /// Three characters at least, as the Expo app pads it ("1" -> "001").
    static func paddedRoute(_ route: String) -> String {
        let normalized = normalizeRoute(route)
        return String(repeating: "0", count: max(0, 3 - normalized.count)) + normalized
    }

    static func normalizeDistrict(_ value: String?) -> String {
        let digits = (value ?? "").filter(\.isNumber)
        guard !digits.isEmpty else { return "" }
        let last = String(digits.suffix(2))
        return last.count == 1 ? "0" + last : last
    }

    static func code(_ value: String?) -> String { (value ?? "").trimmingCharacters(in: .whitespaces).uppercased() }

    /// "R12.3" -> prefix R, 12.3; "12.3L" -> suffix L.
    static func parsePostmile(_ value: String) -> (prefix: String, value: Double, suffix: String)? {
        let raw = value.filter { !$0.isWhitespace }.uppercased()
        guard let match = raw.range(of: #"^[A-Z]?-?\d+(\.\d+)?[A-Z]?$"#, options: .regularExpression), match.lowerBound == raw.startIndex else {
            return nil
        }
        let prefix = raw.first.map { $0.isLetter ? String($0) : "" } ?? ""
        let suffix = raw.count > prefix.count && raw.last!.isLetter ? String(raw.last!) : ""
        let number = raw.dropFirst(prefix.count).dropLast(suffix.count)
        guard let parsed = Double(number), parsed.isFinite else { return nil }
        return (prefix, parsed, suffix)
    }

    static func formatPostmile(_ value: Double, _ prefix: String?, _ suffix: String?) -> String {
        "\(code(prefix))\(String(format: "%.2f", (value * 100).rounded() / 100))\(code(suffix))"
    }
}
