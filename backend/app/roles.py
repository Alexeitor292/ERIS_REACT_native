"""The ERIS roles — one code per role, no aliases.

Seven work roles, as the owner named them (2026-09-22), plus the system
administrator:

    MAINTENANCE_CREW          Maintenance Crew — files field reports from the
                              road; sees only their own reports.
    MAINTENANCE_COORDINATOR   Maintenance Coordinator — triages field reports
                              for their district.
    OFFICE_CHIEF              Office Chief — routes assessments of their GeoTech
                              office, and reviews the Senior Specialist route.
    BRANCH_CHIEF              Branch Chief — assigns Staff, and reviews the
                              branch route.
    SENIOR_SPECIALIST         Senior Specialist — fills assessments the office
                              chief assigns directly.
    STAFF                     Staff — fills the assessments a branch chief
                              assigns; not all of them are engineers.
    GUEST                     Guest — read-only, APPROVED records only, no
                              workflow anywhere (org model design §4).
    ADMIN                     Administrator — accounts, the org model and
                              configuration; not a workflow role.

Migration 20260923_roles_consolidated moved every account off the earlier codes
(MAINTENANCE, MAINTENANCE_FIELD_WORKER, MAINT_COORDINATOR, GEOTECH_*,
FIELD_WORKER, CALTRANS_VIEWER, REVIEWER) and deleted them. Nothing here accepts
an old code any more: a guard lists exactly the roles it admits.

Authentication may come from Entra ID; roles never do. Who holds which role,
and where they sit in the organization, is assigned in ERIS by an administrator.

Review authority is not a role: it is DERIVED FROM THE ASSESSMENT'S ROUTING
PATH. On the branch route only the branch chief named on that assessment
(``assessments.branch_chief_user_id``) may review; on the Senior Specialist
route only an office chief of that assessment's office may. No assignment row
confers any authority.

Record-level grants sit beside the roles and never widen them: a technical
form's reader and editor grants (``submission_visibility`` /
``submission_editors``) let a named person see or edit that one form.
"""

from __future__ import annotations

MAINTENANCE_CREW = "MAINTENANCE_CREW"
MAINTENANCE_COORDINATOR = "MAINTENANCE_COORDINATOR"
OFFICE_CHIEF = "OFFICE_CHIEF"
BRANCH_CHIEF = "BRANCH_CHIEF"
SENIOR_SPECIALIST = "SENIOR_SPECIALIST"
STAFF = "STAFF"
GUEST = "GUEST"
ADMIN = "ADMIN"

# Every role ERIS knows, in the order they are presented.
ALL_ROLES: tuple[str, ...] = (
    MAINTENANCE_CREW,
    MAINTENANCE_COORDINATOR,
    OFFICE_CHIEF,
    BRANCH_CHIEF,
    SENIOR_SPECIALIST,
    STAFF,
    GUEST,
    ADMIN,
)
ALL_ROLE_NAMES: list[str] = sorted(ALL_ROLES)

ROLE_TITLES: dict[str, str] = {
    MAINTENANCE_CREW: "Maintenance Crew",
    MAINTENANCE_COORDINATOR: "Maintenance Coordinator",
    OFFICE_CHIEF: "Office Chief",
    BRANCH_CHIEF: "Branch Chief",
    SENIOR_SPECIALIST: "Senior Specialist",
    STAFF: "Staff",
    GUEST: "Guest",
    ADMIN: "Administrator",
}

# Field reporting. These users are scoped to their own incident reports and
# reporting views only (narrow visibility).
MAINTENANCE_REPORTING_ROLES: set[str] = {MAINTENANCE_CREW}

# The operational roles: broad read of operational data (incidents,
# assessments, locations, timelines, ...).
OPERATIONAL_ROLES: set[str] = {
    MAINTENANCE_COORDINATOR,
    OFFICE_CHIEF,
    BRANCH_CHIEF,
    STAFF,
    SENIOR_SPECIALIST,
    ADMIN,
}

# Read-only public visibility. A THIRD CATEGORY, deliberately outside
# OPERATIONAL_ROLES: that set is a single flat switch guarding roughly twelve
# endpoint families and it is STATE-BLIND — can_view_submission returns True for
# any operational user and list_submissions returns DRAFT rows to them — so
# adding GUEST there would hand every guest every draft technical form in the
# state (design §4.1). "Approved only" is expressed per handler by
# services/public_visibility.py instead.
PUBLIC_VIEW_ROLES: set[str] = {GUEST}

# Who may file a field report: the crew on the road, Staff, and administrators.
FIELD_REPORTING_ROLES: list[str] = [MAINTENANCE_CREW, STAFF, ADMIN]

# Authorship of the GISA technical form. The Senior Specialist fills the
# assessment form exactly as Staff do (routing v2 decision 1).
GISA_AUTHOR_ROLES: list[str] = [STAFF, SENIOR_SPECIALIST, ADMIN]


def user_role_set(user: dict) -> set[str]:
    return {str(r) for r in (user.get("roles") or [])}


def is_admin(user: dict) -> bool:
    return ADMIN in user_role_set(user)


def has_role(user: dict, role: str) -> bool:
    return role in user_role_set(user)


def has_any_role(user: dict, *roles: str) -> bool:
    return bool(user_role_set(user) & set(roles))


def is_operational_user(user: dict) -> bool:
    """Operational user with broad read access (or admin)."""
    return bool(user_role_set(user) & OPERATIONAL_ROLES)


def is_maintenance_only(user: dict) -> bool:
    """True for users whose only relevant role is Maintenance Crew.

    These users must be scoped to their own reports and must NOT receive broad
    operational visibility. Admins and any operational role override this.
    """
    roles = user_role_set(user)
    if roles & OPERATIONAL_ROLES:
        return False
    return bool(roles & MAINTENANCE_REPORTING_ROLES)


def is_public_viewer(user: dict) -> bool:
    """True if the account holds the Guest role, alone or not."""
    return bool(user_role_set(user) & PUBLIC_VIEW_ROLES)


def is_public_only(user: dict) -> bool:
    """True when Guest is the account's ONLY role — the narrowing predicate.

    Mirrors ``is_maintenance_only``. It answers the composition question
    explicitly: a chief who is ALSO granted Guest keeps full chief access,
    because ``require_roles`` is a union and the most permissive role always
    wins. Every public-visibility narrowing keys on this, never on
    ``is_public_viewer`` (design §4.1).
    """
    roles = user_role_set(user)
    if roles & OPERATIONAL_ROLES or roles & MAINTENANCE_REPORTING_ROLES:
        return False
    return bool(roles & PUBLIC_VIEW_ROLES)
