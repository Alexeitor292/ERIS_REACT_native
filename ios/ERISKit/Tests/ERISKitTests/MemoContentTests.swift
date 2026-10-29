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
