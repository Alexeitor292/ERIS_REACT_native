import XCTest

/// Walks the app in demo mode (sample data, no sign-in) and saves a screenshot
/// of each screen. The screenshots are kept in the test results; set
/// `TEST_RUNNER_ERIS_SCREENSHOT_DIR` when running `xcodebuild test` to also
/// write them as PNG files to that folder.
final class ScreenTour: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ERISDemo", "YES"]
    }

    private func launch(roles: String = "ADMIN") {
        app.launchArguments += ["-ERISDemoRoles", roles]
        app.launch()
        XCTAssertTrue(app.staticTexts["Demo data: not connected to ERIS"].waitForExistence(timeout: 10))
    }

    private func snap(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["ERIS_SCREENSHOT_DIR"], !dir.isEmpty {
            let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
            try? shot.pngRepresentation.write(to: url)
        }
    }

    private func tap(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: 10), "missing \(element)", file: file, line: line)
        element.tap()
    }

    /// A picker row: its label starts with the person's name and goes on
    /// with where they sit and what they carry.
    private func person(_ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    func testAssessmentHandOff() {
        launch()
        tap(app.tabBars.buttons["Assessments"])
        XCTAssertTrue(app.staticTexts["Assessment #3"].waitForExistence(timeout: 10))
        snap("assessments-list")

        // Office chief: choose a branch chief, then confirm.
        tap(app.staticTexts["Assessment #3"])
        tap(person("M. Okafor"))
        snap("assessment-delegate-chosen")
        tap(app.buttons["Delegate to M. Okafor"])
        XCTAssertTrue(app.staticTexts["Pending Staff assignment"].waitForExistence(timeout: 10))

        // Branch chief: someone from another branch needs a reason first.
        tap(person("B. Nakamura"))
        snap("assessment-assign-out-of-branch")
        XCTAssertFalse(app.buttons["Assign B. Nakamura"].isEnabled)
        tap(person("Demo User"))
        tap(app.buttons["Assign Demo User"])
        XCTAssertTrue(app.staticTexts["Draft"].waitForExistence(timeout: 10))

        // Assignee submits; the reviewer approves.
        tap(app.buttons["Submit for review"])
        tap(app.buttons["Approve"])
        XCTAssertTrue(app.staticTexts["Approved"].waitForExistence(timeout: 10))
        app.swipeUp()
        snap("assessment-approved-timeline")
    }

    /// A row whose label starts with `text` (a menu, picker or field row).
    private func row(_ text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
    }

    /// A switch turns on only when its knob end is tapped, not the row's label.
    private func flip(_ toggle: XCUIElement) {
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "missing \(toggle)")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    }

    func testGisaHeaderSavesOnlyWithItsLocation() {
        launch()
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        XCTAssertTrue(app.staticTexts["GISA Header"].waitForExistence(timeout: 10))
        snap("gisa-header")

        // A district without Alameda clears the county and route; saving is refused.
        tap(row("District *"))
        tap(app.buttons["District 07"])
        tap(app.buttons["Save"])
        XCTAssertTrue(app.alerts["Almost there"].waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()
        snap("gisa-header-missing")

        tap(row("District *"))
        tap(app.buttons["District 04"])
        tap(row("County *"))
        tap(app.buttons["Alameda (ALA)"])
        tap(row("Route"))
        tap(app.buttons["880"])
        tap(app.buttons["Save"])
        XCTAssertTrue(app.alerts["Saved"].waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()

        app.swipeUp()
        app.swipeUp()
        flip(app.switches["Show Northing/Easting"])
        flip(app.switches["Show Lat/Lon"])
        app.swipeUp()
        snap("gisa-location")
    }

    func testStaffSeeOnlyTheirOwnStep() {
        launch(roles: "STAFF")
        tap(app.tabBars.buttons["Assessments"])
        tap(app.buttons["Staff"])
        tap(app.staticTexts["Assessment #5"])
        XCTAssertTrue(app.buttons["Submit for review"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Approve"].exists)
        snap("assessment-staff-draft")
    }
}
