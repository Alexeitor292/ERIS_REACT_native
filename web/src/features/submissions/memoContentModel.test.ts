import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseMemoContent,
  distanceLabel,
  memoSignature,
  plainTextToMemoHtml,
  recordStandingLabel,
  hasMaintenanceRecord,
  summarizeRecord,
} from "./memoContentModel.ts";

test("plain text becomes paragraphs and line breaks, escaped", () => {
  assert.equal(plainTextToMemoHtml("First line\nsecond <b>\n\nNext"), "<p>First line<br>second &lt;b&gt;</p><p>Next</p>");
  assert.equal(plainTextToMemoHtml("   "), "");
  assert.equal(plainTextToMemoHtml(null), "");
});

test("the signature ignores bullets, numbers, punctuation and spacing", () => {
  assert.equal(memoSignature("Findings\n• Crack A\n2. Crack B"), memoSignature("findings crack a, crack b"));
  assert.notEqual(memoSignature("Crack A"), memoSignature("Crack B"));
});

test("the formatted memo wins while it matches its plain mirror", () => {
  const html = "<h2>Findings</h2><ul><li>Crack A</li></ul>";
  assert.equal(chooseMemoContent(html, "Findings\n• Crack A", "FindingsCrack A"), html);
});

test("a mirror edited elsewhere (the mobile app) wins over a stale formatted memo", () => {
  const html = "<p>Old text</p>";
  assert.equal(chooseMemoContent(html, "New text from the field", "Old text"), "<p>New text from the field</p>");
});

test("a memo with only plain text opens as paragraphs; an empty one opens empty", () => {
  assert.equal(chooseMemoContent(null, "Wet toe", ""), "<p>Wet toe</p>");
  assert.equal(chooseMemoContent(null, null, ""), "");
});

test("labels for the site history", () => {
  assert.equal(distanceLabel(12.4, false), "12 m away");
  assert.equal(distanceLabel(1540, false), "1.5 km away");
  assert.equal(distanceLabel(80, true), "Same location");
  assert.equal(recordStandingLabel("RESOLVED", "APPROVED"), "Resolved");
  assert.equal(recordStandingLabel("OFFICE_CHIEF_REVIEW", "PENDING_OFFICE_DELEGATION"), "Awaiting office routing");
  assert.deepEqual(
    summarizeRecord([{ relation: "SAME_TYPE" }, { relation: "SAME_TYPE" }, { relation: "DIFFERENT_TYPE" }]),
    { total: 3, recurrences: 2, differentType: 1, unclassified: 0, outsideRecord: 0 },
  );
  assert.deepEqual(
    summarizeRecord([{ relation: "SAME_TYPE", in_record: true }, { relation: "UNCLASSIFIED", in_record: false }]),
    { total: 2, recurrences: 1, differentType: 0, unclassified: 0, outsideRecord: 1 },
  );
});

test("maintenance counts as a record once it did or wrote something beyond the report", () => {
  const empty = { triage: null, immediate_actions: [], follow_up_actions: [], notes: [], also_reported: [] };
  assert.equal(hasMaintenanceRecord(empty), false);
  assert.equal(hasMaintenanceRecord({ ...empty, triage: { notes: null } }), false);
  assert.equal(hasMaintenanceRecord({ ...empty, triage: { notes: "Cleared." } }), true);
  assert.equal(hasMaintenanceRecord({ ...empty, follow_up_actions: [{ code: "ROUTINE_VISUAL_MONITOR" }] }), true);
});
