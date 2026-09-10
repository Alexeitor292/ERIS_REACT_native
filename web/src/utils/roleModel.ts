// Frontend mirror of the backend canonical role model (app/roles.py).
//
// IMPORTANT: this is for navigation/action GATING only — to avoid showing
// controls a user cannot use. All authority is enforced server-side; never
// rely on these helpers for security.

export const CANONICAL = {
  MAINTENANCE_FIELD_WORKER: ["MAINTENANCE_FIELD_WORKER", "MAINTENANCE"],
  MAINTENANCE_COORDINATOR: ["MAINTENANCE_COORDINATOR", "MAINT_COORDINATOR"],
  GEOTECH_OFFICE_CHIEF: ["GEOTECH_OFFICE_CHIEF", "OFFICE_CHIEF"],
  GEOTECH_BRANCH_CHIEF: ["GEOTECH_BRANCH_CHIEF", "BRANCH_CHIEF"],
  GEOTECH_ENGINEER: ["GEOTECH_ENGINEER", "FIELD_WORKER"],
  // Routing v2: the office chief's second route. No legacy alias — the role is
  // new, so an account either holds the canonical name or it is not one.
  GEOTECH_SENIOR_SPECIALIST: ["GEOTECH_SENIOR_SPECIALIST"],
  ADMIN: ["ADMIN"],
} as const;

const MAINTENANCE_REPORTING = new Set(["MAINTENANCE_FIELD_WORKER", "MAINTENANCE"]);
export const OPERATIONAL_ROLE_NAMES = [
  ...CANONICAL.MAINTENANCE_COORDINATOR,
  ...CANONICAL.GEOTECH_OFFICE_CHIEF,
  ...CANONICAL.GEOTECH_BRANCH_CHIEF,
  ...CANONICAL.GEOTECH_ENGINEER,
  ...CANONICAL.GEOTECH_SENIOR_SPECIALIST,
  // Legacy REVIEWER keeps broad operational READ and no review authority.
  "REVIEWER",
  "ADMIN",
] as const;
const OPERATIONAL = new Set<string>(OPERATIONAL_ROLE_NAMES);

export function hasRole(roles: string[] | undefined, canonical: keyof typeof CANONICAL): boolean {
  const set = new Set(roles ?? []);
  return CANONICAL[canonical].some((r) => set.has(r));
}

export function isAdmin(roles: string[] | undefined): boolean {
  return new Set(roles ?? []).has("ADMIN");
}

export function isOperationalUser(roles: string[] | undefined): boolean {
  return (roles ?? []).some((r) => OPERATIONAL.has(r));
}

export function isMaintenanceOnly(roles: string[] | undefined): boolean {
  const set = roles ?? [];
  if (set.some((r) => OPERATIONAL.has(r))) return false;
  return set.some((r) => MAINTENANCE_REPORTING.has(r));
}

export function canTriage(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "MAINTENANCE_COORDINATOR");
}

/** Office chief: hand an assessment off to a branch chief (the branch route). */
export function canDelegateBranch(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_OFFICE_CHIEF");
}

/** Office chief: assign a senior specialist directly (the specialist route). */
export function canAssignSpecialist(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_OFFICE_CHIEF");
}

export function canAssignEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_BRANCH_CHIEF");
}

export function isEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_ENGINEER");
}

export function isSeniorSpecialist(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_SENIOR_SPECIALIST");
}

/**
 * Roles that fill a technical assessment: the staff engineer on the branch
 * route and the senior specialist on the specialist route do the same work,
 * so every author affordance is gated on this rather than on the engineer.
 */
export function isAssessmentAuthor(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_ENGINEER") || hasRole(roles, "GEOTECH_SENIOR_SPECIALIST");
}

/** Roles that can have workflow steps waiting on them (My Work). */
export function hasWorkQueue(roles: string[] | undefined): boolean {
  return isOperationalUser(roles);
}

/** Roles allowed to file a new incident report from the web. */
export function canReportIncident(roles: string[] | undefined): boolean {
  return (
    isAdmin(roles)
    || hasRole(roles, "MAINTENANCE_FIELD_WORKER")
    || hasRole(roles, "GEOTECH_ENGINEER")
    || hasRole(roles, "GEOTECH_SENIOR_SPECIALIST")
  );
}
