"""Let a report closed at triage leave coordinator review without an Event Group.

Revision ID: 20260922_triage_close_ungrouped
Revises: 20260911_org_model
Create Date: 2026-09-22

An Event Group is one real-world site that GeoTech work is tracked against. The
coordinator now names one only when a report needs an assessment; a report
closed at triage — "no assessment required" or "duplicate or linked" — is not a
site anyone will work, and asking where it belongs was the step coordinators
had to answer before they could say it was nothing.

``trg_incident_identity_bu`` refused every exit from COORDINATOR_REVIEW without
an ``event_group_id``. It now lets exactly one kind of row through ungrouped: a
row that leaves coordinator review straight to RESOLVED with one of those two
closing dispositions. Everything else is unchanged — the key is still minted
with approval provenance, an assessment-bound report still has to be grouped,
and a closed row that is later moved to any other stage has to be grouped then.
"""

from alembic import op

revision = "20260922_triage_close_ungrouped"
down_revision = "20260911_org_model"
branch_labels = None
depends_on = None


def _trigger_sql(*, allow_closed_ungrouped: bool) -> str:
    # The one exemption, spelled once so the two checks below cannot disagree.
    closed_at_triage = (
        "(NEW.current_stage = 'RESOLVED' "
        "AND NEW.triage_disposition IN ('NO_ASSESSMENT_REQUIRED', 'DUPLICATE_OR_LINKED'))"
    )
    needs_group = f"NEW.event_group_id IS NULL AND NOT {closed_at_triage}" if allow_closed_ungrouped else "NEW.event_group_id IS NULL"
    return f"""
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
            IF {needs_group} THEN
              SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Coordinator must determine the Event Group before approval';
            END IF;
            SET NEW.incident_key = COALESCE(NEW.incident_key, UUID());
            SET NEW.approved_at = COALESCE(NEW.approved_at, NOW());
            SET NEW.approved_by_user_id = COALESCE(
              NEW.approved_by_user_id,
              NEW.triage_decided_by_user_id,
              NEW.resolved_by_user_id
            );
          END IF;

          /* Assessment-required triage advances current_stage before the legacy
             route writes triage_decided_by_user_id. Backfill actor on that
             second update while preserving the already-minted immutable key. */
          IF NEW.incident_key IS NOT NULL
             AND NEW.approved_by_user_id IS NULL
             AND NEW.triage_decided_by_user_id IS NOT NULL
          THEN
            SET NEW.approved_by_user_id = NEW.triage_decided_by_user_id;
          END IF;

          IF NEW.current_stage <> 'COORDINATOR_REVIEW'
             AND (({needs_group}) OR NEW.incident_key IS NULL)
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


def upgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_incident_identity_bu")
    op.execute(_trigger_sql(allow_closed_ungrouped=True))


def downgrade() -> None:
    # Restores 20260818_event_group_approval's trigger. A report already closed
    # ungrouped stays in the table, but the restored trigger refuses any later
    # UPDATE to it until it is put in an Event Group.
    op.execute("DROP TRIGGER IF EXISTS trg_incident_identity_bu")
    op.execute(_trigger_sql(allow_closed_ungrouped=False))
