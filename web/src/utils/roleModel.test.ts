import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL,
  OPERATIONAL_ROLE_NAMES,
  canAssignEngineer,
  canAssignSeniorEngineer,
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
  isSeniorEngineer,
  roleLabel,
} from "./roleModel.ts";

const SENIOR_ENGINEER = ["GEOTECH_SENIOR_ENGINEER"];
// Staff keep the deployed GEOTECH_ENGINEER code and its FIELD_WORKER alias.
const STAFF = ["GEOTECH_ENGINEER"];
const LEGACY_STAFF = ["FIELD_WORKER"];
const OFFICE_CHIEF = ["GEOTECH_OFFICE_CHIEF"];
const BRANCH_CHIEF = ["GEOTECH_BRANCH_CHIEF"];
const COORDINATOR = ["MAINTENANCE_COORDINATOR"];
const LEGACY_REVIEWER = ["REVIEWER"];
const MAINTENANCE = ["MAINTENANCE_FIELD_WORKER"];

test("the senior engineer is a canonical operational role with no legacy alias", () => {
  assert.deepEqual([...CANONICAL.GEOTECH_SENIOR_ENGINEER], ["GEOTECH_SENIOR_ENGINEER"]);
  assert.ok(OPERATIONAL_ROLE_NAMES.includes("GEOTECH_SENIOR_ENGINEER"));
  assert.equal(isOperationalUser(SENIOR_ENGINEER), true);
  assert.equal(isMaintenanceOnly(SENIOR_ENGINEER), false);
  assert.equal(hasWorkQueue(SENIOR_ENGINEER), true);
  assert.equal(hasRole(SENIOR_ENGINEER, "GEOTECH_SENIOR_ENGINEER"), true);
  assert.equal(hasRole(STAFF, "GEOTECH_SENIOR_ENGINEER"), false);
});

test("role labels name Staff and the senior engineer, and never call Staff engineers", () => {
  assert.equal(roleLabel("GEOTECH_ENGINEER"), "GeoTech Staff");
  assert.equal(roleLabel("FIELD_WORKER"), "GeoTech Staff (legacy)");
  assert.equal(roleLabel("GEOTECH_SENIOR_ENGINEER"), "GeoTech Senior Engineer");
  assert.equal(roleLabel("GEOTECH_OFFICE_CHIEF"), "GeoTech Office Chief");
  // An unlabelled code still renders readably instead of as a raw code.
  assert.equal(roleLabel("SOME_NEW_ROLE"), "Some New Role");
  for (const code of CANONICAL.GEOTECH_ENGINEER) {
    assert.doesNotMatch(roleLabel(code), /engineer/i, `${code} is labelled as an engineer`);
  }
});

test("the legacy REVIEWER role keeps exactly the reach it has today", () => {
  assert.ok(OPERATIONAL_ROLE_NAMES.includes("REVIEWER"));
  assert.equal(isOperationalUser(LEGACY_REVIEWER), true);
  assert.equal(hasWorkQueue(LEGACY_REVIEWER), true);
  assert.equal(isMaintenanceOnly(LEGACY_REVIEWER), false);
  // and grants no routing, authoring or review affordance of its own.
  assert.equal(isAssessmentAuthor(LEGACY_REVIEWER), false);
  assert.equal(canDelegateBranch(LEGACY_REVIEWER), false);
  assert.equal(canAssignSeniorEngineer(LEGACY_REVIEWER), false);
  assert.equal(canAssignEngineer(LEGACY_REVIEWER), false);
  assert.equal(canReportIncident(LEGACY_REVIEWER), false);
});

test("assessment authors are Staff, the senior engineer and admin", () => {
  assert.equal(isAssessmentAuthor(STAFF), true);
  assert.equal(isAssessmentAuthor(LEGACY_STAFF), true);
  assert.equal(isAssessmentAuthor(SENIOR_ENGINEER), true);
  assert.equal(isAssessmentAuthor(["ADMIN"]), true);
  assert.equal(isAssessmentAuthor(OFFICE_CHIEF), false);
  assert.equal(isAssessmentAuthor(BRANCH_CHIEF), false);
  assert.equal(isAssessmentAuthor(COORDINATOR), false);
  assert.equal(isAssessmentAuthor(undefined), false);
  // isEngineer stays GEOTECH_ENGINEER-only: a senior engineer is not Staff under a branch chief.
  assert.equal(isEngineer(SENIOR_ENGINEER), false);
  assert.equal(isSeniorEngineer(STAFF), false);
  assert.equal(isSeniorEngineer(SENIOR_ENGINEER), true);
});

test("both routing choices belong to the office chief and admin", () => {
  assert.equal(canDelegateBranch(OFFICE_CHIEF), true);
  assert.equal(canAssignSeniorEngineer(OFFICE_CHIEF), true);
  assert.equal(canDelegateBranch(["OFFICE_CHIEF"]), true);
  assert.equal(canAssignSeniorEngineer(["OFFICE_CHIEF"]), true);
  assert.equal(canAssignSeniorEngineer(BRANCH_CHIEF), false);
  assert.equal(canAssignSeniorEngineer(SENIOR_ENGINEER), false);
  assert.equal(canAssignEngineer(BRANCH_CHIEF), true);
  assert.equal(canAssignEngineer(OFFICE_CHIEF), false);
  for (const helper of [canDelegateBranch, canAssignSeniorEngineer, canAssignEngineer, canTriage, isAssessmentAuthor]) {
    assert.equal(helper(["ADMIN"]), true, `${helper.name} should keep the admin bypass`);
  }
});

test("a senior engineer may file an incident report; a coordinator may not", () => {
  assert.equal(canReportIncident(SENIOR_ENGINEER), true);
  assert.equal(canReportIncident(STAFF), true);
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
  assert.equal(isMaintenanceOnly([...MAINTENANCE, ...SENIOR_ENGINEER]), false);
  assert.equal(isAdmin(SENIOR_ENGINEER), false);
  assert.equal(isAdmin(["ADMIN"]), true);
});
