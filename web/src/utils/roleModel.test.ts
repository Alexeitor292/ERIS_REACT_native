import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_ROLE_NAMES,
  ASSESSMENT_READ_ROLE_NAMES,
  OPERATIONAL_ROLE_NAMES,
  RECORD_READ_ROLE_NAMES,
  ROLES,
  WORKFORCE_ROLE_NAMES,
  WORK_QUEUE_ROLE_NAMES,
  canAssignEngineer,
  canAssignSeniorSpecialist,
  canDelegateBranch,
  canReportIncident,
  canTriage,
  hasRole,
  hasWorkQueue,
  isAdmin,
  isAssessmentAuthor,
  isMaintenanceOnly,
  isOperationalUser,
  isPublicOnly,
  isSeniorSpecialist,
  isStaff,
  isViewer,
  landingPathFor,
  roleLabel,
} from "./roleModel.ts";

const CREW = ["MAINTENANCE_CREW"];
const COORDINATOR = ["MAINTENANCE_COORDINATOR"];
const OFFICE_CHIEF = ["OFFICE_CHIEF"];
const BRANCH_CHIEF = ["BRANCH_CHIEF"];
const SENIOR_SPECIALIST = ["SENIOR_SPECIALIST"];
const STAFF = ["STAFF"];
const GUEST = ["GUEST"];

const RETIRED = [
  "MAINTENANCE", "MAINTENANCE_FIELD_WORKER", "MAINT_COORDINATOR", "GEOTECH_OFFICE_CHIEF",
  "GEOTECH_BRANCH_CHIEF", "GEOTECH_ENGINEER", "GEOTECH_SENIOR_ENGINEER", "FIELD_WORKER",
  "CALTRANS_VIEWER", "REVIEWER",
];

test("the role set is the owner's seven roles and the Administrator, one code each", () => {
  assert.deepEqual([...ALL_ROLE_NAMES].sort(), [
    "ADMIN", "BRANCH_CHIEF", "GUEST", "MAINTENANCE_COORDINATOR", "MAINTENANCE_CREW",
    "OFFICE_CHIEF", "SENIOR_SPECIALIST", "STAFF",
  ]);
  assert.deepEqual(ALL_ROLE_NAMES.map(roleLabel), [
    "Maintenance Crew", "Maintenance Coordinator", "Office Chief", "Branch Chief",
    "Senior Specialist", "Staff", "Guest", "Administrator",
  ]);
});

test("no label calls Staff or the Senior Specialist an engineer", () => {
  for (const code of ALL_ROLE_NAMES) assert.doesNotMatch(roleLabel(code), /engineer/i, code);
});

test("a retired code grants nothing anywhere", () => {
  for (const code of RETIRED) {
    const roles = [code];
    assert.equal(isOperationalUser(roles), false, code);
    assert.equal(isMaintenanceOnly(roles), false, code);
    assert.equal(isViewer(roles), false, code);
    assert.equal(hasWorkQueue(roles), false, code);
    for (const helper of [canTriage, canDelegateBranch, canAssignSeniorSpecialist, canAssignEngineer, isAssessmentAuthor, canReportIncident, isAdmin]) {
      assert.equal(helper(roles), false, `${helper.name}(${code})`);
    }
    for (const gate of [OPERATIONAL_ROLE_NAMES, WORK_QUEUE_ROLE_NAMES, WORKFORCE_ROLE_NAMES, ASSESSMENT_READ_ROLE_NAMES, RECORD_READ_ROLE_NAMES]) {
      assert.equal((gate as readonly string[]).includes(code), false, code);
    }
    // Shown as stored, never dressed up as a real role.
    assert.equal(roleLabel(code), code);
  }
});

test("the Senior Specialist is operational, has a queue, and is not Staff", () => {
  assert.equal(isOperationalUser(SENIOR_SPECIALIST), true);
  assert.equal(isMaintenanceOnly(SENIOR_SPECIALIST), false);
  assert.equal(hasWorkQueue(SENIOR_SPECIALIST), true);
  assert.equal(hasRole(SENIOR_SPECIALIST, ROLES.SENIOR_SPECIALIST), true);
  assert.equal(hasRole(STAFF, ROLES.SENIOR_SPECIALIST), false);
  assert.equal(isStaff(SENIOR_SPECIALIST), false);
  assert.equal(isSeniorSpecialist(STAFF), false);
  assert.equal(isSeniorSpecialist(SENIOR_SPECIALIST), true);
});

test("assessment authors are Staff, the Senior Specialist and admin", () => {
  assert.equal(isAssessmentAuthor(STAFF), true);
  assert.equal(isAssessmentAuthor(SENIOR_SPECIALIST), true);
  assert.equal(isAssessmentAuthor(["ADMIN"]), true);
  assert.equal(isAssessmentAuthor(OFFICE_CHIEF), false);
  assert.equal(isAssessmentAuthor(BRANCH_CHIEF), false);
  assert.equal(isAssessmentAuthor(COORDINATOR), false);
  assert.equal(isAssessmentAuthor(undefined), false);
});

test("both routing choices belong to the office chief and admin", () => {
  assert.equal(canDelegateBranch(OFFICE_CHIEF), true);
  assert.equal(canAssignSeniorSpecialist(OFFICE_CHIEF), true);
  assert.equal(canAssignSeniorSpecialist(BRANCH_CHIEF), false);
  assert.equal(canAssignSeniorSpecialist(SENIOR_SPECIALIST), false);
  assert.equal(canAssignEngineer(BRANCH_CHIEF), true);
  assert.equal(canAssignEngineer(OFFICE_CHIEF), false);
  for (const helper of [canDelegateBranch, canAssignSeniorSpecialist, canAssignEngineer, canTriage, isAssessmentAuthor]) {
    assert.equal(helper(["ADMIN"]), true, `${helper.name} should keep the admin bypass`);
  }
});

test("field reports are filed by the crew, Staff and administrators — as the server allows", () => {
  assert.equal(canReportIncident(CREW), true);
  assert.equal(canReportIncident(STAFF), true);
  assert.equal(canReportIncident(["ADMIN"]), true);
  assert.equal(canReportIncident(SENIOR_SPECIALIST), false);
  assert.equal(canReportIncident(COORDINATOR), false);
  assert.equal(canReportIncident(OFFICE_CHIEF), false);
  assert.equal(canReportIncident(BRANCH_CHIEF), false);
  assert.equal(canReportIncident(GUEST), false);
});

test("the Guest is a third category and never an operational role", () => {
  // The operational switch is state-blind — it grants drafts and queues — so a
  // read-only guest inside it would be handed every in-flight record.
  assert.equal((OPERATIONAL_ROLE_NAMES as readonly string[]).includes("GUEST"), false);
  assert.equal((WORK_QUEUE_ROLE_NAMES as readonly string[]).includes("GUEST"), false);
  assert.equal((WORKFORCE_ROLE_NAMES as readonly string[]).includes("GUEST"), false);

  assert.equal(isOperationalUser(GUEST), false);
  assert.equal(isMaintenanceOnly(GUEST), false);
  assert.equal(hasWorkQueue(GUEST), false);
  assert.equal(isViewer(GUEST), true);
  assert.equal(isPublicOnly(GUEST), true);
  assert.equal(landingPathFor(GUEST), "/incidents");

  for (const helper of [canTriage, canDelegateBranch, canAssignSeniorSpecialist, canAssignEngineer, isAssessmentAuthor, canReportIncident, isAdmin]) {
    assert.equal(helper(GUEST), false, `${helper.name} should be closed to a guest`);
  }
});

test("a guest who also holds an operational role keeps that role's access", () => {
  const chiefAndGuest = [...OFFICE_CHIEF, ...GUEST];
  assert.equal(isPublicOnly(chiefAndGuest), false);
  assert.equal(isViewer(chiefAndGuest), true);
  assert.equal(isOperationalUser(chiefAndGuest), true);
  assert.equal(hasWorkQueue(chiefAndGuest), true);
  assert.equal(canDelegateBranch(chiefAndGuest), true);
  assert.equal(landingPathFor(chiefAndGuest), "/my-work");
  // A crew member who is also a guest is likewise not narrowed to the public record.
  assert.equal(isPublicOnly([...CREW, ...GUEST]), false);
  assert.equal(isPublicOnly([]), false);
  assert.equal(isPublicOnly(undefined), false);
});

test("the record route gates admit the guest and the operational surface does not", () => {
  const admits = (names: readonly string[], roles: string[]) => roles.some((role) => names.includes(role));
  assert.equal(admits(ASSESSMENT_READ_ROLE_NAMES, GUEST), true);
  assert.equal(admits(RECORD_READ_ROLE_NAMES, GUEST), true);
  assert.equal(admits(OPERATIONAL_ROLE_NAMES, GUEST), false);
  assert.equal(admits(WORK_QUEUE_ROLE_NAMES, GUEST), false);
  assert.equal(admits(WORKFORCE_ROLE_NAMES, GUEST), false);
  // The crew reaches a record but not an assessment: the server refuses them
  // assessments, so the client must not offer them either.
  assert.equal(admits(RECORD_READ_ROLE_NAMES, CREW), true);
  assert.equal(admits(ASSESSMENT_READ_ROLE_NAMES, CREW), false);
  assert.equal(admits(ASSESSMENT_READ_ROLE_NAMES, STAFF), true);
});

test("the Maintenance Crew stays out of the operational surface", () => {
  assert.equal(isMaintenanceOnly(CREW), true);
  assert.equal(isOperationalUser(CREW), false);
  assert.equal(isMaintenanceOnly([...CREW, ...SENIOR_SPECIALIST]), false);
  assert.equal(isAdmin(SENIOR_SPECIALIST), false);
  assert.equal(isAdmin(["ADMIN"]), true);
});
