// Frontend mirror of the backend canonical role model (app/roles.py).
// For UI gating ONLY — the backend enforces all authority server-side.
//
// Every predicate here tests CANONICAL role names through the alias map below,
// never a raw legacy string. An account seeded by the organization model holds
// only the canonical name (GEOTECH_ENGINEER, MAINTENANCE_FIELD_WORKER, ...), so
// a gate written against "FIELD_WORKER" or "MAINTENANCE" hides tabs and actions
// from the very people who own the work (design §9.2).

export const CANONICAL = {
  MAINTENANCE_FIELD_WORKER: ["MAINTENANCE_FIELD_WORKER", "MAINTENANCE"],
  MAINTENANCE_COORDINATOR: ["MAINTENANCE_COORDINATOR", "MAINT_COORDINATOR"],
  GEOTECH_OFFICE_CHIEF: ["GEOTECH_OFFICE_CHIEF", "OFFICE_CHIEF"],
  GEOTECH_BRANCH_CHIEF: ["GEOTECH_BRANCH_CHIEF", "BRANCH_CHIEF"],
  // Labelled "Staff": the codes are deployed and stored, the name is not.
  GEOTECH_ENGINEER: ["GEOTECH_ENGINEER", "FIELD_WORKER"],
  // Routing v2 and the organization model each add one role with NO legacy
  // alias: an account either holds the canonical name or it is not one.
  GEOTECH_SENIOR_ENGINEER: ["GEOTECH_SENIOR_ENGINEER"],
  CALTRANS_VIEWER: ["CALTRANS_VIEWER"],
  ADMIN: ["ADMIN"],
} as const;

const MAINTENANCE_REPORTING: string[] = [...CANONICAL.MAINTENANCE_FIELD_WORKER];
const OPERATIONAL: string[] = [
  ...CANONICAL.MAINTENANCE_COORDINATOR,
  ...CANONICAL.GEOTECH_OFFICE_CHIEF,
  ...CANONICAL.GEOTECH_BRANCH_CHIEF,
  ...CANONICAL.GEOTECH_ENGINEER,
  ...CANONICAL.GEOTECH_SENIOR_ENGINEER,
  // Legacy REVIEWER keeps broad operational READ and no review authority.
  "REVIEWER",
  "ADMIN",
];
// CALTRANS_VIEWER is deliberately NOT in OPERATIONAL: it is a third category,
// read-only over APPROVED records, with no workflow action anywhere. Adding it
// there would hand a read-only account every operational surface (design §4.1).

function any(roles: string[] | undefined, names: string[]): boolean {
  const set = new Set(roles ?? []);
  return names.some((n) => set.has(n));
}

/** True if the account holds the canonical role or any of its legacy aliases. */
export function hasRole(roles: string[] | undefined, canonical: keyof typeof CANONICAL): boolean {
  return any(roles, [...CANONICAL[canonical]]);
}

export function isAdmin(roles: string[] | undefined): boolean {
  return new Set(roles ?? []).has("ADMIN");
}

export function isOperationalUser(roles: string[] | undefined): boolean {
  return any(roles, OPERATIONAL);
}

export function isMaintenanceOnly(roles: string[] | undefined): boolean {
  if (any(roles, OPERATIONAL)) return false;
  return any(roles, MAINTENANCE_REPORTING);
}

/** True if the read-only Viewer role is the account's ONLY role. */
export function isPublicOnly(roles: string[] | undefined): boolean {
  if (any(roles, OPERATIONAL) || any(roles, MAINTENANCE_REPORTING)) return false;
  return hasRole(roles, "CALTRANS_VIEWER");
}

export function canTriage(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "MAINTENANCE_COORDINATOR");
}

export function canDelegateBranch(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_OFFICE_CHIEF");
}

/** Branch chief: assign a Staff member (the deployed assign-engineer call). */
export function canAssignEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_BRANCH_CHIEF");
}

/** GeoTech Staff — the branch route's assignee. */
export function isEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_ENGINEER");
}

/** The senior engineer — the office chief's direct route. */
export function isSeniorEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_SENIOR_ENGINEER");
}

/**
 * Roles that fill a technical assessment: the Staff member under a branch chief
 * and the senior engineer on the direct route do the same work, so every author
 * affordance is gated on this rather than on Staff alone.
 */
export function isAssessmentAuthor(roles: string[] | undefined): boolean {
  return isEngineer(roles) || isSeniorEngineer(roles);
}

/**
 * Roles allowed to file an incident report from the phone — the Create tab and
 * the incident form behind it.
 *
 * GEOTECH_SENIOR_ENGINEER is deliberately absent, unlike web's twin: mobile has
 * never offered a senior engineer the Create tab, and ``POST /incidents`` does
 * not accept the role either. This is a canonical-name FIX, not a widening.
 */
export function canReportIncident(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "MAINTENANCE_FIELD_WORKER") || hasRole(roles, "GEOTECH_ENGINEER");
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
