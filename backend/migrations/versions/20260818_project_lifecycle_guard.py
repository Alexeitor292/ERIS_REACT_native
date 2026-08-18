"""Enforce Project lifecycle invariants at the database boundary.

Revision ID: 20260818_project_lifecycle
Revises: 20260817_project_domain
Create Date: 2026-08-18

Application checks provide useful 409 responses, but these triggers make the
rules race-safe for every write path:
- an Incident may only be newly associated with an OPEN Project
- a Project may not transition to CLOSED while it has active Incidents
"""

from alembic import op

revision = "20260818_project_lifecycle"
down_revision = "20260817_project_domain"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_incident_project_open_bi")
    op.execute(
        """
        CREATE TRIGGER trg_incident_project_open_bi
        BEFORE INSERT ON incidents
        FOR EACH ROW
        BEGIN
          IF NEW.project_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM projects p
               WHERE p.id = NEW.project_id AND p.status = 'OPEN'
             )
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident may only be associated with an open Project';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_incident_project_open_bu")
    op.execute(
        """
        CREATE TRIGGER trg_incident_project_open_bu
        BEFORE UPDATE ON incidents
        FOR EACH ROW
        BEGIN
          IF NOT (NEW.project_id <=> OLD.project_id)
             AND NEW.project_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM projects p
               WHERE p.id = NEW.project_id AND p.status = 'OPEN'
             )
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident may only be associated with an open Project';
          END IF;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_project_close_active_incidents_bu")
    op.execute(
        """
        CREATE TRIGGER trg_project_close_active_incidents_bu
        BEFORE UPDATE ON projects
        FOR EACH ROW
        BEGIN
          IF NEW.status = 'CLOSED'
             AND OLD.status <> 'CLOSED'
             AND EXISTS (
               SELECT 1
               FROM incidents i
               WHERE i.project_id = OLD.id
                 AND i.status <> 'RESOLVED'
             )
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Project cannot close while active Incidents remain';
          END IF;
        END
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_project_close_active_incidents_bu")
    op.execute("DROP TRIGGER IF EXISTS trg_incident_project_open_bu")
    op.execute("DROP TRIGGER IF EXISTS trg_incident_project_open_bi")
