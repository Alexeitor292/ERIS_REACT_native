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
  ADMIN: ["ADMIN"],
} as const;

const MAINTENANCE_REPORTING = new Set(["MAINTENANCE_FIELD_WORKER", "MAINTENANCE"]);
export const OPERATIONAL_ROLE_NAMES = [
  ...CANONICAL.MAINTENANCE_COORDINATOR,
  ...CANONICAL.GEOTECH_OFFICE_CHIEF,
  ...CANONICAL.GEOTECH_BRANCH_CHIEF,
  ...CANONICAL.GEOTECH_ENGINEER,
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

export function canDelegateBranch(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_OFFICE_CHIEF");
}

export function canAssignEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_BRANCH_CHIEF");
}

export function canAssignReviewer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_OFFICE_CHIEF") || hasRole(roles, "GEOTECH_BRANCH_CHIEF");
}

export function isEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_ENGINEER");
}

export function canFinalize(roles: string[] | undefined): boolean {
  return canDelegateBranch(roles);
}

/** Roles that can have workflow steps waiting on them (My Work). */
export function hasWorkQueue(roles: string[] | undefined): boolean {
  return isOperationalUser(roles);
}

/** Roles allowed to file a new incident report from the web. */
export function canReportIncident(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "MAINTENANCE_FIELD_WORKER") || hasRole(roles, "GEOTECH_ENGINEER");
}

// Human-readable assessment state label + badge color class.
export function assessmentStateLabel(state: string): string {
  return (
    {
      PENDING_OFFICE_DELEGATION: "Pending office delegation",
      PENDING_ENGINEER_ASSIGNMENT: "Pending engineer assignment",
      DRAFT: "Draft",
      SUBMITTED: "Submitted for review",
      REVISION_REQUESTED: "Revision requested",
      APPROVED: "Approved",
      FINALIZED: "Finalized",
    } as Record<string, string>
  )[state] ?? state;
}
