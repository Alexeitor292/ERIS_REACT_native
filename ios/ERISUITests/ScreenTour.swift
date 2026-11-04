import XCTest

/// Walks the app in demo mode (sample data, no sign-in) and saves a screenshot
/// of each screen. The screenshots are kept in the test results; set
/// `TEST_RUNNER_ERIS_SCREENSHOT_DIR` when running `xcodebuild test` to also
/// write them as PNG files to that folder.
final class ScreenTour: XCTestCase {
    private var app: XCUIApplication!
    /// The demo form sits outside any assessment (`-ERISDemoLegacyForm`).
    private var formIsOnItsOwn = false

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ERISDemo", "YES"]
    }

    private func launch(roles: String = "ADMIN", colleague: Bool = false, legacyForm: Bool = false) {
        formIsOnItsOwn = legacyForm
        app.launchArguments += ["-ERISDemoRoles", roles]
        if colleague { app.launchArguments += ["-ERISDemoColleague", "YES"] }
        if legacyForm { app.launchArguments += ["-ERISDemoLegacyForm", "YES"] }
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

    /// There is no list of forms: the demo form opens from its assessment in My
    /// Work, or from My Work itself when it is on no assessment.
    private func openForm(file: StaticString = #filePath, line: UInt = #line) {
        tap(app.tabBars.buttons["My Work"], file: file, line: line)
        if formIsOnItsOwn {
            tap(reveal(app.staticTexts["I-880 slope failure GISA"]), file: file, line: line)
        } else {
            tap(reveal(app.staticTexts["Assessment #5"]), file: file, line: line)
            tap(reveal(formLink), file: file, line: line)
        }
    }

    /// Two steps, on purpose: the button, then the question it asks.
    private func submitForReview(file: StaticString = #filePath, line: UInt = #line) {
        tap(reveal(app.buttons["Submit for review"]), file: file, line: line)
        XCTAssertTrue(text(containing: "Make sure the form is finished").waitForExistence(timeout: 10), file: file, line: line)
        tap(app.sheets.buttons["Submit"].exists ? app.sheets.buttons["Submit"] : app.buttons["Submit"], file: file, line: line)
    }

    private var formLink: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open technical form")).firstMatch
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
        tap(app.tabBars.buttons["My Work"])
        XCTAssertTrue(app.staticTexts["Assessment #3"].waitForExistence(timeout: 10))
        snap("assessments-list")

        // Office chief: choose a branch chief, then confirm.
        tap(app.staticTexts["Assessment #3"])
        tap(person("M. Okafor"))
        snap("assessment-delegate-chosen")
        tap(app.buttons["Delegate to M. Okafor"])
        XCTAssertTrue(app.staticTexts["Pending Staff assignment"].waitForExistence(timeout: 10))

        // Branch chief: the Staff of their branch, and nobody else.
        XCTAssertTrue(person("A. Rivera").waitForExistence(timeout: 10))
        XCTAssertFalse(person("B. Nakamura").exists, "another branch")
        snap("assessment-assign-staff")
        tap(person("Demo User"))
        tap(app.buttons["Assign Demo User"])
        XCTAssertTrue(app.staticTexts["Draft"].waitForExistence(timeout: 10))

        // Assignee submits; the reviewer approves.
        submitForReview()
        tap(app.buttons["Approve"])
        XCTAssertTrue(app.staticTexts["Approved"].waitForExistence(timeout: 10))
        app.swipeUp()
        snap("assessment-approved-timeline")
    }

    func testAnOfficeChiefRoutesToABranchChiefOrASeniorSpecialist() {
        launch(roles: "OFFICE_CHIEF")
        tap(app.staticTexts["Assessment #3"])
        XCTAssertTrue(person("M. Okafor").waitForExistence(timeout: 10), "a branch chief")
        tap(reveal(person("S. Morales")))
        snap("assessment-assign-senior-specialist")
        XCTAssertTrue(app.buttons["Assign S. Morales"].isEnabled)
        tap(app.buttons["Assign S. Morales"])
        XCTAssertTrue(app.staticTexts["Draft"].waitForExistence(timeout: 10))
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
        openForm()
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
        openForm()
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
        XCTAssertTrue(revealAbove(app.buttons["Washout"]).isSelected)
        XCTAssertFalse(app.buttons["Slide"].isSelected)
    }

    func testGisaMaterial() {
        launch()
        openForm()
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
        openForm()
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
        openForm()
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
        openForm()
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

    private func use(_ identifier: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: identifier).firstMatch }

    func testMeasurementsAreTypedIn() {
        launch()
        openForm()
        tap(app.buttons["Body"])
        XCTAssertTrue(reveal(text(containing: "not been reviewed by land surveyors")).exists)

        // The sketch opens large, to read its symbols in the field.
        tap(reveal(use("measurement-sketch")))
        XCTAssertTrue(app.navigationBars["Landslide Sketch"].waitForExistence(timeout: 5))
        snap("measurements-sketch")
        tap(app.navigationBars["Landslide Sketch"].buttons["Done"])

        XCTAssertFalse(text(containing: "Road inventory").exists, "the road geometry is gone")
        XCTAssertFalse(app.buttons["Fetch Elevation Profile"].exists)
        XCTAssertFalse(use("measurement-diagram").exists)

        // Next moves through the values with the keyboard up.
        let height = reveal(app.textFields["measure_slope_height_ft"])
        tap(height)
        height.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + "1117")
        snap("measurements-typing")
        tap(app.buttons["Next"])
        let original = app.textFields["measure_original_slope_deg"]
        original.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + "33.5")
        XCTAssertEqual(original.value as? String, "33.5")
        tap(app.buttons["Next"])
        let width = app.textFields["measure_landslide_width_ft"]
        width.typeText("45")
        XCTAssertEqual(width.value as? String, "45")
        tap(app.buttons["Done"].firstMatch)
        XCTAssertTrue(reveal(text(containing: "Measure on site")).exists)
        snap("measurements-fields")

        // With no area drawn, the way to measure is the map.
        tap(reveal(app.buttons["Go to the Map"]))
        XCTAssertTrue(reveal(use("site-areas-map")).waitForExistence(timeout: 10))

        tap(app.navigationBars.buttons["Save"])
        XCTAssertTrue(app.alerts["Saved"].waitForExistence(timeout: 10))
    }

    func testMeasurementsFitAtTheLargestText() {
        app.launchArguments += ["-appTextSize", "6", "-appTextBold", "YES"]
        launch()
        openForm()
        tap(app.buttons["Body"])
        let original = app.textFields["measure_original_slope_deg"]
        for _ in 0..<40 where !original.exists { app.swipeUp() }
        XCTAssertTrue(reveal(original).exists)
        snap("measurements-large-text")
    }

    func testASlopeIsMeasuredFromTheTerrainAndDroneSurveys() {
        app.launchArguments += ["-ERISDemoMeasuredArea", "YES"]
        launch()
        openForm()
        tap(app.buttons["Body"])
        let measure = reveal(use("measure-site"))
        XCTAssertTrue(reveal(use("measure-now")).exists)
        snap("measuring-before")
        tap(measure)

        // Before and now, each from its own ground, and how far the ground moved.
        XCTAssertTrue(use("measure-use-all").waitForExistence(timeout: 30), "no suggestions")
        snap("measuring-suggestions")
        XCTAssertTrue(reveal(text(containing: "Before and Now")).exists)
        XCTAssertTrue(reveal(use("profile-chart")).exists)
        XCTAssertTrue(reveal(use("displacement-chart")).exists)
        snap("measuring-profile")

        // Together they fill five values, never the scarp: that one is left for someone to review.
        tap(revealAbove(use("measure-use-all")))
        XCTAssertEqual(revealAbove(app.textFields["measure_main_scarp_height_ft"]).value as? String ?? "", "")
        XCTAssertTrue(text(containing: "Please review it on site").exists)
        snap("measuring-scarp-review")
        XCTAssertFalse((revealAbove(app.textFields["measure_slope_height_ft"]).value as? String ?? "").isEmpty)
        tap(reveal(use("use-measure_main_scarp_height_ft")))
        XCTAssertFalse((reveal(app.textFields["measure_main_scarp_height_ft"]).value as? String ?? "").isEmpty)
        XCTAssertTrue(text(containing: "Please review it on site").exists, "still marked after it is used")
    }

    func testAFieldAColleagueAlsoChangedIsChosenNotOverwritten() {
        launch(colleague: true)
        openForm()
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
        openForm()
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
        openForm()
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

    func testASketchIsDrawnSavedAndPlacedInSketchNotes() {
        launch()
        openForm()
        tap(app.buttons["Assess"])
        tap(reveal(app.buttons["add-photo-sketchpad"]))
        tap(app.buttons["Draw a Sketch"])
        let canvas = app.descendants(matching: .any)["sketch-canvas"]
        XCTAssertTrue(canvas.waitForExistence(timeout: 10))
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.3))
            .press(forDuration: 0.1, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
        snap("sketch-drawn")
        tap(app.navigationBars["Sketch"].buttons["Save"])
        let sketch = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Photo gisa-sketch'")).firstMatch
        XCTAssertTrue(sketch.waitForExistence(timeout: 15))

        // The sketch as a figure in Sketch notes.
        tap(reveal(app.buttons["memo-sketchpad_notes"]))
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
        tap(app.buttons["Figures"])
        tap(app.buttons["Insert a photo as a figure"])
        tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'gisa-sketch'")).firstMatch)
        let caption = app.textFields["What the photo shows"]
        tap(caption)
        caption.typeText("Site sketch")
        tap(app.navigationBars["Insert figure"].buttons["Insert"])
        XCTAssertTrue(app.webViews.firstMatch.images["Site sketch"].waitForExistence(timeout: 10))
        snap("sketch-figure")
        let number = app.webViews.firstMatch.staticTexts.matching(NSPredicate(format: "label CONTAINS '4.1'")).firstMatch
        XCTAssertTrue(number.exists, "Sketch notes number their figures 4.x")
    }

    /// A text field or, for one that grows with its text, a text view.
    private func field(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND (elementType == %d OR elementType == %d)",
                                                             label, XCUIElement.ElementType.textField.rawValue,
                                                             XCUIElement.ElementType.textView.rawValue)).firstMatch
    }

    private func openDemoForm(step: String) {
        openForm()
        tap(app.segmentedControls.buttons[step])
    }

    private func dismissAlert(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
        if !app.alerts[title].waitForExistence(timeout: 10) { snap("missing-alert-\(title)") }
        XCTAssertTrue(app.alerts[title].exists, "no \(title) alert; alerts: \(app.alerts.allElementsBoundByIndex.map(\.label))",
                      file: file, line: line)
        app.alerts[title].buttons["OK"].tap()
    }

    func testActionsAreChosenAndTheCoordinatorNotified() {
        launch()
        openDemoForm(step: "Actions")
        tap(app.buttons["actions-immediate"])
        tap(app.buttons["Open highway traffic"])
        tap(app.buttons["Remove landslide debris"])
        snap("actions-immediate-picker")
        tap(app.navigationBars["Immediate Actions"].buttons["Done"])
        XCTAssertTrue(text(containing: "Open highway traffic, Remove landslide debris").waitForExistence(timeout: 5))
        replace(reveal(field("Open Highway Traffic Lanes")), with: "1")

        let message = reveal(field("Description"))
        tap(message)
        message.typeText("Rocks on the northbound lane.")
        snap("immediate-actions-deliver")
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "t")], timeout: 1)
        XCTAssertGreaterThan(app.keyboards.count, 0)
        app.buttons["Deliver Now"].tap()
        dismissAlert("Delivered")
        // The notice stays on the form, so it is not sent twice by mistake.
        XCTAssertTrue(reveal(text(containing: "Rocks on the northbound lane.")).exists)
        XCTAssertEqual(field("Description").value as? String ?? "", "")
        snap("actions-coordinator-notified")

        tap(reveal(app.buttons["actions-follow-up"]))
        tap(app.buttons["Routine visual monitor"])
        tap(app.navigationBars["Follow-up Actions"].buttons["Done"])
        tap(app.navigationBars.buttons["Save"])
        dismissAlert("Saved")
        XCTAssertTrue(reveal(text(containing: "Routine visual monitor")).exists)
    }

    func testTheReviewChecklistLeadsToWhatIsMissing() {
        launch()
        openForm()
        tap(row("District *"))
        tap(app.buttons["District 07"])
        tap(app.segmentedControls.buttons["Gallery"])
        let location = reveal(app.buttons["requirement-location"])
        XCTAssertTrue(location.label.contains("Missing: County, Route."), location.label)
        XCTAssertTrue(app.buttons["requirement-photo"].label.contains("At least one photo"))
        snap("review-checklist")
        tap(location)
        XCTAssertTrue(app.staticTexts["GISA Header"].waitForExistence(timeout: 5))
    }

    func testAFormOfAnAssessmentIsSentForReviewWithIt() {
        launch()
        openDemoForm(step: "Gallery")
        XCTAssertFalse(app.buttons["Submit for Review"].exists, "the server sends it with its assessment")
        tap(reveal(app.buttons["Save and Open Assessment #5"]))
        XCTAssertTrue(app.navigationBars["Assessment #5"].waitForExistence(timeout: 10))
        submitForReview()
        XCTAssertTrue(app.buttons["Approve"].waitForExistence(timeout: 10), "now in review")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        // The form went with it: no longer editable, and reviewed on the assessment.
        XCTAssertTrue(revealAbove(app.buttons["Review it on Assessment #5"]).waitForExistence(timeout: 10))
        XCTAssertTrue(text(containing: "Awaiting branch chief review").exists)
        XCTAssertFalse(app.navigationBars.buttons["Save"].exists)
        snap("review-on-the-assessment")
    }

    func testALegacyFormIsSubmittedReturnedAndResubmitted() {
        launch(legacyForm: true)
        openDemoForm(step: "Gallery")
        let comment = reveal(field("Comment (optional)"))
        tap(comment)
        comment.typeText("Ready.")
        tap(reveal(app.buttons["Submit for Review"]))
        tap(app.sheets.buttons["Submit"].exists ? app.sheets.buttons["Submit"] : app.buttons["Submit"])
        dismissAlert("Submitted")

        // An administrator decides a form with no assessment on the form itself.
        let review = revealAbove(field("Review Comment"))
        tap(review)
        review.typeText("Check the post mile.")
        snap("review-decision")
        tap(app.buttons["Return for Correction"])
        tap(app.sheets.buttons["Return for Correction"].exists ? app.sheets.buttons["Return for Correction"]
            : app.buttons.matching(identifier: "Return for Correction").element(boundBy: 1))
        dismissAlert("Updated")
        XCTAssertTrue(revealAbove(text(containing: "Returned for correction: Check the post mile.")).exists)
        XCTAssertTrue(app.navigationBars.buttons["Save"].exists, "a returned form can be edited again")
        XCTAssertTrue(reveal(app.buttons["Resubmit for Review"]).exists)
        snap("review-returned")
    }

    func testTheGalleryHoldsEveryFileAndAddsNewOnes() {
        launch()
        openDemoForm(step: "Gallery")
        XCTAssertTrue(reveal(text(containing: "2 items · 1 photo · 1 document")).waitForExistence(timeout: 10))
        snap("gallery-library")

        // A document opens in Quick Look.
        tap(reveal(app.buttons["file-802"]))
        XCTAssertTrue(text(containing: "survey-plan").waitForExistence(timeout: 15))
        // Quick Look's PDF view (it has a search button) and its close button.
        XCTAssertTrue(app.buttons["QLPDFItemViewControllerBarSearchRightButtonAccessibilityIdentifier"].waitForExistence(timeout: 10))
        let close = app.buttons["QLOverlayDoneButtonAccessibilityIdentifier"]
        XCTAssertTrue(close.exists)
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "the page draws")], timeout: 3)
        snap("gallery-document-preview")
        close.tap()

        tap(app.segmentedControls.buttons["Docs 1"])
        XCTAssertFalse(app.buttons["file-801"].exists, "the photo is filtered out")
        XCTAssertTrue(text(containing: "survey-plan.pdf").exists)
        tap(app.segmentedControls.buttons["All 2"])

        // Photos and videos come from the library, several at a time.
        tap(reveal(app.buttons["add-file"]))
        tap(app.buttons["Photo or Video Library"])
        XCTAssertTrue(text(containing: "Private Access to Photos").waitForExistence(timeout: 15))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.16, dy: 0.43)).tap()
        snap("gallery-library-picker")
        let add = app.buttons["Add"]
        if add.waitForExistence(timeout: 5) { add.tap() }
        XCTAssertTrue(reveal(text(containing: "3 items · 2 photos · 1 document")).waitForExistence(timeout: 20))
        snap("gallery-added")
    }

    private func tabNames() -> [String] {
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
        return app.tabBars.buttons.allElementsBoundByIndex.map(\.label)
    }

    private func notice(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    /// The badge itself is not visible to UI tests: see the two screenshots.
    func testUnreadNoticesAreHighlightedAndTheBadgeGoesAtZero() {
        launch()
        let tab = app.tabBars.buttons["Notifications"]
        tap(tab)
        XCTAssertTrue(notice("New incident reported on I-880").waitForExistence(timeout: 10))
        snap("notifications-unread")
        XCTAssertFalse(notice("New incident reported on I-880").label.contains("T16:40"), "a readable date, not the server's text")
        XCTAssertEqual(notice("New incident reported on I-880").value as? String, "Unread")
        XCTAssertEqual(notice("Assessment #3 is waiting").value as? String, "Unread")
        XCTAssertNotEqual(notice("New incident reported on SR-17").value as? String, "Unread")
        // Never opened, but somebody took the step: the server does not count it.
        XCTAssertNotEqual(notice("Assessment #2 was waiting").value as? String, "Unread")

        tap(app.buttons["Mark all read"])
        let noneUnread = NSPredicate(format: "value != %@", "Unread")
        expectation(for: noneUnread, evaluatedWith: notice("New incident reported on I-880"))
        waitForExpectations(timeout: 10)
        XCTAssertFalse(app.buttons["Mark all read"].exists)
        snap("notifications-all-read")
    }

    func testThereIsNoFormsTabAndASharedFormWaitsInMyWork() {
        app.launchArguments += ["-ERISDemoSharedForm", "YES"]
        launch(roles: "MAINTENANCE_CREW")
        XCTAssertTrue(app.tabBars.buttons["My Work"].waitForExistence(timeout: 20), "crew have My Work once a form is shared")
        XCTAssertEqual(tabNames(), ["My Work", "Report", "Notifications", "Account"])
        tap(app.tabBars.buttons["My Work"])
        XCTAssertTrue(app.staticTexts["Shared with you"].waitForExistence(timeout: 10))
        XCTAssertTrue(text(containing: "Shared by Maria Garcia").exists)
        snap("mywork-shared-form")
        tap(app.staticTexts["I-880 slope failure GISA"])
        XCTAssertTrue(app.staticTexts["GISA Header"].waitForExistence(timeout: 10))
    }

    func testAPromotionShowsUpWithoutRestarting() {
        app.launchArguments += ["-ERISDemoRolesLater", "BRANCH_CHIEF"]
        launch(roles: "STAFF")
        tap(app.tabBars.buttons["My Work"])
        XCTAssertTrue(text(containing: "Sharing · Form #501").waitForExistence(timeout: 30), "a chief's queue, without restarting")
        snap("mywork-after-promotion")
    }

    func testSomeoneNoLongerPlacedLeavesTheApp() {
        app.launchArguments += ["-ERISDemoRoles", "STAFF", "-ERISDemoRolesLater", "GUEST"]
        app.launch()
        XCTAssertTrue(text(containing: "ERIS Mobile is for people placed").waitForExistence(timeout: 30))
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        snap("signed-out-no-place")
    }

    func testAGuestIsToldTheAppIsNotForThem() {
        app.launchArguments += ["-ERISDemoRoles", "GUEST"]
        app.launch()
        XCTAssertTrue(text(containing: "ERIS Mobile is for people placed").waitForExistence(timeout: 20))
        XCTAssertFalse(app.tabBars.firstMatch.exists)
    }

    func testSomeoneActsForAColleagueAwayAndGoesBack() {
        app.launchArguments += ["-ERISDemoActing", "YES"]
        launch(roles: "STAFF")
        XCTAssertFalse(app.staticTexts["acting-banner"].exists)
        tap(app.tabBars.buttons["Account"])
        tap(reveal(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Act for Jordan Chen")).firstMatch))
        XCTAssertTrue(app.staticTexts["acting-banner"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["acting-banner"].label, "Acting for Jordan Chen")
        tap(app.tabBars.buttons["My Work"])
        XCTAssertTrue(text(containing: "Sharing · Form #501").waitForExistence(timeout: 30), "the chief's queue")
        snap("acting-for-someone")
        tap(app.buttons["Back to my work"])
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: app.staticTexts["acting-banner"])
        waitForExpectations(timeout: 15)
    }

    func testSettingWhoActsWhileAway() {
        launch(roles: "BRANCH_CHIEF")
        tap(app.tabBars.buttons["Account"])
        tap(reveal(app.buttons["Set who acts for me"]))
        XCTAssertFalse(app.buttons["set-out-of-office"].isEnabled, "nobody chosen yet")
        tap(app.buttons["delegate-picker"])
        tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "M. Okafor")).firstMatch)
        XCTAssertTrue(app.buttons["set-out-of-office"].isEnabled)
        snap("out-of-office")
        tap(app.buttons["set-out-of-office"])
        XCTAssertTrue(text(containing: "They have been told").waitForExistence(timeout: 10))
        XCTAssertTrue(reveal(app.buttons["End Now"]).exists)
        snap("out-of-office-set")
        tap(app.buttons["End Now"])
        XCTAssertTrue(reveal(app.staticTexts["Cancelled"]).waitForExistence(timeout: 10))
    }

    func testAChiefMovesWorkLeftBySomeoneWhoMovedOn() {
        app.launchArguments += ["-ERISDemoWorkLeft", "YES"]
        launch(roles: "OFFICE_CHIEF")
        tap(app.tabBars.buttons["My Work"])
        XCTAssertTrue(text(containing: "left by someone who moved on").waitForExistence(timeout: 30))
        snap("move-work-row")
        tap(app.buttons["move-work"])
        tap(reveal(text(containing: "Lee Former · Branch chief · has moved on")))
        XCTAssertTrue(person("M. Okafor").waitForExistence(timeout: 10))
        XCTAssertFalse(reveal(app.buttons["move-confirm"]).isEnabled, "nobody chosen yet")
        tap(revealAbove(person("M. Okafor")))
        XCTAssertTrue(reveal(app.buttons["move-confirm"]).isEnabled)
        snap("move-work-chosen")
        tap(app.buttons["move-confirm"])
        XCTAssertTrue(text(containing: "Their work stayed with them").waitForExistence(timeout: 15))
    }

    /// Only that it gets out of the way: XCTest gets control after the animation has
    /// played, so seeing it takes a screen recording of a launch.
    func testTheOpeningAnimationLeavesTheAppReady() {
        app.launchArguments += ["-ERISDemoSplash", "YES", "-ERISDemoRoles", "STAFF"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["My Work"].waitForExistence(timeout: 10))
        tap(app.tabBars.buttons["Account"])
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 10))
    }

    func testTheLargestTextStillFitsTheScreens() {
        app.launchArguments += ["-appTextSize", "6", "-appTextBold", "YES"]
        launch(roles: "BRANCH_CHIEF")
        tap(app.tabBars.buttons["My Work"])
        XCTAssertTrue(app.staticTexts["My Work"].waitForExistence(timeout: 10))
        snap("large-text-my-work")
        tap(app.tabBars.buttons["Notifications"])
        snap("large-text-notifications")
        tap(app.tabBars.buttons["Account"])
        snap("large-text-account")
    }

    func testTextSizeIsChosenOnAccount() {
        launch(roles: "STAFF")
        tap(app.tabBars.buttons["Account"])
        let same = reveal(app.switches["text-same-as-iphone"])
        XCTAssertEqual(same.value as? String, "1")
        flip(same)
        XCTAssertTrue(reveal(app.sliders["text-size"]).exists)
        snap("text-size-setting")
        flip(reveal(app.switches["text-same-as-iphone"]))
        XCTAssertFalse(app.sliders["text-size"].exists)
    }

    func testADeliveryMadeWithNoConnectionWaitsAndGoes() {
        launch()
        openDemoForm(step: "Actions")
        tap(app.buttons["actions-immediate"])
        tap(app.buttons["Open highway traffic"])
        tap(app.navigationBars["Immediate Actions"].buttons["Done"])
        setConnection(false)
        let message = reveal(field("Description"))
        tap(message)
        message.typeText("Rocks on the northbound lane.")
        // With the keyboard still up: nobody should have to put it away first.
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "t")], timeout: 1)
        XCTAssertGreaterThan(app.keyboards.count, 0)
        snap("deliver-with-keyboard")
        app.buttons["Deliver Now"].tap()
        dismissAlert("Kept on This iPhone")
        let waiting = text(containing: "Waiting to send")
        XCTAssertTrue(reveal(waiting).exists)
        snap("delivery-waiting")
        setConnection(true)
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: waiting)
        waitForExpectations(timeout: 60)
    }

    /// The demo stands in for the camera: the files it makes take the real path,
    /// and its server refuses anything but a JPEG and a browser-ready MP4.
    func testAReportTakesPhotosAndVideosFromTheCameraOrLibrary() {
        launch(roles: "MAINTENANCE_CREW")
        tap(app.tabBars.buttons["Report"])
        tap(app.buttons["Report an Incident"])
        tap(reveal(app.buttons["Take Photo"]))
        XCTAssertTrue(reveal(app.staticTexts["Photo 1"]).waitForExistence(timeout: 10))
        tap(reveal(app.buttons["Record Video"]))
        XCTAssertTrue(reveal(app.staticTexts["Video 1"]).waitForExistence(timeout: 30))
        tap(reveal(app.buttons["Take Photo"]))
        XCTAssertTrue(reveal(app.staticTexts["Photo 2"]).waitForExistence(timeout: 10))
        XCTAssertTrue(reveal(app.buttons["Photo or Video Library"]).exists)
        snap("report-photos-and-videos")

        tap(reveal(app.buttons["Remove Photo 1"]))
        XCTAssertFalse(app.staticTexts["Photo 2"].waitForExistence(timeout: 1))

        // Nothing is lost to a stray Cancel.
        tap(app.navigationBars.buttons["Cancel"])
        XCTAssertTrue(app.buttons["Discard"].waitForExistence(timeout: 5))
        snap("report-discard-asks")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).tap()

        for (label, value) in [("Latitude", "37.73"), ("Longitude", "-122.19"), ("District", "4"),
                               ("County", "ALA"), ("Route", "880"), ("Post mile", "12.3")] {
            replace(revealAbove(app.textFields[label]), with: value)
        }
        tap(app.navigationBars.buttons["Submit"])
        XCTAssertTrue(text(containing: "Report filed.").waitForExistence(timeout: 20), "not filed: \(app.staticTexts.allElementsBoundByIndex.map(\.label).suffix(6))")
    }

    func testAHandOffStartsOnTheDistrictsContact() {
        launch()
        tap(app.staticTexts["Triage · Report #14"])
        XCTAssertTrue(text(containing: "Rocks up to 0.5 m").waitForExistence(timeout: 10))
        tap(reveal(row("Assessment required")))
        XCTAssertTrue(reveal(text(containing: "Ana Ruiz")).waitForExistence(timeout: 10), "the district's default")
        snap("triage-district-contact")
    }

    func testTheThemeIsChosenOnAccountAndKept() {
        launch()
        tap(app.tabBars.buttons["Account"])
        let system = app.segmentedControls.buttons["System"]
        let dark = app.segmentedControls.buttons["Dark"]
        tap(dark)
        XCTAssertTrue(dark.isSelected)
        snap("theme-dark-account")
        tap(app.tabBars.buttons["Notifications"])
        XCTAssertTrue(notice("New incident reported on I-880").waitForExistence(timeout: 10))
        snap("theme-dark-notifications")

        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["Demo data: not connected to ERIS"].waitForExistence(timeout: 10))
        snap("theme-dark-after-relaunch")
        tap(app.tabBars.buttons["Account"])
        XCTAssertTrue(dark.waitForExistence(timeout: 10))
        XCTAssertTrue(dark.isSelected, "kept across launches")

        tap(system)
        XCTAssertTrue(system.isSelected)
        snap("theme-back-to-system")
    }

    func testAnAdministratorWorksTheWholeQueueAndChoosesASide() {
        launch()
        XCTAssertEqual(tabNames(), ["My Work", "Report", "Notifications", "Account"])
        XCTAssertTrue(app.staticTexts["Triage · Report #14"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Assessment #3"].exists)
        snap("mywork-admin")
        tap(app.segmentedControls.buttons["Geotechnical"])
        XCTAssertFalse(app.staticTexts["Triage · Report #14"].exists)
        XCTAssertFalse(app.staticTexts["Maintenance · Report #20"].exists)
        XCTAssertTrue(app.staticTexts["Assessment #3"].exists)
        tap(app.segmentedControls.buttons["Maintenance"])
        XCTAssertTrue(app.staticTexts["Maintenance · Report #20"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Assessment #3"].exists)
        snap("mywork-maintenance-only")
        tap(app.segmentedControls.buttons["Both"])
    }

    func testACoordinatorTriagesAReportIntoAnIncidentGroup() {
        launch()
        tap(app.staticTexts["Triage · Report #14"])
        XCTAssertTrue(text(containing: "Rocks up to 0.5 m").waitForExistence(timeout: 10))
        tap(reveal(row("Assessment required")))
        tap(reveal(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'I-880 slides, October storm'")).firstMatch))
        snap("triage-decision")
        tap(reveal(app.buttons["Accept and open assessment"]))
        XCTAssertTrue(text(containing: "Report #14 accepted. Assessment #9 is open").waitForExistence(timeout: 10))
        // The queue reloads just after the notice appears.
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.staticTexts["Triage · Report #14"])
        waitForExpectations(timeout: 15)
        XCTAssertTrue(reveal(app.staticTexts["Assessment #9"]).exists, "and its assessment waits to be routed")
    }

    func testAMaintenanceReviewerCompletesTheirStep() {
        launch()
        tap(reveal(app.staticTexts["Maintenance · Report #20"]))
        XCTAssertTrue(text(containing: "Current step: Supervisor review").waitForExistence(timeout: 10))
        tap(reveal(row("Complete review and continue")))
        let notes = reveal(app.descendants(matching: .any)["review-notes"])
        tap(notes)
        notes.typeText("Inlet cleared, water still ponding.")
        snap("maintenance-review")
        tap(reveal(app.buttons["Record Action"]))
        XCTAssertTrue(text(containing: "Your action was recorded.").waitForExistence(timeout: 10))
        tap(reveal(app.staticTexts["Maintenance · Report #20"]))
        XCTAssertTrue(text(containing: "Current step: District decision").waitForExistence(timeout: 10))
    }

    func testABranchChiefApprovesAShare() {
        launch()
        tap(reveal(app.staticTexts["Sharing · Form #501"]))
        XCTAssertTrue(text(containing: "Demo User is sharing").waitForExistence(timeout: 10))
        snap("share-review")
        tap(reveal(app.buttons["Approve"]))
        XCTAssertTrue(text(containing: "takes effect once everyone else with a say approves").waitForExistence(timeout: 10))
    }

    func testAReporterHasReportingAndNothingElse() {
        launch(roles: "MAINTENANCE_CREW")
        XCTAssertEqual(tabNames(), ["Report", "Notifications", "Account"])
        XCTAssertTrue(app.buttons["Report an Incident"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Settlement at the bridge approach"].waitForExistence(timeout: 10), "their own report")
        XCTAssertFalse(app.staticTexts["Rockfall on SR-1"].exists, "not anyone else's")
        snap("report-tab")
    }

    func testADistrictReporterAnswersTheReviewer() {
        app.launchArguments += ["-ERISDemoDuties", "YES"]
        launch(roles: "GUEST")
        XCTAssertEqual(tabNames(), ["My Work", "Report", "Notifications", "Account"])
        tap(app.staticTexts["Maintenance · Report #22"])
        tap(reveal(row("Supply information and return for review")))
        let notes = reveal(app.descendants(matching: .any)["review-notes"])
        tap(notes)
        notes.typeText("Photo of the inlet added.")
        tap(reveal(app.buttons["Record Action"]))
        XCTAssertTrue(text(containing: "Your action was recorded.").waitForExistence(timeout: 10))
    }

    func testChiefsHaveTheirQueueOnly() {
        launch(roles: "OFFICE_CHIEF")
        XCTAssertEqual(tabNames(), ["My Work", "Notifications", "Account"])
        XCTAssertTrue(app.staticTexts["Assessment #3"].waitForExistence(timeout: 10))
    }

    private func setConnection(_ connected: Bool) {
        tap(app.tabBars.buttons["Account"])
        let toggle = reveal(app.switches["demo-offline"])
        let wanted = connected ? "0" : "1"
        for _ in 0..<3 where (toggle.value as? String) != wanted {
            flip(toggle)
            if (toggle.value as? String) != wanted, toggle.switches.firstMatch.exists { toggle.switches.firstMatch.tap() }
        }
        XCTAssertEqual(toggle.value as? String, wanted, "the demo connection switch")
        tap(app.tabBars.buttons["My Work"])
    }

    func testAFormWorksOfflineAndIsSentWhenTheConnectionReturns() {
        launch()
        openDemoForm(step: "Header")
        setConnection(false)

        // Saved with no connection: kept on this iPhone.
        replace(reveal(app.textFields["EA"]), with: "04-OFF1")
        tap(app.navigationBars.buttons["Save"])
        dismissAlert("Saved on This iPhone")

        // A photo taken offline waits on the iPhone too.
        tap(revealAbove(app.segmentedControls.buttons["Gallery"]))
        tap(reveal(app.buttons["add-file"]))
        tap(app.buttons["Photo or Video Library"])
        XCTAssertTrue(text(containing: "Private Access to Photos").waitForExistence(timeout: 15))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.16, dy: 0.43)).tap()
        let add = app.buttons["Add"]
        if add.waitForExistence(timeout: 5) { add.tap() }
        dismissAlert("Kept on This iPhone")
        XCTAssertTrue(reveal(text(containing: "kept on this iPhone")).exists)
        snap("offline-gallery-waiting")

        // Its assessment says what is waiting; the form reopens from the kept copy, with the change.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(text(containing: "ERIS can't be reached").waitForExistence(timeout: 10))
        XCTAssertTrue(text(containing: "1 form with changes and 1 file waiting to send").exists)
        snap("offline-list")
        tap(reveal(formLink))
        XCTAssertTrue(text(containing: "Changes kept on this iPhone are shown").waitForExistence(timeout: 10))
        XCTAssertEqual(reveal(app.textFields["EA"]).value as? String, "04-OFF1")
        snap("offline-form")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Back online: everything is sent, and the form shows it saved.
        setConnection(true)
        let waiting = text(containing: "waiting to send")
        let sent = NSPredicate(format: "exists == false")
        expectation(for: sent, evaluatedWith: waiting)
        waitForExpectations(timeout: 30)
        tap(reveal(formLink))
        XCTAssertEqual(reveal(app.textFields["EA"]).value as? String, "04-OFF1")
        XCTAssertFalse(text(containing: "Changes kept on this iPhone").exists)
        tap(revealAbove(app.segmentedControls.buttons["Gallery"]))
        XCTAssertTrue(reveal(text(containing: "3 items · 2 photos · 1 document")).waitForExistence(timeout: 10))
        snap("offline-sent")
    }

    func testAStagingBuildSignsInWithTheERISPasswordWhenTheServerAllowsIt() {
        app.launchArguments += ["-ERISDemoSignedOut", "YES", "-ERISDemoRoles", "STAFF"]
        app.launch()
        let email = app.textFields["ERIS email"], password = app.secureTextFields["Password"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["sign-in-build"].exists, "a staging build says so")
        tap(email)
        email.typeText("Demo@dot.ca.gov")
        tap(password)
        password.typeText("wrong")
        tap(app.buttons["sign-in-password"])
        XCTAssertTrue(text(containing: "did not sign in").waitForExistence(timeout: 10))
        snap("sign-in-password-wrong")
        tap(password)
        password.typeText("demo-password")
        tap(app.buttons["sign-in-password"])
        XCTAssertTrue(app.staticTexts["Demo data: not connected to ERIS"].waitForExistence(timeout: 10))
        XCTAssertTrue(tabNames().contains("My Work"))
        snap("sign-in-password-signed-in")
    }

    func testAStagingBuildRunsTheMapsUnderDeveloperLicensing() {
        launch(roles: "STAFF")
        tap(app.tabBars.buttons["Account"])
        XCTAssertTrue(reveal(text(containing: "Staging")).waitForExistence(timeout: 10))
        let licensing = app.descendants(matching: .any)["maps-licensing"]
        XCTAssertTrue(reveal(licensing).exists)
        XCTAssertTrue(text(containing: "Developer licensing (staging build)").exists, "the server's license is not used")
        snap("account-maps-licensing")
    }

    func testAReportMadeOfflineIsFiledWhenTheConnectionReturns() {
        launch(roles: "MAINTENANCE_CREW")
        tap(app.tabBars.buttons["Account"])
        let toggle = reveal(app.switches["demo-offline"])
        flip(toggle)
        XCTAssertEqual(toggle.value as? String, "1")
        tap(app.tabBars.buttons["Report"])
        tap(app.buttons["Report an Incident"])
        for (label, value) in [("Title (optional)", "Rocks on SR-84"), ("Latitude", "37.6"), ("Longitude", "-121.9"),
                               ("District", "04"), ("County", "ALA"), ("Route", "84"), ("Post mile", "5.2")] {
            let field = reveal(app.textFields[label])
            tap(field)
            field.typeText(value)
        }
        tap(app.navigationBars.buttons["Submit"])
        XCTAssertTrue(text(containing: "The report is kept on this iPhone").waitForExistence(timeout: 15))
        XCTAssertTrue(text(containing: "Rocks on SR-84").exists)
        XCTAssertTrue(text(containing: "1 report waiting to send").exists)
        snap("report-kept-offline")

        tap(app.tabBars.buttons["Account"])
        flip(reveal(app.switches["demo-offline"]))
        tap(app.tabBars.buttons["Report"])
        let waiting = text(containing: "1 report waiting to send")
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: waiting)
        waitForExpectations(timeout: 30)
        XCTAssertTrue(app.staticTexts["Rocks on SR-84"].waitForExistence(timeout: 10), "filed, and in my reports")
        snap("report-filed")
    }

    func testWorkAssignedWhileOfflineArrivesOnItsOwnReadyToWorkOffline() {
        app.launchArguments += ["-ERISDemoLateAssignment", "YES"]
        launch(roles: "STAFF")
        XCTAssertTrue(app.staticTexts["Assessment #5"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Assessment #8"].exists)

        // Offline, the office assigns Assessment #8. Back online, it arrives with nobody pulling to refresh.
        setConnection(false)
        setConnection(true)
        tap(app.tabBars.buttons["My Work"])
        XCTAssertTrue(app.staticTexts["Assessment #8"].waitForExistence(timeout: 20))
        snap("assigned-arrived")

        // Its form was kept: it opens, photos and all, with no connection.
        setConnection(false)
        tap(app.tabBars.buttons["My Work"])
        tap(app.staticTexts["Assessment #8"])
        XCTAssertTrue(text(containing: "ERIS can't be reached").waitForExistence(timeout: 10))
        tap(reveal(app.buttons["Open technical form #501"]))
        XCTAssertTrue(app.segmentedControls.buttons["Body"].waitForExistence(timeout: 10))
        tap(app.segmentedControls.buttons["Body"])
        XCTAssertTrue(reveal(app.buttons["Photo field-photo-sample.jpg"]).exists)
        snap("assigned-form-offline")
    }

    func testSiteAreasAreDrawnOnTheMap() {
        launch()
        openDemoForm(step: "Header")
        tap(reveal(app.buttons["site-areas-map"]))
        let status = app.staticTexts["site-area-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 20))
        XCTAssertEqual(status.label, "No areas drawn")
        tap(app.buttons["Add Area"])
        let map = app.otherElements.firstMatch
        for (x, y) in [(0.35, 0.40), (0.65, 0.40), (0.65, 0.60), (0.35, 0.60)] {
            app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
            _ = XCTWaiter.wait(for: [XCTestExpectation(description: "corner")], timeout: 0.6)
        }
        _ = map
        snap("site-area-drawing")
        tap(app.buttons["Done"])
        XCTAssertTrue(status.label.hasPrefix("1 area · "), status.label)
        // An area the size of a site, not a continent.
        let squareMetres = status.label.components(separatedBy: " · ")[1].replacingOccurrences(of: " m²", with: "")
            .replacingOccurrences(of: ",", with: "")
        XCTAssertLessThan(Double(squareMetres) ?? .infinity, 1_000_000, status.label)
        snap("site-area-drawn")
        tap(app.navigationBars["Site Areas"].buttons["Save"])
        XCTAssertTrue(text(containing: "Site areas: 1 area").waitForExistence(timeout: 10))
        tap(app.navigationBars.buttons["Save"])
        dismissAlert("Saved")
    }

    func testTheSitePhotoMapShowsWhereEachPhotoWasTaken() {
        launch()
        openDemoForm(step: "Header")
        tap(reveal(app.buttons["site-photo-map"]))
        let status = app.staticTexts["photo-map-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 20))
        let placed = NSPredicate(format: "label BEGINSWITH '1 photo on the map'")
        expectation(for: placed, evaluatedWith: status)
        waitForExpectations(timeout: 20)
        snap("site-photo-map")
        tap(app.navigationBars["Site Photo Map"].buttons["Done"])
    }

    func testTheSiteIsShownIn3DFromItsKeptTerrain() {
        launch()
        openDemoForm(step: "Body")
        let open = app.buttons["site-terrain-open"], get = app.buttons["site-terrain-get"]
        // The terrain comes with assigned work; for a form that isn't, it is asked for here.
        if !reveal(open).exists, reveal(get).exists { tap(get) }
        XCTAssertTrue(open.waitForExistence(timeout: 20))
        tap(reveal(open))
        let status = app.staticTexts["site-terrain-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 20))
        XCTAssertTrue(status.label.hasPrefix("81 × 81 elevation grid"), status.label)
        snap("site-terrain")
        app.sliders["Vertical exaggeration"].adjust(toNormalizedSliderPosition: 1)
        XCTAssertTrue(app.staticTexts["site-terrain-exaggeration"].label.contains("3"),
                      app.staticTexts["site-terrain-exaggeration"].label)
        snap("site-terrain-exaggerated")
        tap(app.navigationBars["Site in 3D"].buttons["Done"])
    }

    func testAPhotoCorrectedOfflineIsKeptAndSentWhenTheConnectionReturns() {
        launch()
        openDemoForm(step: "Body")
        // Opened once online, the photo is kept with its place on the photo map.
        tap(reveal(app.buttons["Photo field-photo-sample.jpg"]))
        XCTAssertTrue(text(containing: "Facing 135° (SE)").waitForExistence(timeout: 10))
        tap(app.buttons["Done"])

        setConnection(false)
        tap(reveal(app.buttons["Photo field-photo-sample.jpg"]))
        XCTAssertTrue(text(containing: "Facing 135° (SE)").waitForExistence(timeout: 10), "opens from what the iPhone kept")
        tap(app.buttons["Correct Location or Direction"])
        flip(app.switches["Correct the direction"])
        reveal(app.sliders["Direction"]).adjust(toNormalizedSliderPosition: 0.25)
        tap(app.navigationBars["Correct Photo"].buttons["Save"])
        XCTAssertTrue(app.staticTexts["correction-waiting"].waitForExistence(timeout: 10))
        XCTAssertTrue(text(containing: "direction corrected by hand").exists, "shown as made while it waits")
        snap("photo-correction-waiting")
        tap(app.buttons["Done"])

        setConnection(true)
        tap(reveal(app.buttons["Photo field-photo-sample.jpg"]))
        XCTAssertTrue(text(containing: "direction corrected by hand").waitForExistence(timeout: 10))
        let sent = NSPredicate(format: "exists == false")
        expectation(for: sent, evaluatedWith: app.staticTexts["correction-waiting"])
        waitForExpectations(timeout: 90)
        tap(app.buttons["Done"])
    }

    func testSubmittingForReviewAsksFirstAndTheFormIsTheMainAction() {
        launch(roles: "STAFF")
        tap(app.tabBars.buttons["My Work"])
        tap(reveal(app.staticTexts["Assessment #5"]))
        XCTAssertTrue(formLink.waitForExistence(timeout: 10))
        snap("assessment-form-first")
        tap(reveal(app.buttons["Submit for review"]))
        XCTAssertTrue(text(containing: "Make sure the form is finished").waitForExistence(timeout: 10))
        snap("assessment-submit-confirm")
        // Tapping away cancels: iOS shows this question as a popover.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(app.staticTexts["Draft"].waitForExistence(timeout: 10), "nothing was sent")
        XCTAssertFalse(app.buttons["Approve"].exists)
        submitForReview()
        XCTAssertFalse(app.staticTexts["Draft"].waitForExistence(timeout: 3), "sent")
    }

    func testStaffSeeOnlyTheirOwnStep() {
        launch(roles: "STAFF")
        XCTAssertEqual(tabNames(), ["My Work", "Notifications", "Account"])
        tap(app.tabBars.buttons["My Work"])
        tap(app.staticTexts["Assessment #5"])
        XCTAssertTrue(app.buttons["Submit for review"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Approve"].exists)
        snap("assessment-staff-draft")
    }
}
