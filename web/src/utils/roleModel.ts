// Frontend mirror of the backend role model (backend/app/roles.py).
//
// IMPORTANT: this is for navigation/action GATING only — to avoid showing
// controls a user cannot use. All authority is enforced server-side; never
// rely on these helpers for security.
//
// Seven work roles and the Administrator, one code each. Migration
// 20260923_roles_consolidated moved every account off the earlier codes, and
// nothing here accepts one.

export const ROLES = {
  MAINTENANCE_CREW: "MAINTENANCE_CREW",
  MAINTENANCE_COORDINATOR: "MAINTENANCE_COORDINATOR",
  OFFICE_CHIEF: "OFFICE_CHIEF",
  BRANCH_CHIEF: "BRANCH_CHIEF",
  SENIOR_SPECIALIST: "SENIOR_SPECIALIST",
  STAFF: "STAFF",
  GUEST: "GUEST",
  ADMIN: "ADMIN",
} as const;

export type RoleCode = (typeof ROLES)[keyof typeof ROLES];

/** Every role, in the order they are presented. */
export const ALL_ROLE_NAMES: readonly RoleCode[] = [
  ROLES.MAINTENANCE_CREW,
  ROLES.MAINTENANCE_COORDINATOR,
  ROLES.OFFICE_CHIEF,
  ROLES.BRANCH_CHIEF,
  ROLES.SENIOR_SPECIALIST,
  ROLES.STAFF,
  ROLES.GUEST,
  ROLES.ADMIN,
];

const ROLE_LABELS: Record<RoleCode, string> = {
  MAINTENANCE_CREW: "Maintenance Crew",
  MAINTENANCE_COORDINATOR: "Maintenance Coordinator",
  OFFICE_CHIEF: "Office Chief",
  BRANCH_CHIEF: "Branch Chief",
  SENIOR_SPECIALIST: "Senior Specialist",
  STAFF: "Staff",
  GUEST: "Guest",
  ADMIN: "Administrator",
};

const MAINTENANCE_REPORTING = new Set<string>([ROLES.MAINTENANCE_CREW]);

/**
 * The operational surface. `GUEST` is deliberately absent: the operational
 * switch is state-blind — it grants drafts, queues and in-flight work — so a
 * guest, who may only read approved records, cannot be a member of it without
 * being handed everything (org model design §4.1).
 */
export const OPERATIONAL_ROLE_NAMES = [
  ROLES.MAINTENANCE_COORDINATOR,
  ROLES.OFFICE_CHIEF,
  ROLES.BRANCH_CHIEF,
  ROLES.STAFF,
  ROLES.SENIOR_SPECIALIST,
  ROLES.ADMIN,
] as const;
const OPERATIONAL = new Set<string>(OPERATIONAL_ROLE_NAMES);

/** Read-only roles — the third category, beside operational and maintenance. */
export const PUBLIC_VIEW_ROLE_NAMES = [ROLES.GUEST] as const;
const PUBLIC_VIEW = new Set<string>(PUBLIC_VIEW_ROLE_NAMES);

/**
 * Roles that can have a workflow step waiting on them. Its own list rather than
 * an alias of `OPERATIONAL_ROLE_NAMES`: "may read operational data" and "has a
 * queue" are different questions, and a role added to the first must not
 * silently acquire a queue (org model design §8).
 */
export const WORK_QUEUE_ROLE_NAMES = [
  ROLES.MAINTENANCE_COORDINATOR,
  ROLES.OFFICE_CHIEF,
  ROLES.BRANCH_CHIEF,
  ROLES.STAFF,
  ROLES.SENIOR_SPECIALIST,
  ROLES.ADMIN,
] as const;
const WORK_QUEUE = new Set<string>(WORK_QUEUE_ROLE_NAMES);

/** Everyone who does work in ERIS: operational plus the Maintenance Crew, never the guest. */
export const WORKFORCE_ROLE_NAMES = [...OPERATIONAL_ROLE_NAMES, ROLES.MAINTENANCE_CREW] as const;

/**
 * Route gates that admit the guest.
 *
 * `ASSESSMENT_READ_ROLE_NAMES` is the operational set plus the guest: the
 * Maintenance Crew is refused assessments by the server, so the client must not
 * offer them either. `RECORD_READ_ROLE_NAMES` is every role — it states who may
 * open a single record explicitly, in place of "any account that happens to be
 * signed in".
 */
export const ASSESSMENT_READ_ROLE_NAMES = [...OPERATIONAL_ROLE_NAMES, ROLES.GUEST] as const;
export const RECORD_READ_ROLE_NAMES = [...WORKFORCE_ROLE_NAMES, ROLES.GUEST] as const;

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

/** Holds the Guest role, whatever else the account holds. */
export function isViewer(roles: string[] | undefined): boolean {
  return (roles ?? []).some((r) => PUBLIC_VIEW.has(r));
}

/**
 * Guest and nothing else — the narrowing predicate.
 *
 * A chief who is also a guest keeps their chief access: the most permissive
 * role always wins, so the read-only surface is only ever applied to an
 * account whose ONLY role is Guest. Mirrors the server's `roles.is_public_only`
 * (org model design §4.1).
 */
export function isPublicOnly(roles: string[] | undefined): boolean {
  const set = roles ?? [];
  if (set.some((r) => OPERATIONAL.has(r) || MAINTENANCE_REPORTING.has(r))) return false;
  return set.some((r) => PUBLIC_VIEW.has(r));
}

export function canTriage(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.MAINTENANCE_COORDINATOR);
}

/** Office chief: hand an assessment off to a branch chief (the branch route). */
export function canDelegateBranch(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.OFFICE_CHIEF);
}

/** Office chief: assign a Senior Specialist directly (the Senior Specialist route). */
export function canAssignSeniorSpecialist(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.OFFICE_CHIEF);
}

export function canAssignEngineer(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.BRANCH_CHIEF);
}

export function isStaff(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.STAFF);
}

export function isSeniorSpecialist(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.SENIOR_SPECIALIST);
}

/**
 * Roles that fill a technical assessment: Staff under a branch chief on the
 * branch route and the Senior Specialist on the Senior Specialist route do the
 * same work, so every author affordance is gated on this rather than on Staff
 * alone.
 */
export function isAssessmentAuthor(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.STAFF) || hasRole(roles, ROLES.SENIOR_SPECIALIST);
}

/** Roles that can have workflow steps waiting on them (My Work). */
export function hasWorkQueue(roles: string[] | undefined): boolean {
  return (roles ?? []).some((r) => WORK_QUEUE.has(r));
}

/**
 * Where this account belongs when it lands on "/" — and where a refused route
 * sends it. A guest has no queue and no Home, so their landing is the record
 * they came for (org model design §8).
 */
export function landingPathFor(roles: string[] | undefined): string {
  return hasWorkQueue(roles) ? "/my-work" : "/incidents";
}

/**
 * Roles allowed to file a new incident report — exactly the server's
 * FIELD_REPORTING_ROLES: the Maintenance Crew, Staff and administrators.
 */
export function canReportIncident(roles: string[] | undefined): boolean {
  return isAdmin(roles) || hasRole(roles, ROLES.MAINTENANCE_CREW) || hasRole(roles, ROLES.STAFF);
}
