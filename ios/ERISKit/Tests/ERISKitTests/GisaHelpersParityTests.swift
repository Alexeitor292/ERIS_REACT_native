import XCTest
@testable import ERISKit

/// Checks the Swift ports against Fixtures/gisa-helpers.json, written from the
/// Expo app's precision.ts, caltransLookups.ts and californiaCoordinateSystem.ts
/// by ios/scripts/make-parity-fixtures.mjs.
final class GisaHelpersParityTests: XCTestCase {
    struct Fixture: Decodable {
        struct Pair: Decodable { let input: String; let output: String? }
        struct County: Decodable { let input: String; let code: String?; let district: String?; let label: String }
        struct StatePlane: Decodable {
            let latitude, longitude: Double
            let county: String
            let zone: Int
            let northing, easting: Double
            let formattedNorthing: String
            let backLatitude, backLongitude: Double
        }
        let postMile, route, coordinate: [Pair]
        let county: [County]
        let routesForSF: [String]
        let districts: [String]
        let countyCount: Int
        let statePlane: [StatePlane]
    }

    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "gisa-helpers", withExtension: "json",
                                                  subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testPostMilesMatchTheExpoApp() throws {
        for pair in try fixture().postMile {
            XCTAssertEqual(GisaPrecision.postMileValue(pair.input), pair.output, "post mile \(pair.input)")
        }
    }

    func testRoutesMatchTheExpoApp() throws {
        for pair in try fixture().route {
            XCTAssertEqual(GisaPrecision.routeValue(pair.input), pair.output, "route \(pair.input)")
        }
    }

    func testCoordinatesMatchTheExpoApp() throws {
        for pair in try fixture().coordinate {
            XCTAssertEqual(GisaPrecision.formatCoordinate(pair.input), pair.output ?? "", "coordinate \(pair.input)")
        }
    }

    func testCountiesAndDistrictsMatchTheExpoApp() throws {
        let fixture = try fixture()
        for county in fixture.county {
            XCTAssertEqual(CaltransCounties.code(county.input), county.code, county.input)
            XCTAssertEqual(CaltransCounties.district(forCounty: county.input), county.district, county.input)
            XCTAssertEqual(CaltransCounties.county(county.input)?.displayLabel ?? "", county.label, county.input)
        }
        XCTAssertEqual(CaltransCounties.routes(forCounty: "SF"), fixture.routesForSF)
        XCTAssertEqual(CaltransCounties.districts, fixture.districts)
        XCTAssertEqual(CaltransCounties.all.count, fixture.countyCount)
    }

    func testStatePlaneMatchesTheExpoApp() throws {
        for point in try fixture().statePlane {
            let converted = try XCTUnwrap(CaliforniaStatePlane.northingEasting(latitude: point.latitude,
                                                                               longitude: point.longitude,
                                                                               county: point.county))
            XCTAssertEqual(converted.zone, point.zone, point.county)
            XCTAssertEqual(converted.northing, point.northing, accuracy: 1e-6, point.county)
            XCTAssertEqual(converted.easting, point.easting, accuracy: 1e-6, point.county)
            XCTAssertEqual(CaliforniaStatePlane.format(converted.northing), point.formattedNorthing)
            let back = try XCTUnwrap(CaliforniaStatePlane.latLon(northing: point.northing, easting: point.easting,
                                                                 county: point.county))
            XCTAssertEqual(back.latitude, point.backLatitude, accuracy: 1e-10, point.county)
            XCTAssertEqual(back.longitude, point.backLongitude, accuracy: 1e-10, point.county)
        }
        XCTAssertNil(CaliforniaStatePlane.northingEasting(latitude: 37, longitude: -122, county: "Nowhere"))
        XCTAssertEqual(CaliforniaStatePlane.format(.nan), "")
    }
}
