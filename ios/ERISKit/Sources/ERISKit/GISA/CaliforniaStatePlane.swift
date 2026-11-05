import Foundation

/// CCS83 (California Coordinate System of 1983) zones 1–6 in US survey feet,
/// for the GISA location's northing and easting. Ported from
/// mobile/src/utils/californiaCoordinateSystem.ts; constants from the Caltrans
/// LS-LSIT Unit 11 reference.
public enum CaliforniaStatePlane {
    public struct Point: Equatable, Sendable {
        public let countyCode: String
        public let zone: Int
        public let northing: Double
        public let easting: Double
    }

    public struct LatLon: Equatable, Sendable {
        public let countyCode: String
        public let zone: Int
        public let latitude: Double
        public let longitude: Double
    }

    struct Zone {
        let bo, lo, sinBo, rb, ro, nb, no, eo, l1, l2, l3, l4: Double
    }

    static let zoneByCounty: [String: Int] = [
        "DN": 1, "SIS": 1, "MOD": 1, "HUM": 1, "TRI": 1, "SHA": 1, "LAS": 1, "TEH": 1, "PLU": 1,
        "MEN": 2, "GLE": 2, "BUT": 2, "SIE": 2, "LAK": 2, "COL": 2, "YUB": 2, "NEV": 2, "SUT": 2, "PLA": 2,
        "SON": 2, "NAP": 2, "YOL": 2, "SOL": 2, "SAC": 2, "ED": 2, "AMA": 2, "ALP": 2,
        "MRN": 3, "CC": 3, "SJ": 3, "CAL": 3, "TUO": 3, "ALA": 3, "SF": 3, "SM": 3, "SCR": 3, "SCL": 3,
        "STA": 3, "MER": 3, "MPA": 3, "MAD": 3, "MNO": 3,
        "FRE": 4, "SBT": 4, "MON": 4, "KIN": 4, "TUL": 4, "INY": 4,
        "SLO": 5, "KER": 5, "SB": 5, "VEN": 5, "LA": 5, "SBD": 5,
        "ORA": 6, "RIV": 6, "SD": 6, "IMP": 6,
    ]

    static let zones: [Int: Zone] = [
        1: Zone(bo: 40.8351061249, lo: 122.0, sinBo: 0.6538843054, rb: 24791796.351, ro: 24244708.924, nb: 1640416.667, no: 2187504.093, eo: 6561666.667, l1: 364300.5191, l2: 31.6772, l3: 18.4872, l4: 0.0698),
        2: Zone(bo: 39.0846839219, lo: 122.0, sinBo: 0.630468335285, rb: 26311590.85, ro: 25795162.985, nb: 1640416.667, no: 2156844.531, eo: 6561666.667, l1: 364197.5131, l2: 31.3198, l3: 18.4998, l4: 0.065577),
        3: Zone(bo: 37.7510694363, lo: 120.5, sinBo: 0.612232038295, rb: 27512330.711, ro: 27056804.05, nb: 1640416.667, no: 2095943.327, eo: 6561666.667, l1: 364119.7127, l2: 30.9692, l3: 18.5086, l4: 0.062493),
        4: Zone(bo: 36.6258593071, lo: 119.0, sinBo: 0.59658714988, rb: 28652263.494, ro: 28181724.783, nb: 1640416.667, no: 2110955.377, eo: 6561666.667, l1: 364054.6183, l2: 30.6211, l3: 18.5174, l4: 0.060308),
        5: Zone(bo: 34.7510553142, lo: 118.0, sinBo: 0.570011896174, rb: 30648744.932, ro: 30193453.753, nb: 1640416.667, no: 2095707.846, eo: 6561666.667, l1: 363934.259, l2: 29.9356, l3: 18.5303, l4: 0.057234),
        6: Zone(bo: 33.3339229447, lo: 116.25, sinBo: 0.549517575763, rb: 32270577.813, ro: 31845868.317, nb: 1640416.667, no: 2065126.163, eo: 6561666.667, l1: 363861.895, l2: 29.3368, l3: 18.5396, l4: 0.053054),
    ]

    public static func zone(forCounty county: String?) -> Int? {
        CaltransCounties.code(county).flatMap { zoneByCounty[$0] }
    }

    public static func northingEasting(latitude: Double, longitude: Double, county: String?) -> Point? {
        guard latitude.isFinite, longitude.isFinite, let code = CaltransCounties.code(county),
              let number = zoneByCounty[code], let zone = zones[number] else { return nil }
        let westLongitude = longitude < 0 ? -longitude : longitude
        let deltaLatitude = latitude - zone.bo
        let u = deltaLatitude * (zone.l1 + deltaLatitude * (zone.l2 + deltaLatitude * (zone.l3 + zone.l4 * deltaLatitude)))
        let mappingRadius = zone.ro - u
        let convergence = (zone.lo - westLongitude) * zone.sinBo * .pi / 180
        return Point(countyCode: code, zone: number,
                     northing: zone.rb + zone.nb - mappingRadius * cos(convergence),
                     easting: zone.eo + mappingRadius * sin(convergence))
    }

    public static func latLon(northing: Double, easting: Double, county: String?) -> LatLon? {
        guard northing.isFinite, easting.isFinite, let code = CaltransCounties.code(county),
              let number = zoneByCounty[code], let zone = zones[number] else { return nil }
        let northingOffset = zone.rb + zone.nb - northing
        let eastingOffset = easting - zone.eo
        let mappingRadius = (northingOffset * northingOffset + eastingOffset * eastingOffset).squareRoot()
        let convergenceDegrees = atan2(eastingOffset, northingOffset) * 180 / .pi
        let westLongitude = zone.lo - convergenceDegrees / zone.sinBo
        let latitude = zone.bo + solveDeltaLatitude(zone, u: zone.ro - mappingRadius)
        let longitude = -westLongitude
        guard latitude.isFinite, longitude.isFinite else { return nil }
        return LatLon(countyCode: code, zone: number, latitude: latitude, longitude: longitude)
    }

    /// Feet to three decimals; "" when not a number.
    public static func format(_ feet: Double) -> String {
        feet.isFinite ? String(format: "%.3f", feet) : ""
    }

    /// Newton's method on the zone's latitude series.
    static func solveDeltaLatitude(_ zone: Zone, u: Double) -> Double {
        var delta = u / zone.l1
        for _ in 0..<8 {
            let d2 = delta * delta, d3 = d2 * delta, d4 = d3 * delta
            let value = zone.l1 * delta + zone.l2 * d2 + zone.l3 * d3 + zone.l4 * d4 - u
            if abs(value) < 1e-12 { break }
            let derivative = zone.l1 + 2 * zone.l2 * delta + 3 * zone.l3 * d2 + 4 * zone.l4 * d3
            if !derivative.isFinite || abs(derivative) < 1e-12 { break }
            delta -= value / derivative
        }
        return delta
    }
}
