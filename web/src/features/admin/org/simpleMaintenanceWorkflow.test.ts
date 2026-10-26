import assert from "node:assert/strict";
import test from "node:test";

import type { Definition } from "../../../api/maintenanceWorkflows";
import {
  createInitialDefinition,
  fromSimpleWorkflow,
  isSimpleDefinition,
  toSimpleWorkflow,
  validateSimpleWorkflow,
  type SimpleWorkflow,
} from "./simpleMaintenanceWorkflow.ts";

function ready(): SimpleWorkflow {
  return {
    managerIds: [1], reporterIds: [2, 3], decisionIds: [4], notifyIds: [],
    reviews: [], allowMaintenance: true, allowGeotech: true,
  };
}

test("first setup starts with a manager as decision maker and asks only for reporters", () => {
  const definition = createInitialDefinition(1);
  assert.equal(isSimpleDefinition(definition), true);
  const state = toSimpleWorkflow(definition);
  assert.deepEqual(state.managerIds, [1]);
  assert.deepEqual(state.reporterIds, []);
  assert.deepEqual(state.decisionIds, [1]);
  assert.deepEqual(state.reviews, []);
  assert.deepEqual(validateSimpleWorkflow(state), ["Choose at least one person who can submit reports."]);
  assert.equal(definition.steps.length, 1);
  assert.equal(definition.steps[0].kind, "DECISION");
  assert.deepEqual(definition.steps[0].duty_ids, ["decision"]);
  assert.deepEqual(toSimpleWorkflow(createInitialDefinition(1, [2], [3])).decisionIds, [3]);
});

test("guided state round-trips dedicated reviewers, notifications, rules, and outcomes", () => {
  const state: SimpleWorkflow = {
    ...ready(), notifyIds: [7, 8], allowGeotech: false,
    reviews: [
      { id: "review_a", name: "Supervisor review", userIds: [5, 6], rule: "ALL" },
      { id: "review_b", name: "District review", userIds: [4], rule: "ANY" },
    ],
  };
  const definition = fromSimpleWorkflow(state);
  assert.equal(isSimpleDefinition(definition), true);
  assert.deepEqual(toSimpleWorkflow(definition), state);
  assert.deepEqual(definition.notify_duty_ids, ["informed"]);
  assert.deepEqual(definition.steps.map(item => item.kind), ["REVIEW", "REVIEW", "DECISION"]);
  assert.deepEqual(definition.steps[0].duty_ids, ["review_a"]);
  assert.deepEqual(definition.steps[1].duty_ids, ["review_b"]);
  assert.equal(definition.steps[0].request_information, true);
  assert.equal(definition.steps[0].allow_maintenance, false);
  assert.equal(definition.steps[2].allow_maintenance, true);
  assert.equal(definition.steps[2].allow_geotech, false);
  assert.deepEqual(validateSimpleWorkflow(state), []);
});

test("an unused Keep informed duty from the old creator remains a simple workflow", () => {
  const definition = fromSimpleWorkflow(ready());
  definition.duties.push({
    id: "informed", name: "Keep informed", user_ids: [],
    report: false, view_district: false, edit_report: false,
  });
  assert.equal(isSimpleDefinition(definition), true);
  assert.deepEqual(toSimpleWorkflow(definition).notifyIds, []);
});

test("advanced saved definitions never enter the guided editor", () => {
  const initial = fromSimpleWorkflow({ ...ready(), reviews: [{ id: "review_a", name: "Review", userIds: [5], rule: "ANY" }] });
  const changed = (edit: (definition: Definition) => void) => {
    const definition = structuredClone(initial);
    edit(definition);
    assert.equal(isSimpleDefinition(definition), false);
    assert.throws(() => toSimpleWorkflow(definition), /advanced settings/);
  };
  changed(definition => { definition.steps[0].allow_maintenance = true; });
  changed(definition => { definition.steps[0].notify_duty_ids = ["reporters"]; });
  changed(definition => { definition.steps[1].rule = "ALL"; });
  changed(definition => { definition.duties[0].edit_report = true; });
  changed(definition => { definition.duties.push({ id: "extra", name: "Extra duty", user_ids: [6], report: false, view_district: false, edit_report: false }); });
  changed(definition => { definition.steps[0].duty_ids.push("decision"); });
});

test("publish guidance points to missing people, outcomes, invalid review IDs, and inactive users", () => {
  const state: SimpleWorkflow = {
    managerIds: [], reporterIds: [], decisionIds: [], notifyIds: [],
    reviews: [{ id: "decision", name: "", userIds: [], rule: "ANY" }],
    allowMaintenance: false, allowGeotech: false,
  };
  const errors = validateSimpleWorkflow(state);
  assert.ok(errors.some(item => item.includes("workflow manager")));
  assert.ok(errors.some(item => item.includes("submit reports")));
  assert.ok(errors.some(item => item.includes("decision maker")));
  assert.ok(errors.some(item => item.includes("final outcome")));
  assert.ok(errors.some(item => item.includes("Name review step 1")));
  assert.ok(errors.some(item => item.includes("reviewer")));
  assert.ok(errors.some(item => item.includes("unique identifier")));

  const duplicate = { ...ready(), reporterIds: [2, 2], reviews: [{ id: "review_x", name: "Review", userIds: [9], rule: "ANY" as const }] };
  const people = [{ id: 9, full_name: "Former reviewer", is_active: false }];
  const duplicateErrors = validateSimpleWorkflow(duplicate, people);
  assert.ok(duplicateErrors.some(item => item.includes("selected once")));
  assert.ok(duplicateErrors.some(item => item.includes("inactive")));
});
