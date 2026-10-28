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

    /// Any element whose label contains `text` (a LabeledContent reads as "Label, value").
    private func text(containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// Scrolls down until the element is on screen (lists load rows lazily).
    @discardableResult
    private func reveal(_ element: XCUIElement) -> XCUIElement {
        for _ in 0..<8 where !(element.exists && element.isHittable) { app.swipeUp() }
        return element
    }

    /// Replaces a text field's contents with `text`.
    private func replace(_ field: XCUIElement, with text: String) {
        tap(field)
        let current = (field.value as? String) ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count) + text)
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

    func testGisaBodyDistributionHighwayAndIncidentType() {
        launch()
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        tap(app.buttons["Body"])
        tap(app.buttons["Widening"])
        // The status choices wait for a cause.
        XCTAssertTrue(app.staticTexts["Enter the cause above to reveal the highway status options."].waitForExistence(timeout: 10))
        let cause = app.textFields["Cause Of Highway Status"]
        tap(cause)
        cause.typeText("Debris on the shoulder\n")
        tap(app.buttons["Lane(s) Closed"])
        tap(row("Lane(s) Closed Count"))
        tap(app.buttons["2"])
        snap("gisa-body-distribution-highway")
        app.swipeUp()
        tap(app.buttons["Washout"])
        tap(app.buttons["Slide"])
        snap("gisa-body-incident-type")
        tap(app.buttons["Save"])
        XCTAssertTrue(app.alerts["Saved"].waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()
        // After the reload the choices are still there.
        XCTAssertTrue(app.buttons["Washout"].isSelected)
        XCTAssertFalse(app.buttons["Slide"].isSelected)
    }

    func testGisaMaterial() {
        launch()
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        tap(app.buttons["Body"])
        let material = reveal(app.buttons["Landslide Debris"])

        // The demo record has soil with clay 40 and silt 60: one shared slider at 100.
        let sand = reveal(app.sliders["Sand Est %"])
        XCTAssertTrue(sand.exists)
        reveal(app.sliders["Clay/Silt Est %"]).adjust(toNormalizedSliderPosition: 0.5)
        reveal(sand).adjust(toNormalizedSliderPosition: 0.3)
        reveal(app.sliders["Boulder Est %"]).adjust(toNormalizedSliderPosition: 0.2)
        flip(reveal(app.switches["Rock Formation"]))
        tap(reveal(app.buttons["Joint"]))
        snap("gisa-material-slope")

        app.swipeDown()
        tap(reveal(app.buttons["Pavement"]))
        tap(app.buttons["Asphalt"])
        tap(material)
        reveal(app.sliders["Sand Est %"]).adjust(toNormalizedSliderPosition: 0.6)
        reveal(app.sliders["Boulder Est %"]).adjust(toNormalizedSliderPosition: 0.4)
        snap("gisa-material-debris")

        tap(app.buttons["Save"])
        XCTAssertTrue(app.alerts["Saved"].waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()
    }

    func testSectionPhotos() {
        launch()
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        tap(app.buttons["Body"])

        // The demo form has one photo filed under Material.
        let sample = reveal(app.buttons["Photo field-photo-sample.jpg"])
        snap("photos-material-section")
        tap(sample)
        let facing = text(containing: "Facing 135° (SE)")
        if !facing.waitForExistence(timeout: 10) { snap("photo-detail-missing") }
        XCTAssertTrue(facing.exists)
        snap("photo-detail")

        tap(app.buttons["Correct Location or Direction"])
        flip(app.switches["Correct the direction"])
        reveal(app.sliders["Direction"]).adjust(toNormalizedSliderPosition: 0.25)
        snap("photo-correction")
        tap(app.navigationBars["Correct Photo"].buttons["Save"])
        XCTAssertTrue(text(containing: "direction corrected by hand").waitForExistence(timeout: 10))
        snap("photo-detail-corrected")
        tap(app.buttons["Done"])

        // The simulator has no camera: the camera says so instead of failing.
        tap(reveal(app.buttons["Add Photo"]))
        tap(app.buttons["Take Photo"])
        XCTAssertTrue(text(containing: "This device has no rear camera").waitForExistence(timeout: 10))
        tap(app.buttons["Close"])

        // A library photo is filed under the section.
        tap(reveal(app.buttons["Add Photo"]))
        tap(app.buttons["Choose from Library"])
        // The system picker's grid is not exposed element by element: wait for
        // the picker, then tap its first photo by position.
        XCTAssertTrue(text(containing: "Private Access to Photos").waitForExistence(timeout: 15))
        snap("photos-library-picker")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.16, dy: 0.43)).tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Photo library-photo-'")).firstMatch
            .waitForExistence(timeout: 20))
        snap("photos-material-added")
    }

    func testCracksAreSeparateRecordsWithTheirOwnLabels() {
        launch()
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        tap(app.buttons["Body"])

        // The demo form has one crack, traced and labelled on its photo.
        let first = reveal(row("NB shoulder"))
        snap("cracks-list")
        tap(first)
        XCTAssertTrue(text(containing: "Length 12.5 ft").waitForExistence(timeout: 15))
        snap("crack-editor")

        replace(reveal(app.textFields["Depth (in)"]), with: "8")
        app.swipeDown()
        app.swipeDown()

        // Mark the opening with an arrow and a label that shows the width.
        tap(app.buttons["Draw on Photo"])
        let photo = text(containing: "Photo to draw on")
        XCTAssertTrue(photo.waitForExistence(timeout: 10))
        tap(app.buttons["Arrow"])
        photo.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.62))
            .press(forDuration: 0.1, thenDragTo: photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)))
        tap(app.buttons["Label"])
        photo.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.45)).tap()
        tap(row("Width (0.75 in)"))
        snap("crack-drawing")
        tap(app.navigationBars["Draw on Photo"].buttons["Done"])
        XCTAssertTrue(text(containing: "Width 0.75 in").waitForExistence(timeout: 10))
        tap(app.navigationBars["NB shoulder"].buttons["Save"])
        XCTAssertTrue(app.navigationBars["NB shoulder"].buttons["Save"].waitForNonExistence(timeout: 1) ||
                      !app.navigationBars["NB shoulder"].buttons["Save"].isEnabled)
        snap("crack-saved")
        app.navigationBars["NB shoulder"].buttons.element(boundBy: 0).tap()

        // A second crack is its own record with the same fields.
        tap(reveal(app.buttons["Add Crack"]))
        tap(app.buttons["Without a Photo"])
        replace(app.textFields["Length (ft)"], with: "4")
        tap(app.navigationBars["Crack 2"].buttons["Save"])
        app.navigationBars["Crack 2"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(text(containing: "4 ft long").waitForExistence(timeout: 10))
        XCTAssertTrue(text(containing: "8 in deep").exists)
        snap("cracks-two")
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
