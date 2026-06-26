// Frontend mirror of the backend canonical role model (app/roles.py).
// For UI gating ONLY — the backend enforces all authority server-side.

const MAINTENANCE_REPORTING = ["MAINTENANCE_FIELD_WORKER", "MAINTENANCE"];
const OPERATIONAL = [
  "MAINTENANCE_COORDINATOR",
  "MAINT_COORDINATOR",
  "GEOTECH_OFFICE_CHIEF",
  "OFFICE_CHIEF",
  "GEOTECH_BRANCH_CHIEF",
  "BRANCH_CHIEF",
  "GEOTECH_ENGINEER",
  "FIELD_WORKER",
  "REVIEWER",
  "ADMIN",
];

function any(roles: string[] | undefined, names: string[]): boolean {
  const set = new Set(roles ?? []);
  return names.some((n) => set.has(n));
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

export function canTriage(roles: string[] | undefined): boolean {
  return isAdmin(roles) || any(roles, ["MAINTENANCE_COORDINATOR", "MAINT_COORDINATOR"]);
}

export function canDelegateBranch(roles: string[] | undefined): boolean {
  return isAdmin(roles) || any(roles, ["GEOTECH_OFFICE_CHIEF", "OFFICE_CHIEF"]);
}

export function canAssignEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || any(roles, ["GEOTECH_BRANCH_CHIEF", "BRANCH_CHIEF"]);
}

export function assessmentStateLabel(state: string): string {
  const map: Record<string, string> = {
    PENDING_OFFICE_DELEGATION: "Pending office delegation",
    PENDING_ENGINEER_ASSIGNMENT: "Pending engineer assignment",
    DRAFT: "Draft",
    SUBMITTED: "Submitted for review",
    REVISION_REQUESTED: "Revision requested",
    APPROVED: "Approved",
    FINALIZED: "Finalized",
  };
  return map[state] ?? state;
}
