import XCTest
@testable import ERISKit

/// The formatted memos. The first four mirror
/// web/src/features/submissions/memoContentModel.test.ts.
final class MemoContentTests: XCTestCase {
    func testPlainTextBecomesParagraphsAndLineBreaksEscaped() {
        XCTAssertEqual(MemoContent.html(fromPlain: "First line\nsecond <b>\n\nNext"), "<p>First line<br>second &lt;b&gt;</p><p>Next</p>")
        XCTAssertEqual(MemoContent.html(fromPlain: "   "), "")
        XCTAssertEqual(MemoContent.html(fromPlain: nil), "")
    }

    func testTheSignatureIgnoresBulletsNumbersPunctuationAndSpacing() {
        XCTAssertEqual(MemoContent.signature("Findings\n• Crack A\n2. Crack B"), MemoContent.signature("findings crack a, crack b"))
        XCTAssertNotEqual(MemoContent.signature("Crack A"), MemoContent.signature("Crack B"))
    }

    func testTheFormattedMemoWinsWhileItMatchesItsPlainMirror() {
        let html = "<h2>Findings</h2><ul><li>Crack A</li></ul>"
        XCTAssertEqual(MemoContent.choose(html: html, plain: "Findings\n• Crack A"), html)
    }

    func testAMirrorEditedElsewhereWinsOverAStaleFormattedMemo() {
        XCTAssertEqual(MemoContent.choose(html: "<p>Old text</p>", plain: "New text from the field"), "<p>New text from the field</p>")
        XCTAssertEqual(MemoContent.choose(html: nil, plain: "Wet toe"), "<p>Wet toe</p>")
        XCTAssertEqual(MemoContent.choose(html: nil, plain: nil), "")
    }

    func testEntitiesAreReadAsText() {
        XCTAssertEqual(MemoContent.text(ofHTML: "<p>Cut &amp; fill &lt;5&gt;</p>"), "Cut & fill <5>")
    }

    func testARowShowsTheMemosOpeningWords() {
        XCTAssertEqual(MemoContent.preview("<h2>Toe</h2><p>Wet<br>seep</p><figure data-figure=\"4\"><figcaption>Figure 1.1. Scarp</figcaption></figure>"),
                       "Toe Wet seep Figure 1.1. Scarp")
        XCTAssertEqual(MemoContent.preview("<p>abcdef</p>", limit: 3), "abc…")
        XCTAssertEqual(MemoContent.photoSection("observations_notes"), "observation")
    }

    // MARK: On the form

    private func form(_ gisa: [String: JSONValue]) -> GisaForm { GisaForm(server: gisa, incidentTypes: [], createdAt: nil) }

    func testTheDocumentIsSentAndItsPlainCopyIsLeftToTheServer() throws {
        let html = "<h2>Toe</h2><table><tbody><tr><td>wet</td></tr></tbody></table>"
        var memo = form(["observations_notes_html": .string(html), "observations_notes": .string("Toe\nwet")])
        XCTAssertEqual(memo["observations_notes_html"], html, "formatting, tables and all, as saved")
        memo["observations_notes_html"] = "<p>New</p>"
        let body = try memo.patchBody()
        XCTAssertEqual(body["observations_notes_html"], .string("<p>New</p>"))
        XCTAssertNil(body["observations_notes"], "the plain copy is the server's to write")
        memo["observations_notes_html"] = ""
        XCTAssertEqual(try memo.patchBody()["observations_notes_html"], .null)
    }

    func testAnUntouchedMemoIsNotSentEvenWhenItOpenedFromItsPlainCopy() throws {
        let detail = try JSONDecoder().decode(SubmissionDetail.self, from: Data("""
        {"submission": {"id": 501, "status": "DRAFT", "can_edit": true},
         "gisa": {"district": "04", "county": "ALA", "route": "880", "post_mile": "1", "latitude": 37.7, "longitude": -122.2,
                  "observations_notes_html": "<p>Old</p>", "observations_notes": "New from the field"}}
        """.utf8))
        var editor = GisaEditor(detail: detail)
        XCTAssertEqual(editor.form["observations_notes_html"], "<p>New from the field</p>")
        XCTAssertTrue(try editor.changes().isEmpty)
        editor.set("observations_notes_html", "<p><strong>New</strong> from the field</p>")
        XCTAssertEqual(try editor.changes().body, ["observations_notes_html": .string("<p><strong>New</strong> from the field</p>"),
                                                    "base": .object(["observations_notes_html": .string("<p>Old</p>")])])
    }
}

/// Record of incidents. Mirrors the site-history tests in
/// web/src/features/submissions/memoContentModel.test.ts.
final class SiteHistoryTests: XCTestCase {
    func testLabelsForTheSiteHistory() {
        XCTAssertEqual(SiteHistory.distance(12.4, sameLocation: false), "12 m away")
        XCTAssertEqual(SiteHistory.distance(1540, sameLocation: false), "1.5 km away")
        XCTAssertEqual(SiteHistory.distance(80, sameLocation: true), "Same location")
        XCTAssertEqual(SiteHistory.standing(stage: "RESOLVED", assessmentState: "APPROVED"), "Resolved")
        XCTAssertEqual(SiteHistory.standing(stage: "OFFICE_CHIEF_REVIEW", assessmentState: "PENDING_OFFICE_DELEGATION"),
                       "Awaiting office routing")
        XCTAssertEqual(SiteHistory.summarize([(.sameType, true), (.sameType, true), (.differentType, true)]),
                       .init(total: 3, recurrences: 2, differentType: 1, unclassified: 0, outsideRecord: 0))
        XCTAssertEqual(SiteHistory.summarize([(.sameType, true), (.unclassified, false)]),
                       .init(total: 2, recurrences: 1, differentType: 0, unclassified: 0, outsideRecord: 1))
    }

    private func maintenance(triage: String = "null", immediate: String = "[]") throws -> SiteHistory.Maintenance {
        try JSONDecoder().decode(SiteHistory.Maintenance.self, from: Data("""
        {"report": {"description": null, "reported_by": null, "reported_at": null}, "triage": \(triage),
         "immediate_actions": \(immediate), "follow_up_actions": [], "notes": [], "also_reported": []}
        """.utf8))
    }

    func testMaintenanceCountsAsARecordOnceItDidOrWroteSomethingBeyondTheReport() throws {
        XCTAssertFalse(try maintenance().hasRecord)
        XCTAssertFalse(try maintenance(triage: #"{"notes": null}"#).hasRecord)
        XCTAssertTrue(try maintenance(triage: #"{"notes": "Cleared."}"#).hasRecord)
        XCTAssertTrue(try maintenance(immediate: #"[{"code": "ROUTINE_VISUAL_MONITOR", "label": "Monitor"}]"#).hasRecord)
    }

    func testAnIncidentSaysWhereItStands() throws {
        let history = try JSONDecoder().decode(SiteHistory.self, from: Data("""
        {"anchor": {"latitude": 37.7, "longitude": -122.2, "location_id": 3, "radius_m": 150, "source": "FORM"},
         "current_types": [],
         "incidents": [{"incident_id": 12, "title": "Slip at PM 4", "observed_at": "2025-01-10T08:00:00", "distance_m": 40,
                        "same_location": false, "in_record": true, "types": [{"code": "SLIDE", "label": "Slide"}],
                        "relation": "SAME_TYPE", "stage": "ASSESSMENT", "status": "OPEN", "outcome": null,
                        "duplicate_of_incident_id": null, "event_group": null, "assessment": {"id": 4, "state": "SUBMITTED"},
                        "maintenance": {"report": {"description": "Rocks on the shoulder", "reported_by": "Crew 4", "reported_at": null},
                                        "triage": null, "immediate_actions": [], "follow_up_actions": [], "notes": [], "also_reported": []}}]}
        """.utf8))
        XCTAssertEqual(history.headline, "1 earlier incident here")
        XCTAssertEqual(history.incidents[0].heading, "Incident #12 · Slip at PM 4")
        XCTAssertEqual(history.incidents[0].standing, "Assessment in review")
        XCTAssertEqual(history.counts, "1 recurrence")
        XCTAssertEqual(history.scope, "Within 150 m of this site")
    }
}
