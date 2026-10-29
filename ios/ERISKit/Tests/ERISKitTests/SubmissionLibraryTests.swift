import XCTest
@testable import ERISKit

/// Ported from web/src/features/submissions/submissionAttachmentModel.test.ts.
final class SubmissionLibraryTests: XCTestCase {
    func testMediaKindIsClassifiedByMimePrefixFirst() {
        XCTAssertEqual(SubmissionLibrary.media(mimeType: "image/jpeg", kind: "DOC"), .photo)
        XCTAssertEqual(SubmissionLibrary.media(mimeType: "video/mp4", kind: "PHOTO"), .video)
        XCTAssertEqual(SubmissionLibrary.media(mimeType: "application/pdf", kind: "PHOTO"), .document)
        XCTAssertEqual(SubmissionLibrary.media(mimeType: "", kind: "PHOTO"), .photo)
        XCTAssertEqual(SubmissionLibrary.media(mimeType: "", kind: "SKETCH"), .photo)
        XCTAssertEqual(SubmissionLibrary.media(mimeType: "", kind: "DOC"), .document)
    }

    func testPdfDetectionAcceptsMimeTypeOrExtension() {
        XCTAssertTrue(SubmissionLibrary.isPDF(mimeType: "application/pdf", fileName: "x.bin"))
        XCTAssertTrue(SubmissionLibrary.isPDF(mimeType: "application/octet-stream", fileName: "plan.PDF"))
        XCTAssertFalse(SubmissionLibrary.isPDF(mimeType: "image/png", fileName: "a.png"))
    }

    func testSectionLabelsUseTheFormSectionNamesAndFallBackGracefully() {
        XCTAssertEqual(SubmissionLibrary.sectionLabel("vegetation_slope"), "Vegetation on Slope")
        XCTAssertEqual(SubmissionLibrary.sectionLabel("pavement_ground_status"), "Pavement / Ground Status")
        XCTAssertEqual(SubmissionLibrary.sectionLabel(nil), "Submission")
        XCTAssertEqual(SubmissionLibrary.sectionLabel("  "), "Submission")
        XCTAssertEqual(SubmissionLibrary.sectionLabel("custom_thing"), "Custom Thing")
    }

    func testLibraryItemsAreFilterableAndCountableByMedia() {
        let items = SubmissionLibrary.items([
            AttachmentRef(id: 1, kind: "PHOTO", mimeType: "image/jpeg", sectionKey: "material"),
            AttachmentRef(id: 2, kind: "DOC", mimeType: "video/mp4", sectionKey: "Material"),
            AttachmentRef(id: 3, kind: "DOC", mimeType: "application/pdf", sectionKey: nil),
            AttachmentRef(id: 4, kind: "PHOTO", mimeType: "image/png", sectionKey: "vegetation_slope"),
        ])
        XCTAssertEqual(SubmissionLibrary.counts(items), .init(all: 4, photos: 2, videos: 1, documents: 1))
        XCTAssertEqual(SubmissionLibrary.filter(items, .photos).map(\.id), [1, 4])
        XCTAssertEqual(SubmissionLibrary.filter(items, .videos).map(\.id), [2])
        XCTAssertEqual(SubmissionLibrary.filter(items, .documents).map(\.id), [3])
        XCTAssertEqual(SubmissionLibrary.filter(items, .all).count, 4)
        XCTAssertEqual(SubmissionLibrary.items(items, inSections: ["material"]).map(\.id), [1, 2])
        XCTAssertEqual(SubmissionLibrary.items(items, inSections: ["vegetation_slope", "vegetation_on_slope"]).map(\.id), [4])
        XCTAssertEqual(items[2].sectionLabel, "Submission")
        XCTAssertEqual(SubmissionLibrary.countLabel(SubmissionLibrary.counts(items)), "4 items · 2 photos · 1 video · 1 document")
        XCTAssertEqual(SubmissionLibrary.countLabel(SubmissionLibrary.counts([])), "No files")
    }

    /// As the Expo editor's inferAttachmentKind.
    func testAnUploadsKindFollowsItsTypeAndName() {
        XCTAssertEqual(SubmissionLibrary.uploadKind(fileName: "gisa-sketch-1.png", mimeType: "image/png"), "SKETCH")
        XCTAssertEqual(SubmissionLibrary.uploadKind(fileName: "site.heic", mimeType: "image/heic"), "PHOTO")
        XCTAssertEqual(SubmissionLibrary.uploadKind(fileName: "walk.mov", mimeType: "video/quicktime"), "VIDEO")
        XCTAssertEqual(SubmissionLibrary.uploadKind(fileName: "walk.MOV", mimeType: "application/octet-stream"), "VIDEO")
        XCTAssertEqual(SubmissionLibrary.uploadKind(fileName: "plan.dwg", mimeType: "application/octet-stream"), "DOC")
        XCTAssertEqual(SubmissionLibrary.uploadKind(fileName: "report.pdf", mimeType: "application/pdf"), "DOC")
    }

    func testAFileOverTheServersLimitIsStoppedWithItsWords() {
        XCTAssertNil(SubmissionLibrary.sizeProblem(fileName: "a.mov", bytes: 95 * 1024 * 1024))
        XCTAssertEqual(SubmissionLibrary.sizeProblem(fileName: "a.mov", bytes: 95 * 1024 * 1024 + 1),
                       "a.mov is larger than 95 MB. Shorten or compress it, or share a link in the notes.")
        XCTAssertEqual(SubmissionLibrary.sizeText(830_000), "811 KB")
        XCTAssertEqual(SubmissionLibrary.sizeText(2_500_000), "2.4 MB")
    }

    func testTheDetailsFilesCarryTheirSizeAndUploadTime() throws {
        let detail = try JSONDecoder().decode(SubmissionDetail.self, from: Data("""
        {"submission": {"id": 5, "status": "DRAFT"}, "gisa": {},
         "photos": [{"id": 9, "kind": "PHOTO", "file_name": "p.jpg", "mime_type": "image/jpeg"}],
         "attachments": [{"id": 9, "kind": "PHOTO", "file_name": "p.jpg", "mime_type": "image/jpeg", "file_size_bytes": 2048,
                          "uploaded_at": "2026-10-28T10:00:00", "section_key": null},
                         {"id": 10, "kind": "DOC", "file_name": "plan.pdf", "mime_type": "application/pdf",
                          "section_key": "measurements"}]}
        """.utf8))
        let items = SubmissionLibrary.items(of: detail)
        XCTAssertEqual(items.map(\.media), [.photo, .document])
        XCTAssertEqual(items[0].attachment.fileSizeBytes, 2048)
        XCTAssertEqual(items[1].sectionLabel, "Measurements")
    }
}
