"""No role without its place: roles come only from the organization.

Revision ID: 20260930_roles_from_org
Revises: 20260929_share_approvals
Create Date: 2026-09-30

Until now somebody who held a GeoTech or maintenance role but sat in no tree
kept the role ("not yet placed"). From here on a person's roles are exactly
what their place gives them, plus Administrator, which is granted directly by
another administrator and needs no place at all:

1. Places that no longer make sense are cleared: branch chiefs and staff with no
   live branch, and anybody placed in an office that does not exist. A branch's
   chief slot is cleared when its chief does not actually sit there as chief.
2. Every account's roles are recomputed: office chief, senior specialist,
   branch chief or staff from its tree position; Maintenance Coordinator and
   Crew from the district lists; Administrator kept; Guest when nothing else.

Nobody is deleted. Somebody who loses a role here is a guest until an
administrator, their office chief or their branch chief places them.

Idempotent: re-running changes nothing.
"""

from alembic import op
from sqlalchemy import text

revision = "20260930_roles_from_org"
down_revision = "20260929_share_approvals"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # 1. Places that no longer make sense.
    bind.execute(
        text(
            """
            UPDATE org_user_profiles p
               LEFT JOIN org_branches b ON b.id = p.branch_id
               SET p.tree_position = NULL, p.branch_id = NULL
             WHERE p.tree_position IN ('BRANCH_CHIEF', 'STAFF')
               AND (p.branch_id IS NULL OR b.id IS NULL OR b.is_active = 0)
            """
        )
    )
    bind.execute(
        text(
            """
            UPDATE org_user_profiles p
               LEFT JOIN org_offices o ON o.id = p.office_id
               SET p.tree_position = NULL, p.branch_id = NULL
             WHERE p.tree_position IS NOT NULL AND (p.office_id IS NULL OR o.id IS NULL)
            """
        )
    )
    bind.execute(
        text(
            """
            UPDATE org_user_profiles SET branch_id = NULL
             WHERE tree_position IN ('OFFICE_CHIEF', 'SENIOR_SPECIALIST') AND branch_id IS NOT NULL
            """
        )
    )
    bind.execute(
        text(
            """
            UPDATE org_branches b
               SET b.chief_user_id = NULL
             WHERE b.chief_user_id IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM org_user_profiles p
                    WHERE p.user_id = b.chief_user_id AND p.branch_id = b.id AND p.tree_position = 'BRANCH_CHIEF')
            """
        )
    )
    # A branch chief whose branch names somebody else as its chief is staff there.
    bind.execute(
        text(
            """
            UPDATE org_user_profiles p JOIN org_branches b ON b.id = p.branch_id
               SET p.tree_position = CASE WHEN b.chief_user_id IS NULL THEN 'BRANCH_CHIEF' ELSE 'STAFF' END
             WHERE p.tree_position = 'BRANCH_CHIEF' AND (b.chief_user_id IS NULL OR b.chief_user_id <> p.user_id)
            """
        )
    )
    bind.execute(
        text(
            """
            UPDATE org_branches b JOIN org_user_profiles p ON p.branch_id = b.id AND p.tree_position = 'BRANCH_CHIEF'
               SET b.chief_user_id = p.user_id
             WHERE b.chief_user_id IS NULL
            """
        )
    )
    # One chief per branch: any other "chief" there is staff.
    bind.execute(
        text(
            """
            UPDATE org_user_profiles p JOIN org_branches b ON b.id = p.branch_id
               SET p.tree_position = 'STAFF'
             WHERE p.tree_position = 'BRANCH_CHIEF' AND b.chief_user_id <> p.user_id
            """
        )
    )

    # 2. Every account's roles, from its places.
    bind.execute(
        text(
            """
            DELETE ur FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE r.name <> 'ADMIN'
            """
        )
    )
    bind.execute(
        text(
            """
            INSERT IGNORE INTO user_roles (user_id, role_id)
            SELECT p.user_id, r.id FROM org_user_profiles p JOIN roles r ON r.name = p.tree_position
             WHERE p.tree_position IN ('OFFICE_CHIEF', 'SENIOR_SPECIALIST', 'BRANCH_CHIEF', 'STAFF')
               AND p.office_id IS NOT NULL
            """
        )
    )
    bind.execute(
        text(
            """
            INSERT IGNORE INTO user_roles (user_id, role_id)
            SELECT DISTINCT c.user_id, r.id FROM org_coordinator_coverage c JOIN roles r ON r.name = 'MAINTENANCE_COORDINATOR'
             WHERE c.is_active = 1
            """
        )
    )
    bind.execute(
        text(
            """
            INSERT IGNORE INTO user_roles (user_id, role_id)
            SELECT DISTINCT c.user_id, r.id FROM org_district_crew c JOIN roles r ON r.name = 'MAINTENANCE_CREW'
             WHERE c.is_active = 1
            """
        )
    )
    bind.execute(
        text(
            """
            INSERT IGNORE INTO user_roles (user_id, role_id)
            SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'GUEST'
             WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)
            """
        )
    )


def downgrade() -> None:
    # The roles people held without a place are not recorded; nothing to restore.
    pass
