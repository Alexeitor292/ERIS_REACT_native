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
  // "Staff" in every label: the code is deployed and stored, the name is not.
  GEOTECH_ENGINEER: ["GEOTECH_ENGINEER", "FIELD_WORKER"],
  // Routing v2: the office chief's second route. No legacy alias — the role is
  // new, so an account either holds the canonical name or it is not one.
  GEOTECH_SENIOR_ENGINEER: ["GEOTECH_SENIOR_ENGINEER"],
  // Org model: read-only access to APPROVED records, for everyone else in
  // Caltrans. No legacy alias, for the same reason the senior engineer has
  // none, and deliberately NOT an operational role — see OPERATIONAL_ROLE_NAMES.
  CALTRANS_VIEWER: ["CALTRANS_VIEWER"],
  ADMIN: ["ADMIN"],
} as const;

const MAINTENANCE_REPORTING = new Set(["MAINTENANCE_FIELD_WORKER", "MAINTENANCE"]);

/**
 * The operational surface. `CALTRANS_VIEWER` is deliberately absent: the
 * operational switch is state-blind — it grants drafts, queues and in-flight
 * work — so a viewer, who may only read approved records, cannot be a member of
 * it without being handed everything (org model design §4.1).
 */
export const OPERATIONAL_ROLE_NAMES = [
  ...CANONICAL.MAINTENANCE_COORDINATOR,
  ...CANONICAL.GEOTECH_OFFICE_CHIEF,
  ...CANONICAL.GEOTECH_BRANCH_CHIEF,
  ...CANONICAL.GEOTECH_ENGINEER,
  ...CANONICAL.GEOTECH_SENIOR_ENGINEER,
  // Legacy REVIEWER keeps broad operational READ and no review authority.
  "REVIEWER",
  "ADMIN",
] as const;
const OPERATIONAL = new Set<string>(OPERATIONAL_ROLE_NAMES);

/** Read-only viewer roles — the third category, beside operational and maintenance. */
export const PUBLIC_VIEW_ROLE_NAMES = [...CANONICAL.CALTRANS_VIEWER] as const;
const PUBLIC_VIEW = new Set<string>(PUBLIC_VIEW_ROLE_NAMES);

/**
 * Roles that can have a workflow step waiting on them. Its own list rather than
 * an alias of `OPERATIONAL_ROLE_NAMES`: "may read operational data" and "has a
 * queue" are different questions, and a role added to the first must not
 * silently acquire a queue (org model design §8).
 */
export const WORK_QUEUE_ROLE_NAMES = [
  ...CANONICAL.MAINTENANCE_COORDINATOR,
  ...CANONICAL.GEOTECH_OFFICE_CHIEF,
  ...CANONICAL.GEOTECH_BRANCH_CHIEF,
  ...CANONICAL.GEOTECH_ENGINEER,
  ...CANONICAL.GEOTECH_SENIOR_ENGINEER,
  "REVIEWER",
  "ADMIN",
] as const;
const WORK_QUEUE = new Set<string>(WORK_QUEUE_ROLE_NAMES);

/** Everyone who does work in ERIS: operational plus the maintenance reporter, never the viewer. */
export const WORKFORCE_ROLE_NAMES = [
  ...OPERATIONAL_ROLE_NAMES,
  ...CANONICAL.MAINTENANCE_FIELD_WORKER,
] as const;

/**
 * Route gates that admit the read-only viewer.
 *
 * `ASSESSMENT_READ_ROLE_NAMES` is the operational set plus the viewer: a
 * maintenance reporter is refused assessments by the server, so the client must
 * not offer them either. `RECORD_READ_ROLE_NAMES` is every known role — it
 * states who may open a single record explicitly, in place of "any account that
 * happens to be signed in".
 */
export const ASSESSMENT_READ_ROLE_NAMES = [
  ...OPERATIONAL_ROLE_NAMES,
  ...CANONICAL.CALTRANS_VIEWER,
] as const;
export const RECORD_READ_ROLE_NAMES = [
  ...WORKFORCE_ROLE_NAMES,
  ...CANONICAL.CALTRANS_VIEWER,
] as const;

/**
 * Canonical role labels, written out rather than title-cased: the title-caser
 * turns GEOTECH_* into "Geotech", which is not how the roles are named. The
 * codes are the deployed contract — GEOTECH_ENGINEER and its FIELD_WORKER alias
 * are the Staff role's stored codes — so only these labels carry the names.
 */
const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrator",
  MAINTENANCE_FIELD_WORKER: "Maintenance Field Worker",
  MAINTENANCE_COORDINATOR: "Maintenance Coordinator",
  GEOTECH_OFFICE_CHIEF: "GeoTech Office Chief",
  GEOTECH_BRANCH_CHIEF: "GeoTech Branch Chief",
  GEOTECH_ENGINEER: "GeoTech Staff",
  GEOTECH_SENIOR_ENGINEER: "GeoTech Senior Engineer",
  CALTRANS_VIEWER: "Viewer",
  // Legacy aliases and the retired reviewer role, kept for existing accounts.
  MAINTENANCE: "Maintenance Field Worker (legacy)",
  MAINT_COORDINATOR: "Maintenance Coordinator (legacy)",
  OFFICE_CHIEF: "GeoTech Office Chief (legacy)",
  BRANCH_CHIEF: "GeoTech Branch Chief (legacy)",
  FIELD_WORKER: "GeoTech Staff (legacy)",
  REVIEWER: "Reviewer (legacy — no review authority)",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

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

/** Holds the read-only viewer role, whatever else the account holds. */
export function isViewer(roles: string[] | undefined): boolean {
  return (roles ?? []).some((r) => PUBLIC_VIEW.has(r));
}

/**
 * Viewer and nothing else — the narrowing predicate.
 *
 * A chief who is also granted Viewer keeps their chief access: the most
 * permissive role always wins, so the read-only surface is only ever applied to
 * an account whose ONLY role is the viewer. Mirrors the server's
 * `roles.is_public_only` (org model design §4.1).
 */
export function isPublicOnly(roles: string[] | undefined): boolean {
  const set = roles ?? [];
  if (set.some((r) => OPERATIONAL.has(r) || MAINTENANCE_REPORTING.has(r))) return false;
  return set.some((r) => PUBLIC_VIEW.has(r));
}

export function canTriage(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "MAINTENANCE_COORDINATOR");
}

/** Office chief: hand an assessment off to a branch chief (the branch route). */
export function canDelegateBranch(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_OFFICE_CHIEF");
}

/** Office chief: assign a senior engineer directly (the senior engineer route). */
export function canAssignSeniorEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_OFFICE_CHIEF");
}

export function canAssignEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_BRANCH_CHIEF");
}

export function isEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_ENGINEER");
}

export function isSeniorEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_SENIOR_ENGINEER");
}

/**
 * Roles that fill a technical assessment: the Staff member under a branch chief
 * on the branch route and the senior engineer on the senior engineer route do
 * the same work, so every author affordance is gated on this rather than on
 * Staff alone.
 */
export function isAssessmentAuthor(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, "GEOTECH_ENGINEER") || hasRole(roles, "GEOTECH_SENIOR_ENGINEER");
}

/** Roles that can have workflow steps waiting on them (My Work). */
export function hasWorkQueue(roles: string[] | undefined): boolean {
  return (roles ?? []).some((r) => WORK_QUEUE.has(r));
}

/**
 * Where this account belongs when it lands on "/" — and where a refused route
 * sends it. A viewer has no queue and no Home, so their landing is the record
 * they came for (org model design §8).
 */
export function landingPathFor(roles: string[] | undefined): string {
  return hasWorkQueue(roles) ? "/my-work" : "/incidents";
}

/** Roles allowed to file a new incident report from the web. */
export function canReportIncident(roles: string[] | undefined): boolean {
  return (
    isAdmin(roles)
    || hasRole(roles, "MAINTENANCE_FIELD_WORKER")
    || hasRole(roles, "GEOTECH_ENGINEER")
    || hasRole(roles, "GEOTECH_SENIOR_ENGINEER")
  );
}
