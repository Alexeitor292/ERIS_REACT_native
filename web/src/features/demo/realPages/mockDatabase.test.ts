import assert from "node:assert/strict";
import test from "node:test";
import { MockDatabase, PEOPLE } from "./mockDatabase.ts";

const post = (db: MockDatabase, path: string, body: unknown = {}) => db.request(path, { method: "POST", body: JSON.stringify(body) });
async function report(db: MockDatabase) { await post(db, "/incidents", { latitude: 38.4501, longitude: -122.9001, first_observed_at: "2026-11-09T09:00", description: "Sample conditions" }); }
test("fresh sessions expose no incidents or assessments and never load another visitor's records", async () => {
  const first = new MockDatabase(), second = new MockDatabase(); await report(first);
  assert.deepEqual(await second.request("/incidents"), { items: [] });
  assert.deepEqual(await second.request("/assessments"), { items: [] });
  assert.deepEqual(await second.request("/event-groups"), { items: [] });
  assert.equal(PEOPLE[5].roles[0], "STAFF");
});
test("real-page API shapes drive supervisor review, contact referral, routing, GISA, revision and approval", async () => {
  const db = new MockDatabase(); await report(db); db.setActor(1);
  await post(db, "/maintenance-work/incidents/1/actions", { version: 1, action: "APPROVE", notes: "Reviewed" });
  db.setActor(2); await post(db, "/maintenance-work/incidents/1/actions", { version: 2, action: "GEOTECH", notes: "Assessment needed", district_contact_user_id: 3, new_group_title: "Sample storm" });
  assert.equal(db.incident?.incident_key, "DEMO-2026-001"); assert.equal(db.group?.title, "Sample storm");
  db.setActor(3); await post(db, "/assessments/1/delegate-branch", { branch_chief_user_id: 5 });
  db.setActor(4); await post(db, "/assessments/1/assign-engineer", { engineer_user_id: 6 });
  db.setActor(5); await db.request("/submissions/1/gisa", { method: "PATCH", body: JSON.stringify({ observations_notes_html: "<p>Sample note</p>" }) });
  await post(db, "/assessments/1/submit"); db.setActor(4);
  await post(db, "/assessments/1/review", { action: "REQUEST_REVISION", notes: "Clarify evidence" });
  assert.equal(db.assessment?.state, "REVISION_REQUESTED");
  db.setActor(5); await post(db, "/assessments/1/submit"); db.setActor(4);
  await post(db, "/assessments/1/review", { action: "APPROVE" });
  assert.equal(db.assessment?.state, "APPROVED"); assert.equal(db.submission?.status, "APPROVED");
  db.reset(); assert.equal(db.incident, null); assert.equal(db.group, null); assert.equal(db.submission, null); assert.equal(db.assessment, null);
  assert.equal(db.notices.length, 0); assert.equal(db.mutations.length, 0);
});
test("unsupported requests and out-of-order mutations fail closed", async () => {
  const db = new MockDatabase();
  await assert.rejects(db.request("/incidents/999"), /No live request/);
  await assert.rejects(post(db, "/assessments/1/review", { action: "APPROVE" }));
  await report(db); db.setActor(1);
  await assert.rejects(post(db, "/maintenance-work/incidents/1/actions", { version: 0, action: "APPROVE", notes: "Stale" }), /Refresh/);
  await assert.rejects(post(db, "/maintenance-work/incidents/1/actions", { version: 1, action: "APPROVE", notes: " " }), /notes/);
  assert.equal(db.maintenanceIndex, 0);
});
