// Frontend mirror of the backend role model (app/roles.py).
// For UI gating ONLY — the backend enforces all authority server-side.
//
// Seven work roles and the Administrator, one code each. Migration
// 20260923_roles_consolidated moved every account off the earlier codes, and
// nothing here accepts one.

export const ROLES = {
  MAINTENANCE: "MAINTENANCE",
  OFFICE_CHIEF: "OFFICE_CHIEF",
  BRANCH_CHIEF: "BRANCH_CHIEF",
  SENIOR_SPECIALIST: "SENIOR_SPECIALIST",
  STAFF: "STAFF",
  GUEST: "GUEST",
  ADMIN: "ADMIN",
} as const;

export type RoleCode = (typeof ROLES)[keyof typeof ROLES];

const ROLE_LABELS: Record<RoleCode, string> = {
  MAINTENANCE: "Maintenance",
  OFFICE_CHIEF: "Office Chief",
  BRANCH_CHIEF: "Branch Chief",
  SENIOR_SPECIALIST: "Senior Specialist",
  STAFF: "Staff",
  GUEST: "Guest",
  ADMIN: "Administrator",
};

const MAINTENANCE_REPORTING = new Set<string>([ROLES.MAINTENANCE]);
const OPERATIONAL = new Set<string>([
  ROLES.OFFICE_CHIEF,
  ROLES.BRANCH_CHIEF,
  ROLES.STAFF,
  ROLES.SENIOR_SPECIALIST,
  ROLES.ADMIN,
]);
// GUEST is deliberately NOT in OPERATIONAL: it is a third category, read-only
// over APPROVED records, with no workflow action anywhere. Adding it there
// would hand a read-only account every operational surface (design §4.1).
const PUBLIC_VIEW = new Set<string>([ROLES.GUEST]);

/** The role's name; an unknown code (none should exist) is shown as it is stored. */
export function roleLabel(role: string): string {
  return ROLE_LABELS[role as RoleCode] ?? role;
}

export function hasRole(roles: string[] | undefined, role: RoleCode): boolean {
  return (roles ?? []).includes(role);
}

export function isAdmin(roles: string[] | undefined): boolean {
  return hasRole(roles, ROLES.ADMIN);
}

export function isOperationalUser(roles: string[] | undefined): boolean {
  return (roles ?? []).some((r) => OPERATIONAL.has(r));
}

export function isMaintenanceOnly(roles: string[] | undefined): boolean {
  const set = roles ?? [];
  if (set.some((r) => OPERATIONAL.has(r))) return false;
  return set.some((r) => MAINTENANCE_REPORTING.has(r));
}

/** True if Guest is the account's ONLY role: the most permissive role always wins. */
export function isPublicOnly(roles: string[] | undefined): boolean {
  const set = roles ?? [];
  if (set.some((r) => OPERATIONAL.has(r) || MAINTENANCE_REPORTING.has(r))) return false;
  return set.some((r) => PUBLIC_VIEW.has(r));
}

/** Every role that does work in ERIS — operational plus Maintenance, never the guest. */
export function isWorkforceUser(roles: string[] | undefined): boolean {
  return isOperationalUser(roles) || (roles ?? []).some((r) => MAINTENANCE_REPORTING.has(r));
}

export function canTriage(roles: string[] | undefined): boolean {
  return isAdmin(roles);
}

export function canDelegateBranch(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.OFFICE_CHIEF);
}

/** Branch chief: assign a Staff member (the deployed assign-engineer call). */
export function canAssignEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.BRANCH_CHIEF);
}

/** Staff — the branch route's assignee. */
export function isStaff(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.STAFF);
}

/** The Senior Specialist — the office chief's direct route. */
export function isSeniorSpecialist(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.SENIOR_SPECIALIST);
}

/**
 * Roles that fill a technical assessment: Staff under a branch chief and the
 * Senior Specialist on the direct route do the same work, so every author
 * affordance is gated on this rather than on Staff alone.
 */
export function isAssessmentAuthor(roles: string[] | undefined): boolean {
  return isStaff(roles) || isSeniorSpecialist(roles);
}

/**
 * Roles allowed to file an incident report from the phone — exactly the
 * server's FIELD_REPORTING_ROLES: Staff and
 * administrators.
 */
export function canReportIncident(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.STAFF);
}

export function assessmentStateLabel(state: string): string {
  const map: Record<string, string> = {
    PENDING_OFFICE_DELEGATION: "Pending office delegation",
    PENDING_ENGINEER_ASSIGNMENT: "Pending Staff assignment",
    DRAFT: "Draft",
    SUBMITTED: "Submitted for review",
    REVISION_REQUESTED: "Revision requested",
    APPROVED: "Approved",
    FINALIZED: "Finalized",
  };
  return map[state] ?? state;
}
