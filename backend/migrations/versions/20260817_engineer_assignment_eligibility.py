"""Enforce engineer assignment target eligibility at the database boundary.

Revision ID: 20260817_engineer_elig
Revises: 20260813_photo_corr
Create Date: 2026-08-17

An active ENGINEER assignment may target only an active account holding one of:
  * GEOTECH_ENGINEER (canonical)
  * FIELD_WORKER (legacy GeoTech engineer alias)
  * ADMIN

The UI already filters to this set. These triggers make the rule fail-closed for
all write paths, including legacy endpoints and direct application SQL.
"""

from alembic import op

revision = "20260817_engineer_elig"
down_revision = "20260813_photo_corr"
branch_labels = None
depends_on = None


_ELIGIBLE_ROLE_SQL = "('GEOTECH_ENGINEER','FIELD_WORKER','ADMIN')"


def _eligibility_predicate(user_expr: str) -> str:
    return f"""
      EXISTS (
        SELECT 1
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r ON r.id = ur.role_id
        WHERE u.id = {user_expr}
          AND u.is_active = 1
          AND r.name IN {_ELIGIBLE_ROLE_SQL}
      )
    """


def upgrade() -> None:
    # Incident stage assignments are the first mutation in the current engineer
    # assignment flow, so invalid targets fail before incident/assessment state
    # or linked draft ownership changes.
    op.execute("DROP TRIGGER IF EXISTS trg_incident_engineer_elig_bi")
    op.execute(
        f"""
        CREATE TRIGGER trg_incident_engineer_elig_bi
        BEFORE INSERT ON incident_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_stage = 'ENGINEER'
             AND NEW.is_active = 1
             AND NOT ({_eligibility_predicate('NEW.assignee_user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Engineer assignment target must be an active GeoTech engineer or admin';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_incident_engineer_elig_bu")
    op.execute(
        f"""
        CREATE TRIGGER trg_incident_engineer_elig_bu
        BEFORE UPDATE ON incident_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_stage = 'ENGINEER'
             AND NEW.is_active = 1
             AND (
               OLD.assignment_stage <> 'ENGINEER'
               OR OLD.is_active <> 1
               OR NOT (NEW.assignee_user_id <=> OLD.assignee_user_id)
             )
             AND NOT ({_eligibility_predicate('NEW.assignee_user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Engineer assignment target must be an active GeoTech engineer or admin';
          END IF;
        END
        """
    )

    # Assessment-level ENGINEER mirrors must obey the same invariant.
    op.execute("DROP TRIGGER IF EXISTS trg_assessment_assignment_engineer_elig_bi")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_assignment_engineer_elig_bi
        BEFORE INSERT ON assessment_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_role = 'ENGINEER'
             AND NEW.is_active = 1
             AND NOT ({_eligibility_predicate('NEW.user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Assessment engineer target must be an active GeoTech engineer or admin';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_assessment_assignment_engineer_elig_bu")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_assignment_engineer_elig_bu
        BEFORE UPDATE ON assessment_assignments
        FOR EACH ROW
        BEGIN
          IF NEW.assignment_role = 'ENGINEER'
             AND NEW.is_active = 1
             AND (
               OLD.assignment_role <> 'ENGINEER'
               OR OLD.is_active <> 1
               OR NOT (NEW.user_id <=> OLD.user_id)
             )
             AND NOT ({_eligibility_predicate('NEW.user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Assessment engineer target must be an active GeoTech engineer or admin';
          END IF;
        END
        """
    )

    # Keep the denormalized assessments.assigned_engineer_user_id field honest
    # when it is first set or changed. Existing rows are not retroactively
    # rewritten; only future assignment mutations are validated.
    op.execute("DROP TRIGGER IF EXISTS trg_assessment_engineer_elig_bi")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_engineer_elig_bi
        BEFORE INSERT ON assessments
        FOR EACH ROW
        BEGIN
          IF NEW.assigned_engineer_user_id IS NOT NULL
             AND NOT ({_eligibility_predicate('NEW.assigned_engineer_user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Assessment engineer target must be an active GeoTech engineer or admin';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_assessment_engineer_elig_bu")
    op.execute(
        f"""
        CREATE TRIGGER trg_assessment_engineer_elig_bu
        BEFORE UPDATE ON assessments
        FOR EACH ROW
        BEGIN
          IF NEW.assigned_engineer_user_id IS NOT NULL
             AND NOT (NEW.assigned_engineer_user_id <=> OLD.assigned_engineer_user_id)
             AND NOT ({_eligibility_predicate('NEW.assigned_engineer_user_id')})
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Assessment engineer target must be an active GeoTech engineer or admin';
          END IF;
        END
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_assessment_engineer_elig_bu")
    op.execute("DROP TRIGGER IF EXISTS trg_assessment_engineer_elig_bi")
    op.execute("DROP TRIGGER IF EXISTS trg_assessment_assignment_engineer_elig_bu")
    op.execute("DROP TRIGGER IF EXISTS trg_assessment_assignment_engineer_elig_bi")
    op.execute("DROP TRIGGER IF EXISTS trg_incident_engineer_elig_bu")
    op.execute("DROP TRIGGER IF EXISTS trg_incident_engineer_elig_bi")
