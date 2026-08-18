"""Capture coordinator approval actor for legacy triage transitions.

Revision ID: 20260818_event_group_approval_provenance
Revises: 20260818_event_group_provisional_cleanup
Create Date: 2026-08-18

Canonical coordinator approval writes approved_by_user_id directly. This trigger
also covers the established Assessment triage route: some triage dispositions
advance/resolve the Incident before triage_decided_by_user_id is written, so a
later update backfills the same coordinator actor without changing incident_key.
"""

from alembic import op

revision = "20260818_event_group_approval_provenance"
down_revision = "20260818_event_group_provisional_cleanup"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_incident_identity_bu")
    op.execute(
        """
        CREATE TRIGGER trg_incident_identity_bu
        BEFORE UPDATE ON incidents
        FOR EACH ROW
        BEGIN
          IF OLD.incident_key IS NOT NULL
             AND NOT (NEW.incident_key <=> OLD.incident_key)
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Permanent Incident key is immutable';
          END IF;

          IF OLD.current_stage = 'COORDINATOR_REVIEW'
             AND NEW.current_stage <> 'COORDINATOR_REVIEW'
             AND OLD.incident_key IS NULL
          THEN
            IF NEW.event_group_id IS NULL THEN
              SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Coordinator must determine the Event Group before approval';
            END IF;
            SET NEW.incident_key = UUID();
            SET NEW.approved_at = COALESCE(NEW.approved_at, NOW());
            SET NEW.approved_by_user_id = COALESCE(
              NEW.approved_by_user_id,
              NEW.triage_decided_by_user_id,
              NEW.resolved_by_user_id
            );
          END IF;

          # Assessment-required triage advances current_stage before the legacy
          # route writes triage_decided_by_user_id. Backfill actor on that second
          # update while preserving the already-minted immutable key.
          IF NEW.incident_key IS NOT NULL
             AND NEW.approved_by_user_id IS NULL
             AND NEW.triage_decided_by_user_id IS NOT NULL
          THEN
            SET NEW.approved_by_user_id = NEW.triage_decided_by_user_id;
          END IF;

          IF NEW.current_stage <> 'COORDINATOR_REVIEW'
             AND (NEW.event_group_id IS NULL OR NEW.incident_key IS NULL)
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident must be coordinator-approved and grouped before leaving coordinator review';
          END IF;

          IF NEW.incident_key IS NOT NULL AND NEW.approved_at IS NULL THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Permanent Incident identity requires approval provenance';
          END IF;

          IF NOT (NEW.incident_type <=> OLD.incident_type)
             AND NEW.incident_type IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM assessments a
               WHERE a.incident_id = NEW.id
                 AND a.state IN ('APPROVED', 'FINALIZED')
             )
          THEN
            SET NEW.incident_type = OLD.incident_type;
          END IF;
        END
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_incident_identity_bu")
    op.execute(
        """
        CREATE TRIGGER trg_incident_identity_bu
        BEFORE UPDATE ON incidents
        FOR EACH ROW
        BEGIN
          IF OLD.incident_key IS NOT NULL
             AND NOT (NEW.incident_key <=> OLD.incident_key)
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Permanent Incident key is immutable';
          END IF;

          IF OLD.current_stage = 'COORDINATOR_REVIEW'
             AND NEW.current_stage <> 'COORDINATOR_REVIEW'
             AND OLD.incident_key IS NULL
          THEN
            IF NEW.event_group_id IS NULL THEN
              SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Coordinator must determine the Event Group before approval';
            END IF;
            SET NEW.incident_key = UUID();
            SET NEW.approved_at = COALESCE(NEW.approved_at, NOW());
          END IF;

          IF NEW.current_stage <> 'COORDINATOR_REVIEW'
             AND (NEW.event_group_id IS NULL OR NEW.incident_key IS NULL)
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident must be coordinator-approved and grouped before leaving coordinator review';
          END IF;

          IF NEW.incident_key IS NOT NULL AND NEW.approved_at IS NULL THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Permanent Incident identity requires approval provenance';
          END IF;

          IF NOT (NEW.incident_type <=> OLD.incident_type)
             AND NEW.incident_type IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM assessments a
               WHERE a.incident_id = NEW.id
                 AND a.state IN ('APPROVED', 'FINALIZED')
             )
          THEN
            SET NEW.incident_type = OLD.incident_type;
          END IF;
        END
        """
    )
