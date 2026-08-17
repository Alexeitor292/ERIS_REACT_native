import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentActionLabel,
  attachmentTypeLabel,
  formatFileSize,
  formatWorkflowTimestamp,
  workflowEventLabel,
  workflowTransitionLabel,
} from "./submissionReviewerSupportModel.ts";

const baseAttachment = {
  id: 1,
  file_name: "evidence.bin",
  mime_type: "application/octet-stream",
  file_size_bytes: 1024,
  storage_bucket: null,
  storage_key: "x",
  uploaded_at: null,
  kind: "DOC",
  sort_order: 0,
};

test("attachment actions describe the real content type", () => {
  assert.equal(attachmentActionLabel({ ...baseAttachment, kind: "PHOTO", mime_type: "image/jpeg" }), "Open photo");
  assert.equal(attachmentActionLabel({ ...baseAttachment, mime_type: "application/pdf" }), "Open PDF");
  assert.equal(attachmentActionLabel(baseAttachment), "Open file");
});

test("attachment type preserves useful MIME distinctions", () => {
  assert.equal(attachmentTypeLabel({ ...baseAttachment, kind: "PHOTO", mime_type: "image/png" }), "Photo");
  assert.equal(attachmentTypeLabel({ ...baseAttachment, mime_type: "application/pdf" }), "PDF");
  assert.equal(attachmentTypeLabel({ ...baseAttachment, kind: "DOC" }), "Document");
});

test("file sizes use readable units without changing byte authority", () => {
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(1024), "1.0 KB");
  assert.equal(formatFileSize(1024 * 1024), "1.0 MB");
});

test("known and unknown workflow codes remain understandable", () => {
  assert.equal(workflowEventLabel("SUBMIT"), "Submitted for review");
  assert.equal(workflowEventLabel("CUSTOM_EVENT"), "Custom Event");
});

test("workflow transitions remain source-faithful while readable", () => {
  assert.equal(
    workflowTransitionLabel({ from_status: "DRAFT", to_status: "SUBMITTED" }),
    "Draft → Submitted",
  );
  assert.equal(
    workflowTransitionLabel({ from_status: "SUBMITTED", to_status: "SUBMITTED" }),
    "Status remained Submitted",
  );
});

test("invalid workflow timestamps are returned verbatim", () => {
  assert.equal(formatWorkflowTimestamp("not-a-timestamp"), "not-a-timestamp");
});
