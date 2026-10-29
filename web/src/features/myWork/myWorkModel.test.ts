import assert from "node:assert/strict";
import test from "node:test";

import { filterWork, maintenanceInView, maintenanceStatus, parseWorkFilter, workArea } from "./myWorkModel.ts";

const items = [
  { kind: "triage" as const, id: "t1" },
  { kind: "maintenance" as const, id: "m2" },
  { kind: "share" as const, id: "s3" },
  { kind: "assessment" as const, id: "a4" },
];

test("triage and maintenance reports are maintenance; assessments and shares are geotechnical", () => {
  assert.deepEqual(items.map((item) => workArea(item.kind)), ["maintenance", "maintenance", "geotech", "geotech"]);
});

test("an administrator chooses one side or both; nobody else filters", () => {
  assert.deepEqual(filterWork(items, "geotech", true).map((item) => item.id), ["s3", "a4"]);
  assert.deepEqual(filterWork(items, "maintenance", true).map((item) => item.id), ["t1", "m2"]);
  assert.equal(filterWork(items, "both", true).length, 4);
  assert.equal(filterWork(items, "geotech", false).length, 4, "the choice is an administrator's");
  assert.equal(parseWorkFilter("maintenance"), "maintenance");
  assert.equal(parseWorkFilter("anything"), "both");
  assert.equal(parseWorkFilter(null), "both");
});

test("a maintenance report says where it stands", () => {
  assert.equal(maintenanceStatus({ outcome: "GEOTECH", waiting_reporter: false, step_name: "Review" }), "Sent to GeoTech");
  assert.equal(maintenanceStatus({ outcome: "MAINTENANCE", waiting_reporter: false, step_name: "Review" }), "Maintenance handles it");
  assert.equal(maintenanceStatus({ outcome: null, waiting_reporter: true, step_name: "Review" }), "Waiting on reporter");
  assert.equal(maintenanceStatus({ outcome: null, waiting_reporter: false, step_name: "Supervisor review" }), "Supervisor review");
});

test("reports waiting on this person are listed; the rest when asked, and one opened by a link always", () => {
  const reports = [{ id: 1, my_turn: true }, { id: 2, my_turn: false }, { id: 3, my_turn: false }];
  assert.deepEqual(maintenanceInView(reports, false, null).map((r) => r.id), [1]);
  assert.deepEqual(maintenanceInView(reports, false, 3).map((r) => r.id), [1, 3]);
  assert.deepEqual(maintenanceInView(reports, true, null).map((r) => r.id), [1, 2, 3]);
});
