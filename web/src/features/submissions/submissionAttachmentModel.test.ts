import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentMediaKind,
  buildLibraryItems,
  filterLibraryItems,
  isPdfAttachment,
  itemsForSectionKeys,
  libraryCountLabel,
  libraryCounts,
  sectionLabel,
} from "./submissionAttachmentModel.ts";

const base = {
  id: 1,
  file_name: "file.bin",
  mime_type: "application/octet-stream",
  file_size_bytes: 10,
  storage_bucket: null,
  storage_key: "k",
  uploaded_at: null,
  kind: "DOC",
  sort_order: 0,
};

test("media kind is classified by MIME prefix first", () => {
  assert.equal(attachmentMediaKind({ mime_type: "image/jpeg", kind: "DOC" }), "photo");
  assert.equal(attachmentMediaKind({ mime_type: "video/mp4", kind: "PHOTO" }), "video");
  assert.equal(attachmentMediaKind({ mime_type: "application/pdf", kind: "PHOTO" }), "document");
  assert.equal(attachmentMediaKind({ mime_type: "", kind: "PHOTO" }), "photo");
  assert.equal(attachmentMediaKind({ mime_type: "", kind: "SKETCH" }), "photo");
  assert.equal(attachmentMediaKind({ mime_type: "", kind: "DOC" }), "document");
});

test("pdf detection accepts MIME type or extension", () => {
  assert.equal(isPdfAttachment({ mime_type: "application/pdf", file_name: "x.bin" }), true);
  assert.equal(isPdfAttachment({ mime_type: "application/octet-stream", file_name: "plan.PDF" }), true);
  assert.equal(isPdfAttachment({ mime_type: "image/png", file_name: "a.png" }), false);
});

test("section labels use the mobile form section names and fall back gracefully", () => {
  assert.equal(sectionLabel("vegetation_slope"), "Vegetation on Slope");
  assert.equal(sectionLabel("pavement_ground_status"), "Pavement / Ground Status");
  assert.equal(sectionLabel(null), "Submission");
  assert.equal(sectionLabel("  "), "Submission");
  assert.equal(sectionLabel("custom_thing"), "Custom Thing");
});

test("library items are filterable and countable by media", () => {
  const items = buildLibraryItems([
    { ...base, id: 1, mime_type: "image/jpeg", kind: "PHOTO", section_key: "material" },
    { ...base, id: 2, mime_type: "video/mp4", kind: "DOC", section_key: "Material" },
    { ...base, id: 3, mime_type: "application/pdf", kind: "DOC", section_key: null },
    { ...base, id: 4, mime_type: "image/png", kind: "PHOTO", section_key: "vegetation_slope" },
  ]);
  assert.deepEqual(libraryCounts(items), { all: 4, photos: 2, videos: 1, documents: 1 });
  assert.deepEqual(filterLibraryItems(items, "PHOTOS").map((item) => item.attachment.id), [1, 4]);
  assert.deepEqual(filterLibraryItems(items, "VIDEOS").map((item) => item.attachment.id), [2]);
  assert.deepEqual(filterLibraryItems(items, "DOCUMENTS").map((item) => item.attachment.id), [3]);
  assert.equal(filterLibraryItems(items, "ALL").length, 4);
  assert.deepEqual(itemsForSectionKeys(items, ["material"]).map((item) => item.attachment.id), [1, 2]);
  assert.deepEqual(itemsForSectionKeys(items, ["vegetation_slope", "vegetation_on_slope"]).map((item) => item.attachment.id), [4]);
  assert.equal(items[2].sectionLabel, "Submission");
  assert.equal(libraryCountLabel(libraryCounts(items)), "4 items · 2 photos · 1 video · 1 document");
  assert.equal(libraryCountLabel(libraryCounts([])), "No files");
});
