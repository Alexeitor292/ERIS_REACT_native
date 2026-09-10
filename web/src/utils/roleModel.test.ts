import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL,
  OPERATIONAL_ROLE_NAMES,
  canAssignEngineer,
  canAssignSpecialist,
  canDelegateBranch,
  canReportIncident,
  canTriage,
  hasRole,
  hasWorkQueue,
  isAdmin,
  isAssessmentAuthor,
  isEngineer,
  isMaintenanceOnly,
  isOperationalUser,
  isSeniorSpecialist,
} from "./roleModel.ts";

const SPECIALIST = ["GEOTECH_SENIOR_SPECIALIST"];
const ENGINEER = ["GEOTECH_ENGINEER"];
const LEGACY_ENGINEER = ["FIELD_WORKER"];
const OFFICE_CHIEF = ["GEOTECH_OFFICE_CHIEF"];
const BRANCH_CHIEF = ["GEOTECH_BRANCH_CHIEF"];
const COORDINATOR = ["MAINTENANCE_COORDINATOR"];
const LEGACY_REVIEWER = ["REVIEWER"];
const MAINTENANCE = ["MAINTENANCE_FIELD_WORKER"];

test("the senior specialist is a canonical operational role with no legacy alias", () => {
  assert.deepEqual([...CANONICAL.GEOTECH_SENIOR_SPECIALIST], ["GEOTECH_SENIOR_SPECIALIST"]);
  assert.ok(OPERATIONAL_ROLE_NAMES.includes("GEOTECH_SENIOR_SPECIALIST"));
  assert.equal(isOperationalUser(SPECIALIST), true);
  assert.equal(isMaintenanceOnly(SPECIALIST), false);
  assert.equal(hasWorkQueue(SPECIALIST), true);
  assert.equal(hasRole(SPECIALIST, "GEOTECH_SENIOR_SPECIALIST"), true);
  assert.equal(hasRole(ENGINEER, "GEOTECH_SENIOR_SPECIALIST"), false);
});

test("the legacy REVIEWER role keeps exactly the reach it has today", () => {
  assert.ok(OPERATIONAL_ROLE_NAMES.includes("REVIEWER"));
  assert.equal(isOperationalUser(LEGACY_REVIEWER), true);
  assert.equal(hasWorkQueue(LEGACY_REVIEWER), true);
  assert.equal(isMaintenanceOnly(LEGACY_REVIEWER), false);
  // and grants no routing, authoring or review affordance of its own.
  assert.equal(isAssessmentAuthor(LEGACY_REVIEWER), false);
  assert.equal(canDelegateBranch(LEGACY_REVIEWER), false);
  assert.equal(canAssignSpecialist(LEGACY_REVIEWER), false);
  assert.equal(canAssignEngineer(LEGACY_REVIEWER), false);
  assert.equal(canReportIncident(LEGACY_REVIEWER), false);
});

test("assessment authors are the engineer, the senior specialist and admin", () => {
  assert.equal(isAssessmentAuthor(ENGINEER), true);
  assert.equal(isAssessmentAuthor(LEGACY_ENGINEER), true);
  assert.equal(isAssessmentAuthor(SPECIALIST), true);
  assert.equal(isAssessmentAuthor(["ADMIN"]), true);
  assert.equal(isAssessmentAuthor(OFFICE_CHIEF), false);
  assert.equal(isAssessmentAuthor(BRANCH_CHIEF), false);
  assert.equal(isAssessmentAuthor(COORDINATOR), false);
  assert.equal(isAssessmentAuthor(undefined), false);
  // isEngineer stays engineer-only: a specialist is not a staff engineer.
  assert.equal(isEngineer(SPECIALIST), false);
  assert.equal(isSeniorSpecialist(ENGINEER), false);
  assert.equal(isSeniorSpecialist(SPECIALIST), true);
});

test("both routing choices belong to the office chief and admin", () => {
  assert.equal(canDelegateBranch(OFFICE_CHIEF), true);
  assert.equal(canAssignSpecialist(OFFICE_CHIEF), true);
  assert.equal(canDelegateBranch(["OFFICE_CHIEF"]), true);
  assert.equal(canAssignSpecialist(["OFFICE_CHIEF"]), true);
  assert.equal(canAssignSpecialist(BRANCH_CHIEF), false);
  assert.equal(canAssignSpecialist(SPECIALIST), false);
  assert.equal(canAssignEngineer(BRANCH_CHIEF), true);
  assert.equal(canAssignEngineer(OFFICE_CHIEF), false);
  for (const helper of [canDelegateBranch, canAssignSpecialist, canAssignEngineer, canTriage, isAssessmentAuthor]) {
    assert.equal(helper(["ADMIN"]), true, `${helper.name} should keep the admin bypass`);
  }
});

test("a senior specialist may file an incident report; a coordinator may not", () => {
  assert.equal(canReportIncident(SPECIALIST), true);
  assert.equal(canReportIncident(ENGINEER), true);
  assert.equal(canReportIncident(MAINTENANCE), true);
  assert.equal(canReportIncident(["ADMIN"]), true);
  assert.equal(canReportIncident(COORDINATOR), false);
  assert.equal(canReportIncident(OFFICE_CHIEF), false);
  assert.equal(canReportIncident(BRANCH_CHIEF), false);
});

test("maintenance-only accounts stay out of the operational surface", () => {
  assert.equal(isMaintenanceOnly(MAINTENANCE), true);
  assert.equal(isMaintenanceOnly(["MAINTENANCE"]), true);
  assert.equal(isOperationalUser(MAINTENANCE), false);
  assert.equal(isMaintenanceOnly([...MAINTENANCE, ...SPECIALIST]), false);
  assert.equal(isAdmin(SPECIALIST), false);
  assert.equal(isAdmin(["ADMIN"]), true);
});
