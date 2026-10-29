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

    private func launch(roles: String = "ADMIN", colleague: Bool = false) {
        app.launchArguments += ["-ERISDemoRoles", roles]
        if colleague { app.launchArguments += ["-ERISDemoColleague", "YES"] }
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

    /// Scrolls until the element is clear of the navigation bar and the
    /// floating tab bar (lists load rows lazily, and a row under the tab bar
    /// counts as hittable but its tap lands on the tab bar).
    @discardableResult
    private func reveal(_ element: XCUIElement) -> XCUIElement {
        for _ in 0..<12 {
            guard element.exists else { app.swipeUp(velocity: .slow); continue }
            let top = app.navigationBars.firstMatch.exists ? app.navigationBars.firstMatch.frame.maxY : 0
            let bottom = app.tabBars.firstMatch.exists ? app.tabBars.firstMatch.frame.minY : app.frame.maxY
            let frame = element.frame
            if frame.minY < top { app.swipeDown(velocity: .slow) }
            else if frame.maxY > bottom - 8 { app.swipeUp(velocity: .slow) }
            else if element.isHittable { break }
            else { app.swipeUp(velocity: .slow) }
        }
        return element
    }

    /// Replaces a text field's contents with `text`.
    private func replace(_ field: XCUIElement, with text: String) {
        tap(field)
        let current = (field.value as? String) ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count) + text)
        // Put the keyboard away with its Done button, as a person would.
        let done = app.toolbars.buttons["Done"]
        if done.exists { done.tap() } else if app.keyboards.count > 0 { app.buttons["Done"].firstMatch.tap() }
    }

    /// Scrolls up until the element is on screen.
    @discardableResult
    private func revealAbove(_ element: XCUIElement) -> XCUIElement {
        for _ in 0..<6 where !(element.exists && element.isHittable) { app.swipeDown() }
        return element
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
        tap(reveal(app.buttons["add-photo-material"]))
        tap(app.buttons["Take Photo"])
        XCTAssertTrue(text(containing: "This device has no rear camera").waitForExistence(timeout: 10))
        tap(app.buttons["Close"])

        // A library photo is filed under the section.
        tap(reveal(app.buttons["add-photo-material"]))
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

    func testVegetationAndWater() {
        launch()
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        tap(app.buttons["Body"])
        replace(reveal(app.textFields["Groundcover Coverage %"]), with: "45")
        tap(reveal(app.buttons["Surface Runoff"]))
        // Each checked while on screen: the list unloads rows scrolled away.
        tap(reveal(app.buttons["Adjacent Utilities impacted"]))
        XCTAssertTrue(app.buttons["Adjacent Utilities impacted"].isSelected)
        tap(reveal(app.buttons["Adjacent Properties may be impacted"]))
        XCTAssertTrue(app.buttons["Adjacent Properties may be impacted"].isSelected)
        tap(reveal(app.buttons["Flowing"]))
        tap(reveal(app.buttons["Seep"]))
        XCTAssertTrue(app.buttons["Seep"].isSelected)
        snap("gisa-vegetation-water")
        tap(app.buttons["Save"])
        XCTAssertTrue(app.alerts["Saved"].waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()
        XCTAssertTrue(reveal(app.buttons["Seep"]).isSelected, "still chosen after the reload")
    }

    func testMeasurements() {
        launch()
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        tap(app.buttons["Body"])
        XCTAssertTrue(reveal(text(containing: "Road inventory context active")).exists)
        // The diagram below makes the list long enough to scroll past it; come back up if so.
        let orientation = text(containing: "48° · auto-detected from map")
        if !reveal(orientation).isHittable { _ = revealAbove(orientation) }
        XCTAssertTrue(orientation.exists)
        snap("gisa-measurements-profile")

        // A manual bearing overrides detection.
        tap(reveal(app.buttons["Set road orientation manually"]))
        replace(reveal(app.textFields["Bearing (°)"]), with: "120")
        tap(reveal(app.buttons["Refresh Elevation Profile"]))
        XCTAssertTrue(app.buttons["Refresh Elevation Profile"].waitForExistence(timeout: 10))
        XCTAssertTrue(revealAbove(text(containing: "120° · manual override")).exists)
        snap("gisa-measurements-refreshed")

        replace(reveal(app.textFields["Landslide Width, ft (Wd)"]), with: "45")
        snap("gisa-measurements-fields")
        tap(app.buttons["Save"])
        XCTAssertTrue(app.alerts["Saved"].waitForExistence(timeout: 10))
    }

    func testCrossSectionDiagram() {
        launch()
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        tap(app.buttons["Body"])
        let diagram = app.descendants(matching: .any)["measurement-diagram"]
        XCTAssertTrue(reveal(diagram).exists)
        XCTAssertTrue(diagram.label.contains("Landslide Through Road"))
        snap("gisa-diagram-through")

        // A slide above the road, on both sides, with the ground rising on each.
        tap(reveal(app.segmentedControls.buttons["Above"]))
        tap(reveal(app.segmentedControls.buttons["Both"]))
        tap(reveal(app.segmentedControls.buttons["Crown"]))
        XCTAssertTrue(diagram.label.contains("Landslide Above Road"))
        _ = reveal(diagram)
        snap("gisa-diagram-above")

        tap(reveal(app.buttons["diagram-full-screen"]))
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2)
        snap("gisa-diagram-full-screen")
        tap(done)
        XCTAssertTrue(diagram.waitForExistence(timeout: 10))
    }

    func testAFieldAColleagueAlsoChangedIsChosenNotOverwritten() {
        launch(colleague: true)
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        XCTAssertTrue(text(containing: "Maria Garcia is also in this form").waitForExistence(timeout: 15))
        replace(reveal(app.textFields["Project ID"]), with: "555")
        tap(app.navigationBars.buttons["Save"])
        // Maria saved Project ID first: nothing is overwritten until this person chooses.
        let sheet = app.navigationBars["Changed by both"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10))
        XCTAssertTrue(text(containing: "EA 04-0B2 (from Maria)").exists)
        snap("collab-conflict")
        tap(app.buttons["project_id-mine"])
        tap(sheet.buttons["Save"])
        XCTAssertTrue(app.alerts["Saved"].waitForExistence(timeout: 10))
        app.alerts["Saved"].buttons["OK"].tap()
        XCTAssertEqual(reveal(app.textFields["Project ID"]).value as? String, "555")
    }

    func testAColleaguesSaveElsewhereIsKept() {
        launch(colleague: true)
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        replace(reveal(app.textFields["EA"]), with: "04-1A234")
        tap(app.navigationBars.buttons["Save"])
        XCTAssertTrue(app.alerts["Saved"].waitForExistence(timeout: 10))
        app.alerts["Saved"].buttons["OK"].tap()
        // Only EA was sent, so Maria's Project ID stands.
        XCTAssertEqual(reveal(app.textFields["Project ID"]).value as? String, "EA 04-0B2 (from Maria)")
        snap("collab-merged")
    }

    func testAWebMemoIsEditedWithNothingLost() {
        launch()
        tap(app.tabBars.buttons["Submissions"])
        tap(app.staticTexts["I-880 slope failure GISA"])
        tap(app.buttons["Assess"])
        let row = app.buttons["memo-observations_notes"]
        XCTAssertTrue(reveal(row).label.contains("Toe of the slope"))
        tap(row)
        // Written on the web: heading, list, table, figure with its photo, and a citation.
        let page = app.webViews.firstMatch
        XCTAssertTrue(page.staticTexts["Toe of the slope"].waitForExistence(timeout: 15))
        XCTAssertTrue(page.staticTexts["Scarp"].exists, "the table")
        XCTAssertTrue(page.images["Scarp above the shoulder"].waitForExistence(timeout: 10), "the figure's photo")
        snap("memo-opened")

        page.staticTexts["Debris on the right lane"].tap()
        app.typeText(" and shoulder")
        tap(app.buttons["Bold"])
        snap("memo-edited")
        tap(app.navigationBars.buttons["Save"])
        XCTAssertTrue(app.alerts["Saved"].waitForExistence(timeout: 10))
        app.alerts["Saved"].buttons["OK"].tap()

        // Saved and reloaded: the formatting is all still there.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(reveal(row).label.contains("and shoulder"))
        tap(row)
        XCTAssertTrue(page.staticTexts["Toe of the slope"].waitForExistence(timeout: 15))
        XCTAssertTrue(page.staticTexts["Scarp"].exists, "the table survived")
        XCTAssertTrue(page.images["Scarp above the shoulder"].exists, "the figure survived")
        XCTAssertTrue(page.staticTexts["Figure 1.1"].exists, "the citation survived")
        snap("memo-saved")
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
