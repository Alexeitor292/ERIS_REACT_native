import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLES,
  canAssignEngineer,
  canDelegateBranch,
  canReportIncident,
  canTriage,
  hasRole,
  isAdmin,
  isAssessmentAuthor,
  isMaintenanceOnly,
  isOperationalUser,
  isPublicOnly,
  isSeniorSpecialist,
  isStaff,
  isWorkforceUser,
  roleLabel,
} from "./roleModel.ts";

const RETIRED = [
  "MAINTENANCE", "MAINTENANCE_FIELD_WORKER", "MAINT_COORDINATOR", "GEOTECH_OFFICE_CHIEF",
  "GEOTECH_BRANCH_CHIEF", "GEOTECH_ENGINEER", "GEOTECH_SENIOR_ENGINEER", "FIELD_WORKER",
  "CALTRANS_VIEWER", "REVIEWER",
];

const GATES = [
  isOperationalUser, isMaintenanceOnly, isPublicOnly, isWorkforceUser, canTriage, canDelegateBranch,
  canAssignEngineer, isStaff, isSeniorSpecialist, isAssessmentAuthor, canReportIncident, isAdmin,
];

test("the roles are the seven work roles and the Administrator, none called an engineer", () => {
  assert.deepEqual(Object.values(ROLES).map(roleLabel), [
    "Maintenance Crew", "Maintenance Coordinator", "Office Chief", "Branch Chief",
    "Senior Specialist", "Staff", "Guest", "Administrator",
  ]);
  for (const code of Object.values(ROLES)) assert.doesNotMatch(roleLabel(code), /engineer/i);
});

test("a retired code opens nothing on the phone", () => {
  for (const code of RETIRED) {
    for (const gate of GATES) assert.equal(gate([code]), false, `${gate.name}(${code})`);
    assert.equal(roleLabel(code), code);
  }
});

test("each role reaches its own work", () => {
  assert.equal(canReportIncident([ROLES.MAINTENANCE_CREW]), true);
  assert.equal(isMaintenanceOnly([ROLES.MAINTENANCE_CREW]), true);
  assert.equal(canTriage([ROLES.MAINTENANCE_COORDINATOR]), true);
  assert.equal(canDelegateBranch([ROLES.OFFICE_CHIEF]), true);
  assert.equal(canAssignEngineer([ROLES.BRANCH_CHIEF]), true);
  assert.equal(isAssessmentAuthor([ROLES.STAFF]), true);
  assert.equal(isAssessmentAuthor([ROLES.SENIOR_SPECIALIST]), true);
  assert.equal(isStaff([ROLES.SENIOR_SPECIALIST]), false);
  assert.equal(hasRole([ROLES.STAFF], ROLES.SENIOR_SPECIALIST), false);
  // Exactly the server's FIELD_REPORTING_ROLES.
  assert.equal(canReportIncident([ROLES.SENIOR_SPECIALIST]), false);
  assert.equal(canReportIncident([ROLES.MAINTENANCE_COORDINATOR]), false);
});

test("the guest is read-only unless another role says otherwise", () => {
  const guest = [ROLES.GUEST];
  assert.equal(isPublicOnly(guest), true);
  for (const gate of GATES.filter((g) => g !== isPublicOnly)) assert.equal(gate(guest), false, gate.name);
  assert.equal(isPublicOnly([ROLES.GUEST, ROLES.OFFICE_CHIEF]), false);
  assert.equal(canDelegateBranch([ROLES.GUEST, ROLES.OFFICE_CHIEF]), true);
});

test("the administrator passes every workflow gate", () => {
  for (const gate of [canTriage, canDelegateBranch, canAssignEngineer, isAssessmentAuthor, canReportIncident, isWorkforceUser]) {
    assert.equal(gate([ROLES.ADMIN]), true, gate.name);
  }
  assert.equal(isMaintenanceOnly([ROLES.ADMIN]), false);
  assert.equal(isPublicOnly([ROLES.ADMIN]), false);
});
