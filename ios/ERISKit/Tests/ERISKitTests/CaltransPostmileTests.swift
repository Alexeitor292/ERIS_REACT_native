import XCTest
@testable import ERISKit

final class CaltransPostmileTests: XCTestCase {
    func testTheQueryAsksForMarkersAroundThePoint() throws {
        let url = CaltransPostmile.queryURL(latitude: 38.5, longitude: -121.4)
        let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(url.path, "/arcgis/rest/services/CHhighway/SHN_Postmiles_Tenth/FeatureServer/0/query")
        XCTAssertEqual(values["geometry"], "-121.4,38.5")
        XCTAssertEqual(values["inSR"], "4326")
        XCTAssertEqual(values["distance"], "3000")
        XCTAssertEqual(values["units"], "esriSRUnit_Meter")
    }

    func testTheNearestMarkerWinsAndIsNormalized() {
        let response = """
        {"features": [
          {"attributes": {"District": 3, "County": "pla", "Route": 80, "PMPrefix": "", "PM": 12.3, "PMSuffix": ""},
           "geometry": {"x": -121.2, "y": 38.9}},
          {"attributes": {"District": 3, "County": "PLA", "Route": 80, "PMPrefix": "R", "PM": 12.346, "PMSuffix": "L"},
           "geometry": {"x": -121.2001, "y": 38.8001}},
          {"attributes": {"District": null, "County": "PLA", "Route": 80, "PM": 1},
           "geometry": {"x": -121.2, "y": 38.8}}
        ]}
        """
        let location = CaltransPostmile.nearest(in: Data(response.utf8), latitude: 38.8, longitude: -121.2)
        XCTAssertEqual(location?.district, "03")
        XCTAssertEqual(location?.county, "PLA")
        XCTAssertEqual(location?.route, "080")
        XCTAssertEqual(location?.postMile, "R12.35L")
        XCTAssertLessThan(location?.distanceMeters ?? .infinity, 20)
    }

    func testNoMarkersMeansNoLocation() {
        XCTAssertNil(CaltransPostmile.nearest(in: Data(#"{"features": []}"#.utf8), latitude: 0, longitude: 0))
        XCTAssertNil(CaltransPostmile.nearest(in: Data("not json".utf8), latitude: 0, longitude: 0))
    }

    func testNormalizersMatchTheExpoApp() {
        XCTAssertEqual(CaltransPostmile.normalizedRoute("I-5"), "005")
        XCTAssertEqual(CaltransPostmile.normalizedRoute(101), "101")
        XCTAssertEqual(CaltransPostmile.normalizedRoute("ABC"), "ABC")
        XCTAssertEqual(CaltransPostmile.twoDigitDistrict("4"), "04")
        XCTAssertEqual(CaltransPostmile.normalizedPostMile("7.125"), "7.13")
        XCTAssertNil(CaltransPostmile.normalizedPostMile("x"))
    }
}
