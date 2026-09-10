"""Canonical organization roles + backward-compatible legacy aliasing.

ERIS historically seeded these role names (see database/init/020_seed.sql):

    FIELD_WORKER        -- the GeoTech engineer who completes the technical form
    MAINTENANCE         -- the maintenance field worker who reports incidents
    MAINT_COORDINATOR   -- maintenance coordinator (triage)
    OFFICE_CHIEF        -- GeoTech office chief
    BRANCH_CHIEF        -- GeoTech branch chief
    REVIEWER            -- legacy global reviewer role (being retired)
    ADMIN

The Assessment Routing & Authority Model introduces clearer canonical names:

    MAINTENANCE_FIELD_WORKER, MAINTENANCE_COORDINATOR, GEOTECH_OFFICE_CHIEF,
    GEOTECH_BRANCH_CHIEF, GEOTECH_ENGINEER, ADMIN

Routing v2 adds one more, which has NO legacy equivalent because the role is new:

    GEOTECH_SENIOR_SPECIALIST   -- fills assessments the office chief assigns
                                   directly, and reports back to that office chief

We do NOT rename existing roles or remap existing user_roles rows (that would be
a destructive migration). Instead, every canonical role aliases to its legacy
equivalent, and authority checks accept either name. New deployments may assign
the canonical roles; existing deployments keep working unchanged.

Review authority is intentionally NOT a role here, and as of routing v2 it is not
an assignment either: it is DERIVED FROM THE ASSESSMENT'S ROUTING PATH. On the
branch route only the branch chief named on that assessment
(``assessments.branch_chief_user_id``) may review; on the senior-specialist route
only an office chief of that assessment's office may. The legacy "REVIEWER"
account role and ``assessment_assignments`` rows with role REVIEWER/APPROVER no
longer confer any authority — REVIEWER is deprecated, kept only so existing
accounts keep their broad operational READ, and no new grants should be made.
New code must derive review authority from the assessment, never from a role
string or an assignment row.
"""

from __future__ import annotations

# Canonical role names
MAINTENANCE_FIELD_WORKER = "MAINTENANCE_FIELD_WORKER"
MAINTENANCE_COORDINATOR = "MAINTENANCE_COORDINATOR"
GEOTECH_OFFICE_CHIEF = "GEOTECH_OFFICE_CHIEF"
GEOTECH_BRANCH_CHIEF = "GEOTECH_BRANCH_CHIEF"
GEOTECH_ENGINEER = "GEOTECH_ENGINEER"
GEOTECH_SENIOR_SPECIALIST = "GEOTECH_SENIOR_SPECIALIST"
ADMIN = "ADMIN"

# Legacy role names (still present in seeds and existing databases)
LEGACY_MAINTENANCE = "MAINTENANCE"
LEGACY_MAINT_COORDINATOR = "MAINT_COORDINATOR"
LEGACY_OFFICE_CHIEF = "OFFICE_CHIEF"
LEGACY_BRANCH_CHIEF = "BRANCH_CHIEF"
LEGACY_FIELD_WORKER = "FIELD_WORKER"
LEGACY_REVIEWER = "REVIEWER"

# canonical -> set of names that satisfy it (canonical + legacy aliases)
ROLE_ALIASES: dict[str, set[str]] = {
    MAINTENANCE_FIELD_WORKER: {MAINTENANCE_FIELD_WORKER, LEGACY_MAINTENANCE},
    MAINTENANCE_COORDINATOR: {MAINTENANCE_COORDINATOR, LEGACY_MAINT_COORDINATOR},
    GEOTECH_OFFICE_CHIEF: {GEOTECH_OFFICE_CHIEF, LEGACY_OFFICE_CHIEF},
    GEOTECH_BRANCH_CHIEF: {GEOTECH_BRANCH_CHIEF, LEGACY_BRANCH_CHIEF},
    GEOTECH_ENGINEER: {GEOTECH_ENGINEER, LEGACY_FIELD_WORKER},
    # The senior specialist is a new role: it has no legacy alias, because
    # inventing one would make expand_roles() accept a name no database
    # contains.
    GEOTECH_SENIOR_SPECIALIST: {GEOTECH_SENIOR_SPECIALIST},
    ADMIN: {ADMIN},
}

# Maintenance field-reporting roles. These users are scoped to their own
# incident reports and reporting views only (narrow visibility).
MAINTENANCE_REPORTING_ROLES: set[str] = {MAINTENANCE_FIELD_WORKER, LEGACY_MAINTENANCE}

# Non-maintenance operational roles. These users get broad read access to all
# operational data (incidents, assessments, locations, timelines, ...).
OPERATIONAL_ROLES: set[str] = (
    ROLE_ALIASES[MAINTENANCE_COORDINATOR]
    | ROLE_ALIASES[GEOTECH_OFFICE_CHIEF]
    | ROLE_ALIASES[GEOTECH_BRANCH_CHIEF]
    | ROLE_ALIASES[GEOTECH_ENGINEER]
    | ROLE_ALIASES[GEOTECH_SENIOR_SPECIALIST]
    | {LEGACY_REVIEWER, ADMIN}
)


def expand_roles(*canonical: str) -> list[str]:
    """Expand canonical role names into the full set of names (canonical +
    legacy aliases) that satisfy them. Use this when building a require_roles()
    guard so both new and legacy role names are accepted.
    """
    out: set[str] = set()
    for role in canonical:
        out |= ROLE_ALIASES.get(role, {role})
    return sorted(out)


# Authorship of the GISA technical form. The senior specialist fills the
# assessment form exactly as the GeoTech engineer does (routing v2 decision 1),
# so every GISA write guard accepts both — plus ADMIN. Using this list instead of
# a literal ["FIELD_WORKER", "ADMIN"] also unblocks accounts that hold only the
# canonical GEOTECH_ENGINEER name, which could not edit before.
GISA_AUTHOR_ROLES: list[str] = expand_roles(GEOTECH_ENGINEER, GEOTECH_SENIOR_SPECIALIST) + [ADMIN]


def user_role_set(user: dict) -> set[str]:
    return {str(r) for r in (user.get("roles") or [])}


def is_admin(user: dict) -> bool:
    return ADMIN in user_role_set(user)


def has_canonical_role(user: dict, canonical: str) -> bool:
    """True if the user holds the canonical role or any of its legacy aliases."""
    return bool(user_role_set(user) & ROLE_ALIASES.get(canonical, {canonical}))


def has_any_canonical_role(user: dict, *canonical: str) -> bool:
    return any(has_canonical_role(user, role) for role in canonical)


def is_operational_user(user: dict) -> bool:
    """Non-maintenance operational user with broad read access (or admin)."""
    return bool(user_role_set(user) & OPERATIONAL_ROLES)


def is_maintenance_only(user: dict) -> bool:
    """True for users whose only relevant role is maintenance field reporting.

    These users must be scoped to their own reports and must NOT receive broad
    operational visibility. Admins and any operational role override this.
    """
    roles = user_role_set(user)
    if roles & OPERATIONAL_ROLES:
        return False
    return bool(roles & MAINTENANCE_REPORTING_ROLES)
