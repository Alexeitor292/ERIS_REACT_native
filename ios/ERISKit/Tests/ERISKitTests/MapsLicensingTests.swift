import XCTest
@testable import ERISKit

final class MapsLicensingTests: XCTestCase {
    private func config(enabled: Bool = true, license: String?) throws -> ArcGISConfig {
        let value = license.map { "\"\($0)\"" } ?? "null"
        let body = #"{"runtime_enabled": \#(enabled), "api_key": "AAPK-test", "license_key": \#(value), "license_expires_at": null, "mmpk_url": null, "offline_ttl_hours": 72, "issued_at": "2026-10-28T12:00:00+00:00"}"#
        return try JSONDecoder().decode(ArcGISConfig.self, from: Data(body.utf8))
    }

    func testTheBuildSaysWhichDeploymentItIsForAndAnUnknownOneIsProduction() {
        XCTAssertEqual(Deployment("staging"), .staging)
        XCTAssertEqual(Deployment(" Staging "), .staging)
        XCTAssertEqual(Deployment("production"), .production)
        XCTAssertEqual(Deployment(nil), .production, "a build without the setting must be licensed, not quietly run as developer")
        XCTAssertEqual(Deployment("$(ERIS_DEPLOYMENT)"), .production)
    }

    func testStagingUsesDeveloperLicensingEvenWhenTheServerSendsALicense() throws {
        let plan = MapsLicensing(.staging, config: try config(license: "runtimelite,1000,rud0001,none,ABC"))
        XCTAssertEqual(plan, .developer)
        XCTAssertNil(plan.problem(nil))
        XCTAssertEqual(plan.summary(nil, level: nil), "Developer licensing (staging build)")
    }

    func testProductionAppliesTheServersLicenseAndIsQuietWhenTheSDKAcceptsIt() throws {
        let plan = MapsLicensing(.production, config: try config(license: #" runtimelite,1000,rud0001,none,ABC\n"#))
        XCTAssertEqual(plan, .license("runtimelite,1000,rud0001,none,ABC"))
        XCTAssertNil(plan.problem(.valid))
        XCTAssertEqual(plan.summary(.valid, level: "Lite"), "Licensed (Lite)")
    }

    func testProductionWithoutALicenseSaysSo() throws {
        for config in [try config(license: nil), try config(license: "  "), try config(enabled: false, license: "runtimelite,1000,x")] {
            let plan = MapsLicensing(.production, config: config)
            XCTAssertEqual(plan, .missing)
            XCTAssertEqual(plan.problem(nil), "Maps aren't licensed: this ERIS server sends no ArcGIS license. Tell the ERIS administrator.")
            XCTAssertEqual(plan.summary(nil, level: nil), "Not licensed")
        }
    }

    func testALicenseTheSDKRefusesOrThatExpiredIsReported() {
        let plan = MapsLicensing.license("runtimelite,1000,rud0001,none,OLD100")
        XCTAssertEqual(plan.problem(.invalid), "Maps aren't licensed: the ArcGIS license from ERIS isn't one for this app (it needs an ArcGIS Maps SDK 200.x license). Tell the ERIS administrator.")
        XCTAssertEqual(plan.problem(nil), plan.problem(.invalid), "a string the SDK cannot even read")
        XCTAssertEqual(plan.problem(.expired), "Maps aren't licensed: the ArcGIS license from ERIS has expired. Tell the ERIS administrator.")
        XCTAssertEqual(plan.summary(.expired, level: "Lite"), "Not licensed")
    }
}
