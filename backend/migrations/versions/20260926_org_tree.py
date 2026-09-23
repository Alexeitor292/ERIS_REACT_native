"""Roles come from where a person sits: the office trees and the district lists.

Revision ID: 20260926_org_tree
Revises: 20260925_gisa_rich_memos
Create Date: 2026-09-26

Organization is edited as one tree per GeoTech office (office chief at the top;
senior specialists and branches under them; staff under each branch) and, for
maintenance, one list of coordinators and one of crew per district. A person's
work roles are derived from those places (services/org_tree.py); ADMIN is the
only role granted directly, and anybody placed nowhere is a Guest.

This migration:
1. adds ``org_user_profiles.tree_position`` (OFFICE_CHIEF, SENIOR_SPECIALIST,
   BRANCH_CHIEF or STAFF), the person's place in their office's tree;
2. adds ``org_district_crew``, the maintenance crew listed under each district
   (coordinators keep living in ``org_coordinator_coverage``);
3. places everybody who already holds a role, so nobody's access changes on
   deploy: GeoTech role holders into their office's tree (profile office, else
   the office code on the account), coordinators and crew into their home
   district. Somebody who cannot be placed (no office or district known) keeps
   their roles and is listed on the organization page as not yet placed.

Idempotent: re-running changes nothing.
"""

from alembic import op
from sqlalchemy import text

revision = "20260926_org_tree"
down_revision = "20260925_gisa_rich_memos"
branch_labels = None
depends_on = None

POSITIONS = ("OFFICE_CHIEF", "SENIOR_SPECIALIST", "BRANCH_CHIEF", "STAFF")


def _scalar(sql: str, **params):
    return op.get_bind().execute(text(sql), params).scalar()


def _has_column(table: str, column: str) -> bool:
    return bool(_scalar(
        "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() "
        "AND TABLE_NAME = :t AND COLUMN_NAME = :c", t=table, c=column,
    ))


def _has_constraint(table: str, name: str) -> bool:
    return bool(_scalar(
        "SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() "
        "AND TABLE_NAME = :t AND CONSTRAINT_NAME = :n", t=table, n=name,
    ))


# The office a person belongs to: the profile's, else the office code on the account.
EFFECTIVE_OFFICE_SQL = """
  COALESCE(
    p.office_id,
    (SELECT o.id FROM org_offices o
      WHERE o.org_type = 'GEOTECH'
        AND o.code = NULLIF(UPPER(TRIM(COALESCE(JSON_VALUE(u.metadata_json, '$.office_code'), ''))), '')
      LIMIT 1)
  )
"""

# The district a person belongs to: the profile's, else the district on the account.
EFFECTIVE_DISTRICT_SQL = """
  COALESCE(
    NULLIF(TRIM(p.home_district), ''),
    NULLIF(LPAD(TRIM(COALESCE(JSON_VALUE(u.metadata_json, '$.district'), '')), 2, '0'), '00')
  )
"""


def _has_role(role: str) -> str:
    return (
        "EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id "
        f"WHERE ur.user_id = u.id AND r.name = '{role}')"
    )


def upgrade() -> None:
    if not _has_column("org_user_profiles", "tree_position"):
        op.execute("ALTER TABLE org_user_profiles ADD COLUMN tree_position VARCHAR(24) NULL AFTER branch_id")
    if not _has_constraint("org_user_profiles", "chk_org_profile_tree_position"):
        op.execute(
            "ALTER TABLE org_user_profiles ADD CONSTRAINT chk_org_profile_tree_position "
            "CHECK (tree_position IS NULL OR tree_position IN ('OFFICE_CHIEF','SENIOR_SPECIALIST','BRANCH_CHIEF','STAFF'))"
        )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_district_crew (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          district CHAR(2) NOT NULL,
          user_id BIGINT NOT NULL,
          is_active TINYINT NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_org_crew_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY uk_org_crew (district, user_id),
          INDEX idx_org_crew_user (user_id, is_active)
        ) ENGINE=InnoDB
        """
    )

    # Everybody gets a profile row, so placement is always an UPDATE.
    op.execute("INSERT IGNORE INTO org_user_profiles (user_id, source) SELECT id, 'MANUAL' FROM users")

    # Branch chiefs named on an active branch sit at that branch.
    op.execute(
        f"""
        UPDATE org_user_profiles p
          JOIN users u ON u.id = p.user_id
          JOIN org_branches b ON b.chief_user_id = u.id AND b.is_active = 1
           SET p.tree_position = 'BRANCH_CHIEF', p.branch_id = b.id, p.office_id = b.office_id
         WHERE u.is_active = 1 AND p.tree_position IS NULL AND {_has_role('BRANCH_CHIEF')}
        """
    )
    # Everybody else with a GeoTech role sits in their office, highest role first.
    for position in POSITIONS:
        op.execute(
            f"""
            UPDATE org_user_profiles p
              JOIN users u ON u.id = p.user_id
               SET p.office_id = {EFFECTIVE_OFFICE_SQL},
                   p.tree_position = '{position}'
             WHERE u.is_active = 1
               AND p.tree_position IS NULL
               AND {_has_role(position)}
               AND {EFFECTIVE_OFFICE_SQL} IS NOT NULL
            """
        )
    # Only staff and branch chiefs belong to a branch, and only one of their own office.
    op.execute(
        """
        UPDATE org_user_profiles p
          LEFT JOIN org_branches b ON b.id = p.branch_id
           SET p.branch_id = NULL
         WHERE p.branch_id IS NOT NULL
           AND (p.tree_position IS NULL OR p.tree_position IN ('OFFICE_CHIEF','SENIOR_SPECIALIST')
                OR b.id IS NULL OR b.office_id <> p.office_id)
        """
    )

    # Coordinators with no active coverage cover their home district.
    op.execute(
        f"""
        INSERT IGNORE INTO org_coordinator_coverage (district, user_id, is_primary, is_active)
        SELECT {EFFECTIVE_DISTRICT_SQL}, u.id, 0, 1
          FROM users u
          LEFT JOIN org_user_profiles p ON p.user_id = u.id
         WHERE u.is_active = 1
           AND {_has_role('MAINTENANCE_COORDINATOR')}
           AND NOT EXISTS (SELECT 1 FROM org_coordinator_coverage c WHERE c.user_id = u.id AND c.is_active = 1)
           AND {EFFECTIVE_DISTRICT_SQL} IS NOT NULL
        """
    )
    # Crew are listed under their home district.
    op.execute(
        f"""
        INSERT IGNORE INTO org_district_crew (district, user_id, is_active)
        SELECT {EFFECTIVE_DISTRICT_SQL}, u.id, 1
          FROM users u
          LEFT JOIN org_user_profiles p ON p.user_id = u.id
         WHERE u.is_active = 1
           AND {_has_role('MAINTENANCE_CREW')}
           AND {EFFECTIVE_DISTRICT_SQL} IS NOT NULL
        """
    )


def downgrade() -> None:
    # Lossy: the tree positions and the crew lists go. Roles already granted stay.
    op.execute("DROP TABLE IF EXISTS org_district_crew")
    if _has_constraint("org_user_profiles", "chk_org_profile_tree_position"):
        op.execute("ALTER TABLE org_user_profiles DROP CONSTRAINT chk_org_profile_tree_position")
    if _has_column("org_user_profiles", "tree_position"):
        op.execute("ALTER TABLE org_user_profiles DROP COLUMN tree_position")
